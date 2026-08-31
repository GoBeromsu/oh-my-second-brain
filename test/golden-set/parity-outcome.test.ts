import { describe, expect, it } from "vitest";
import {
  AGGREGATE_FLOORS,
  MODALITY_FLOORS,
  OPERABILITY_LIMITS,
  type OperabilityInput,
  type ParityMetric,
  type ParityRelevanceInput,
  type ParityScopeMeasurement,
} from "./parity-gate.js";
import {
  PINNED_QMD_COMMIT,
  PINNED_QMD_REPO,
  PINNED_QMD_VERSION,
  type ParityPreregistration,
  type ParityProfile,
} from "./parity-preregistration.js";
import {
  assertReleasePermitted,
  assertReplacementClaimPermitted,
} from "./parity-stop-policy.js";
import {
  evaluateAuditedParityOutcome,
  expectedModalitiesForProfile,
  serializeAuditedParityOutcome,
  type AuditedParityOutcome,
} from "./parity-outcome.js";

const D = {
  corpus: "a".repeat(64),
  queries: "b".repeat(64),
  qrels: "c".repeat(64),
  raw: "d".repeat(64),
} as const;

function preregistration(profile: ParityProfile): ParityPreregistration {
  return {
    schemaVersion: 1,
    profile,
    baselineRepo: PINNED_QMD_REPO,
    baselineCommit: PINNED_QMD_COMMIT,
    baselineVersion: PINNED_QMD_VERSION,
    corpusDigest: D.corpus,
    corpusFileCount: 20_959,
    queriesSha256: D.queries,
    qrelsSha256: D.qrels,
    queryCount: 12,
    settings: {
      candidateLimit: 50,
      k: 10,
      rrfK: 60,
      rerank: profile === "b2-parity",
      expansion: profile === "b2-parity",
      embedModel: "qwen3-embedding-0.6b-q8_0",
      embedRevision: "immutable-revision",
      embedSha256: "e".repeat(64),
      embedPromptScheme: "qwen3-embedding-v1",
      qmdEmbedUri: "hf:example/qwen.gguf",
      ...(profile === "b1-foundation" ? {} : {
        rerankModel: "qwen3-reranker",
        rerankRevision: "rerank-revision",
        rerankSha256: "1".repeat(64),
        qmdRerankUri: "hf:example/rerank.gguf",
        generateModel: "qmd-query-expansion",
        generateRevision: "generate-revision",
        generateSha256: "2".repeat(64),
        generatePromptScheme: "qmd-query-expansion-v2.8.3",
        qmdGenerateUri: "hf:example/generate.gguf",
      }),
    },
    hardware: "Apple M1 Pro, 16 GiB",
    seed: 20260830,
  };
}

function scope(
  values: Readonly<Record<ParityMetric, number>>,
): ParityScopeMeasurement {
  return {
    scoredRows: 6,
    curatedRows: 6,
    languageStrata: ["ko", "en-or-mixed"],
    oms: values,
    qmd: values,
  };
}

function relevance(profile: ParityProfile): ParityRelevanceInput {
  const modalities = expectedModalitiesForProfile(profile);
  return {
    expectedModalities: modalities,
    modalities: Object.fromEntries(modalities.map((modality) => [modality, scope(MODALITY_FLOORS)])),
    aggregate: scope(AGGREGATE_FLOORS),
  };
}

function operability(overrides: Partial<OperabilityInput> = {}): OperabilityInput {
  return {
    exitCode: 0,
    scanned: 12,
    indexed: 12,
    skipped: 0,
    errors: 0,
    vectorCount: 24,
    expectedVectorCount: 24,
    peakRssBytes: 4 * 1024 * 1024 * 1024,
    embedWallMs: 60_000,
    plainQueryP95Ms: 100,
    precisionQueryP95Ms: 15_000,
    ...overrides,
  };
}

function evidence() {
  return {
    corpusDigest: D.corpus,
    queriesSha256: D.queries,
    qrelsSha256: D.qrels,
    rawResultsDigest: D.raw,
    baselineCommit: PINNED_QMD_COMMIT,
    queryCount: 12,
    corpusFileCount: 20_959,
    embedModel: "qwen3-embedding-0.6b-q8_0",
    embedRevision: "immutable-revision",
    embedSha256: "e".repeat(64),
    embedPromptScheme: "qwen3-embedding-v1",
    qmdEmbedUri: "hf:example/qwen.gguf",
    rerankModel: "qwen3-reranker",
    rerankRevision: "rerank-revision",
    rerankSha256: "1".repeat(64),
    qmdRerankUri: "hf:example/rerank.gguf",
    generateModel: "qmd-query-expansion",
    generateRevision: "generate-revision",
    generateSha256: "2".repeat(64),
    generatePromptScheme: "qmd-query-expansion-v2.8.3",
    qmdGenerateUri: "hf:example/generate.gguf",
  };
}

function passingB1(): AuditedParityOutcome {
  return evaluateAuditedParityOutcome({
    preregistration: preregistration("b1-foundation"),
    observedEvidence: evidence(),
    relevance: relevance("b1-foundation"),
    operability: operability(),
    env: {},
  });
}

describe("evaluateAuditedParityOutcome", () => {
  it("feeds admissibility, relevance, operability, and stop policy into one B1 record", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: evidence(),
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: {},
    });

    expect(record).toMatchObject({
      schema: "oms.audited-parity-outcome.v1",
      admissible: true,
      gate: { passed: true, relevance: { passed: true }, operability: { passed: true } },
      outcome: {
        passed: true,
        mayStartB2: true,
        mayRelease: true,
        mayClaimReplacement: false,
      },
    });
    expect(() => assertReleasePermitted(record.outcome)).not.toThrow();
    expect(() => assertReplacementClaimPermitted(record.outcome)).toThrow(/b2-parity/);
  });

  it("makes observed digest drift inadmissible and never scores relevance", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: { ...evidence(), corpusDigest: "e".repeat(64) },
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: {},
    });

    expect(record.admissible).toBe(false);
    expect(record.admissibilityFailures).toEqual([
      expect.stringMatching(/corpusDigest drifted/),
    ]);
    expect(record.gate.relevance).toEqual({
      passed: false,
      failures: ["relevance was not scored because the run is inadmissible"],
    });
    expect(record.outcome.requiredFollowUp).toMatch(/do not loosen any frozen threshold/);
    expect(() => assertReleasePermitted(record.outcome)).toThrow(/release is blocked/);
  });

  it("feeds measured precision p95 into the gate instead of dropping it", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: evidence(),
      relevance: relevance("b1-foundation"),
      operability: operability({
        precisionQueryP95Ms: OPERABILITY_LIMITS.maxPrecisionQueryP95Ms + 1,
      }),
      env: {},
    });

    expect(record.admissible).toBe(true);
    expect(record.gate.operability.passed).toBe(false);
    expect(record.gate.operability.failures).toEqual([
      expect.stringMatching(/precision query p95/),
    ]);
    expect(record.outcome.mayRelease).toBe(false);
  });

  it("blocks B2 without a preserved passing B1 admission outcome", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b2-parity"),
      observedEvidence: evidence(),
      relevance: relevance("b2-parity"),
      operability: operability(),
      env: {},
    });

    expect(record.admissible).toBe(false);
    expect(record.admissibilityFailures).toEqual([
      expect.stringMatching(/requires a preserved complete audited b1-foundation record/),
    ]);
    expect(record.outcome.mayClaimReplacement).toBe(false);
  });

  it("permits a replacement claim only for passing B2 after passing B1", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b2-parity"),
      observedEvidence: evidence(),
      relevance: relevance("b2-parity"),
      operability: operability(),
      env: {},
      priorB1Record: passingB1(),
    });

    expect(record.admissible).toBe(true);
    expect(record.outcome).toMatchObject({
      passed: true,
      mayRelease: true,
      mayClaimReplacement: true,
    });
    expect(() => assertReplacementClaimPermitted(record.outcome)).not.toThrow();
  });

  it("rejects a B1 record whose inner gate no longer proves the preserved pass", () => {
    const prior = passingB1();
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b2-parity"),
      observedEvidence: evidence(),
      relevance: relevance("b2-parity"),
      operability: operability(),
      env: {},
      priorB1Record: {
        ...prior,
        gate: {
          ...prior.gate,
          relevance: { passed: false, failures: ["tampered"] },
        },
      },
    });

    expect(record.admissible).toBe(false);
    expect(record.admissibilityFailures.join("\n")).toMatch(/complete audited b1-foundation/);
  });

  it("rejects B2 when its frozen corpus differs from the preserved B1 run", () => {
    const changedCorpus = "f".repeat(64);
    const record = evaluateAuditedParityOutcome({
      preregistration: {
        ...preregistration("b2-parity"),
        corpusDigest: changedCorpus,
      },
      observedEvidence: {
        ...evidence(),
        corpusDigest: changedCorpus,
      },
      relevance: relevance("b2-parity"),
      operability: operability(),
      env: {},
      priorB1Record: passingB1(),
    });

    expect(record.admissibilityFailures.join("\n")).toMatch(/exact common frozen evidence/);
    expect(record.outcome.passed).toBe(false);
  });

  it("turns a forbidden threshold override into preserved inadmissibility", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: evidence(),
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: { OMS_GOLDEN_MIN_RECALL: "0.01" },
    });

    expect(record.admissible).toBe(false);
    expect(record.admissibilityFailures).toEqual([
      expect.stringMatching(/thresholds are frozen/),
    ]);
  });

  it("serializes every preregistered digest, measurement, gate, and stop decision", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: evidence(),
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: {},
    });
    const serialized = serializeAuditedParityOutcome(record);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(serialized.endsWith("\n")).toBe(true);
    expect(parsed).toMatchObject({
      schema: "oms.audited-parity-outcome.v1",
      admissible: true,
      preregistration: {
        corpusDigest: D.corpus,
        queriesSha256: D.queries,
        qrelsSha256: D.qrels,
      },
      observedEvidence: evidence(),
      operabilityMeasurement: { precisionQueryP95Ms: 15_000 },
      gate: { passed: true },
      outcome: { schema: "oms.parity-outcome.v1", mayRelease: true },
    });
  });

  it("makes post-run model identity drift inadmissible", () => {
    const record = evaluateAuditedParityOutcome({
      preregistration: preregistration("b1-foundation"),
      observedEvidence: { ...evidence(), embedSha256: "f".repeat(64) },
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: {},
    });

    expect(record.admissibilityFailures).toEqual([
      expect.stringMatching(/embedSha256 drifted/),
    ]);
    expect(record.outcome.passed).toBe(false);
  });

  it("serializes identically when parsed preregistration key order differs", () => {
    const canonical = preregistration("b1-foundation");
    const reordered = {
      ...Object.fromEntries(Object.entries(canonical).reverse()),
      settings: Object.fromEntries(Object.entries(canonical.settings).reverse()),
    } as unknown as ParityPreregistration;
    const base = {
      observedEvidence: evidence(),
      relevance: relevance("b1-foundation"),
      operability: operability(),
      env: {},
    } as const;

    const first = evaluateAuditedParityOutcome({ ...base, preregistration: canonical });
    const second = evaluateAuditedParityOutcome({ ...base, preregistration: reordered });

    expect(serializeAuditedParityOutcome(second)).toBe(serializeAuditedParityOutcome(first));
  });
});
