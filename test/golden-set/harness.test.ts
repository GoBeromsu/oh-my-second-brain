import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapMeanCI,
  BOOST_ARM_IDS,
  calculateC040,
  canonicalQrels,
  latencyPercentiles,
  ndcgAt10,
  ndcgAtK,
  percentile,
  qrelsSha256,
  pairedBootstrapMeanCI,
  runHarness,
  validateQrels,
  validateScoredRows,
} from "./harness.js";
import {
  DEFAULT_REQUIRED_ARM_IDS,
  checkMeasurementManifest,
  validateNoDefaultWaiver,
  validateMeasurementManifest,
} from "../../scripts/check-measurement-manifest.mjs";
import { GOLDEN_QRELS, GOLDEN_QUERY_CLASSES } from "./queries.js";

const DIGEST = "a".repeat(64);

function validManifest(overrides: Record<string, unknown> = {}) {
  const ndcgByClass = Object.fromEntries([
    ["ko", { baseline: 0.5, current: 0.56 }],
    ["ko-inflected", { baseline: 0.5, current: 0.56 }],
    ["ko-verb-inflected", { baseline: 0.5, current: 0.56 }],
    ["다단어-AND-0hit", { baseline: 0.5, current: 0.56 }],
    ["en", { baseline: 0.5, current: 0.56 }],
    ["mixed", { baseline: 0.5, current: 0.56 }],
    ["phrase", { baseline: 0.5, current: 0.56 }],
    ["conceptual", { baseline: 0.5, current: 0.56 }],
    ["frontmatter-constrained", { baseline: 0.5, current: 0.56 }],
  ]);
  const arm = (
    armId: string,
    p95: number,
    side: "baseline" | "current",
    bootstrap: { ciLow: number; ciHigh: number },
  ) => ({
    armId,
    policy: armId,
    ndcgByClass: Object.fromEntries(
      Object.entries(ndcgByClass).map(([name, value]) => [name, value[side]]),
    ),
    p50: 12.4,
    p95,
    bootstrap,
    scoredRows: 28,
  });
  return {
    schemaVersion: 1,
    profile: "boost-c040",
    harnessCommit: "0123456789abcdef",
    qrelsHash: `sha256:${DIGEST}`,
    armIds: [...DEFAULT_REQUIRED_ARM_IDS],
    datasetId: "vault-redacted-r2",
    primaryClasses: [...GOLDEN_QUERY_CLASSES],
    ndcgByClass,
    p50: 12.4,
    p95: { baseline: 20, current: 24.1 },
    bootstrap: { seed: 42, samples: 1000, ciLow: 0.71, ciHigh: 0.84 },
    verdict: { pass: true, c040: true, winnerArmId: "boost-k-scale" },
    winnerArmId: "boost-k-scale",
    generatedAt: "2026-08-26T08:00:00.000Z",
    rawDigest: `sha256:${DIGEST}`,
    arms: {
      "boost-k-scale": arm("boost-k-scale", 24.1, "current", { ciLow: 0.01, ciHigh: 0.1 }),
      "boost-per-list": arm("boost-per-list", 24.1, "current", { ciLow: 0.01, ciHigh: 0.1 }),
      "boost-zero": arm("boost-zero", 20, "baseline", { ciLow: -0.1, ciHigh: 0 }),
    },
    ...overrides,
  };
}

function attestedManifest(overrides: Record<string, unknown> = {}) {
  const manifest = validManifest(overrides);
  const payload = {
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    datasetId: manifest.datasetId,
    qrelsHash: manifest.qrelsHash,
    armIds: manifest.armIds,
    arms: manifest.arms,
    rawDigest: manifest.rawDigest,
    verdict: manifest.verdict,
    generatedAt: manifest.generatedAt,
    winnerArmId: manifest.winnerArmId,
    harnessCommit: manifest.harnessCommit,
    primaryClasses: manifest.primaryClasses,
    ndcgByClass: manifest.ndcgByClass,
    p50: manifest.p50,
    p95: manifest.p95,
    bootstrap: manifest.bootstrap,
    metrics: manifest.metrics,
    pairedBootstrap: manifest.pairedBootstrap,
    rawEvidence: manifest.rawEvidence,
    queryIds: manifest.queryIds,
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    ...manifest,
    attestation: {
      signedBy: "measurement-owner",
      algorithm: "ed25519",
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      payloadDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64"),
    },
  };
}

/** Manifest shaped for a required boost-c040 run: paired raw evidence included. */
function pairedRequiredManifest(overrides: Record<string, unknown> = {}) {
  const arms = Object.fromEntries(Object.entries(validManifest().arms).map(([armId, arm]) => [
    armId,
    { ...arm, outputDigest: `sha256:${"b".repeat(64)}` },
  ]));
  const rows = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`query-${index}`, 0.5]));
  const rawEvidence = {
    kind: "paired-production-seam-v1",
    paired: true,
    arms: Object.fromEntries(Object.keys(arms).map((armId) => [armId, {
      outputDigest: `sha256:${"b".repeat(64)}`,
      scoredRows: 28,
      ndcgByQuery: rows,
    }])),
  };
  const rawDigest = `sha256:${createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex")}`;
  return validManifest({ arms, rawEvidence, rawDigest, ...overrides });
}

/** Repository stub whose dispatcher declares a specific shipped ranking default. */
function stubRepoWithPolicy(policy: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "oms-ranking-stub-"));
  const dispatcherDir = path.join(root, "src", "kernel", "engine", "retrieval");
  mkdirSync(dispatcherDir, { recursive: true });
  writeFileSync(
    path.join(dispatcherDir, "dispatcher.ts"),
    `export const DEFAULT_DISPATCHER_POLICY: DispatcherPolicy = "${policy}";\n`,
    "utf8",
  );
  return root;
}

describe("R2 golden harness measurement core", () => {
  it("computes nDCG@10 with graded relevance and returns one for ideal order", () => {
    const qrels = { "high.md": 3, "medium.md": 2, "low.md": 1 };
    expect(ndcgAt10(["high.md", "medium.md", "low.md"], qrels)).toBe(1);
    expect(ndcgAtK(["low.md", "medium.md", "high.md"], qrels, 2)).toBeLessThan(1);
    expect(ndcgAt10([
      { docPath: "low.md", score: 1 },
      { docPath: "high.md", score: 1 },
    ], qrels)).toBeCloseTo(ndcgAt10([
      { docPath: "high.md", score: 1 },
      { docPath: "low.md", score: 1 },
    ], qrels));
  });

  it("handles empty results, missing qrels, and duplicate ranked documents", () => {
    const qrels = { "answer.md": 1 };
    expect(ndcgAt10([], qrels)).toBe(0);
    expect(ndcgAt10(["unrelated.md"], qrels)).toBe(0);
    expect(ndcgAt10(["answer.md", "answer.md"], qrels)).toBe(1);
    expect(ndcgAt10(["answer.md"], {})).toBe(0);
    expect(ndcgAt10(["answer.md"], new Map([["answer.md", 1]]))).toBe(1);
    expect(ndcgAt10(["answer.md"], [{ docPath: "answer.md", relevance: 1 }])).toBe(1);
  });

  it("produces deterministic seeded bootstrap intervals", () => {
    const first = bootstrapMeanCI([0.2, 0.5, 0.8, 1], { seed: 7, samples: 300 });
    const second = bootstrapMeanCI([0.2, 0.5, 0.8, 1], { seed: 7, samples: 300 });
    const changed = bootstrapMeanCI([0.2, 0.5, 0.8, 1], { seed: 8, samples: 300 });
    expect(second).toEqual(first);
    expect(changed).not.toEqual(first);
    expect(first.estimate).toBeCloseTo(0.625);
    expect(first.ciLow).toBeLessThanOrEqual(first.estimate);
    expect(first.ciHigh).toBeGreaterThanOrEqual(first.estimate);
  });

  it("computes p50 and p95 with interpolation", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(latencyPercentiles([1, 2, 3, 4])).toEqual({ p50: 2.5, p95: expect.closeTo(3.85, 10) });
  });

  it("rejects empty scored rows and duplicate/missing-qrel rows", () => {
    const qrels = { q1: { "answer.md": 1 } };
    expect(validateScoredRows([], qrels).valid).toBe(false);
    expect(validateScoredRows([
      { id: "q1", skipped: false, engineTop10: ["answer.md"] },
      { id: "q1", skipped: false, engineTop10: ["answer.md", "answer.md"] },
    ], qrels)).toMatchObject({ valid: false, scored: 2 });
  });

  it("hashes qrels independent of object insertion order", () => {
    expect(qrelsSha256({ q1: { b: 1, a: 2 }, q2: { c: 1 } }))
      .toBe(qrelsSha256({ q2: { c: 1 }, q1: { a: 2, b: 1 } }));
    expect(canonicalQrels([
      { queryId: "q2", docPath: "c", relevance: 1 },
      { queryId: "q1", docPath: "b", relevance: 1 },
    ])).toBe(canonicalQrels({ q1: { b: 1 }, q2: { c: 1 } }));
    expect(() => validateQrels([
      { queryId: "q1", docPath: "a", relevance: 1 },
      { queryId: "q1", docPath: "a", relevance: 1 },
    ])).toThrow(/duplicate/);
    expect(qrelsSha256(GOLDEN_QRELS))
      .toBe("b13ac9653fdbec762c5db46ea10fe58c521da55a0144b8c36e1bc5fa12f7da28");
  });

  it("rejects malformed measurement-manifest fixtures fail-closed", () => {
    expect(() => validateMeasurementManifest(validManifest({ schemaVersion: 2 }))).toThrow();
    expect(() => validateMeasurementManifest(validManifest({ qrelsHash: "not-a-digest" }))).toThrow();
    expect(() => validateMeasurementManifest(validManifest({ armIds: [...DEFAULT_REQUIRED_ARM_IDS, "late-arm"] }))).toThrow();
    expect(() => validateMeasurementManifest(validManifest({ verdict: { pass: false } }))).toThrow();
    expect(() => validateMeasurementManifest(validManifest(), { expectedQrelsHash: "b".repeat(64) })).toThrow(/qrels hash mismatch/);
  });

  it("calculates C040 from measured deltas instead of trusting verdict", () => {
    const failed = validManifest({
      ndcgByClass: {
        ...validManifest().ndcgByClass,
        en: { baseline: 0.5, current: 0.51 },
        mixed: { baseline: 0.5, current: 0.5 },
      },
      verdict: { pass: true, c040: true, winnerArmId: "boost-k-scale" },
    });
    expect(() => validateMeasurementManifest(failed)).toThrow(/C040/);
    const checked = validateMeasurementManifest(validManifest());
    expect(checked.c040.pass).toBe(true);
    expect(checked.c040.primary).toBe(true);
  });

  it("requires a manifest when the required sentinel is enabled and the ranking default changed", () => {
    // The gate is scoped to releases that actually change the shipped ranking
    // default, so the missing-manifest failure is proven against a repository
    // whose dispatcher ships a preregistered experiment arm instead of the
    // released baseline.
    const stubRoot = stubRepoWithPolicy("boost-k-scale");
    try {
      expect(() =>
        checkMeasurementManifest({ required: true, manifestPath: undefined, repoRoot: stubRoot }),
      ).toThrow(/required/);
    } finally {
      rmSync(stubRoot, { recursive: true, force: true });
    }
  });

  it("binds the shipped ranking default to the measured winning arm", () => {
    // Authentic evidence for one arm must not authorise shipping a different
    // one, otherwise the gate certifies provenance without certifying the
    // decision it is supposed to gate.
    const stubRoot = stubRepoWithPolicy("boost-per-list");
    const manifestPath = path.join(stubRoot, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(pairedRequiredManifest()), "utf8");
    try {
      expect(() => checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        manifestPath,
        repoRoot: stubRoot,
        expectedQrelsHash: DIGEST,
      })).toThrow(/does not match the measured winning arm/);
    } finally {
      rmSync(stubRoot, { recursive: true, force: true });
    }
  });

  it("accepts a non-baseline default that is exactly the measured winning arm", () => {
    const stubRoot = stubRepoWithPolicy("boost-k-scale");
    const manifestPath = path.join(stubRoot, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(pairedRequiredManifest()), "utf8");
    try {
      const checked = checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        manifestPath,
        repoRoot: stubRoot,
        expectedQrelsHash: DIGEST,
      });
      expect(checked).toMatchObject({ present: true, shippedRankingPolicy: "boost-k-scale" });
    } finally {
      rmSync(stubRoot, { recursive: true, force: true });
    }
  });

  it("rejects a shipped ranking default that is not a preregistered arm", () => {
    const stubRoot = stubRepoWithPolicy("boost-mystery");
    const manifestPath = path.join(stubRoot, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(pairedRequiredManifest()), "utf8");
    try {
      expect(() => checkMeasurementManifest({
        required: true,
        profile: "boost-c040",
        manifestPath,
        repoRoot: stubRoot,
        expectedQrelsHash: DIGEST,
      })).toThrow(/neither the released baseline .* nor a preregistered arm/);
    } finally {
      rmSync(stubRoot, { recursive: true, force: true });
    }
  });

  it("requires a signed, immutable attestation when attestation is required", () => {
    expect(() => validateMeasurementManifest(validManifest(), { requireAttestation: true }))
      .toThrow(/attestation is required/);
    const signed = attestedManifest();
    expect(validateMeasurementManifest(signed, {
      requireAttestation: true,
      trustedAttestationPublicKey: signed.attestation.publicKey,
    }).attestation)
      .toMatchObject({ algorithm: "ed25519", signedBy: "measurement-owner" });
    const tampered = attestedManifest();
    tampered.datasetId = "different-vault";
    expect(() => validateMeasurementManifest(tampered, {
      requireAttestation: true,
      trustedAttestationPublicKey: tampered.attestation.publicKey,
    }))
      .toThrow(/payloadDigest|signature/);
  });

  it("signs every C040 decision input, including paired metrics and bootstrap", () => {
    const trusted = attestedManifest();
    const tamperedBootstrap = {
      ...trusted,
      bootstrap: { ...trusted.bootstrap, ciHigh: 0.99 },
    };
    expect(() => validateMeasurementManifest(tamperedBootstrap, {
      requireAttestation: true,
      trustedAttestationPublicKey: trusted.attestation.publicKey,
    })).toThrow(/payloadDigest|signature/);

    const tamperedMetric = attestedManifest();
    tamperedMetric.p50 = 99;
    expect(() => validateMeasurementManifest(tamperedMetric, {
      requireAttestation: true,
      trustedAttestationPublicKey: tamperedMetric.attestation.publicKey,
    })).toThrow(/payloadDigest|signature/);
  });

  it("signs paired raw evidence rather than only its digest", () => {
    const arms = Object.fromEntries(Object.entries(validManifest().arms).map(([armId, arm]) => [
      armId,
      { ...arm, outputDigest: `sha256:${"b".repeat(64)}` },
    ]));
    const rows = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`query-${index}`, 0.5]));
    const rawEvidence = {
      kind: "paired-production-seam-v1",
      paired: true,
      arms: Object.fromEntries(Object.keys(arms).map((armId) => [armId, {
        outputDigest: `sha256:${"b".repeat(64)}`,
        scoredRows: 28,
        ndcgByQuery: rows,
      }])),
    };
    const rawDigest = `sha256:${createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex")}`;
    const signed = attestedManifest({ arms, rawEvidence, rawDigest });
    const tamperedEvidence = signed.rawEvidence as {
      arms: Record<string, { ndcgByQuery: Record<string, number> }>;
    };
    tamperedEvidence.arms["boost-zero"].ndcgByQuery["query-0"] = 0.75;
    signed.rawDigest = `sha256:${createHash("sha256").update(JSON.stringify(signed.rawEvidence)).digest("hex")}`;
    expect(() => validateMeasurementManifest(signed, {
      requireAttestation: true,
      trustedAttestationPublicKey: signed.attestation.publicKey,
    })).toThrow(/payloadDigest|signature/);
  });

  it("requires an external preregistered qrels digest for required boost-c040", () => {
    expect(() => validateMeasurementManifest(validManifest(), { required: true }))
      .toThrow(/external preregistered qrels digest/);
    expect(() => validateMeasurementManifest(validManifest(), {
      required: true,
      qrels: { query: { "note.md": 1 } },
    })).toThrow(/external preregistered qrels digest/);
  });

  it("rejects synthetic fixture datasets in the release profile", () => {
    const fixture = attestedManifest();
    const trustedAttestationPublicKey = fixture.attestation.publicKey;
    expect(() => validateMeasurementManifest(fixture, {
      release: true,
      requireAttestation: true,
      trustedAttestationPublicKey,
    })).toThrow(/real vault, not a fixture dataset/);
    const ownerManifest = attestedManifest({ datasetId: "owner-vault-2026-08" });
    expect(validateMeasurementManifest(ownerManifest, {
      release: true,
      requireAttestation: true,
      trustedAttestationPublicKey: ownerManifest.attestation.publicKey,
    }).profile).toBe("boost-c040");
  });

  it("binds required paired raw evidence to each measured arm", () => {
    const manifest = validManifest();
    const arms = Object.fromEntries(Object.entries(manifest.arms).map(([armId, arm]) => [
      armId,
      { ...arm, outputDigest: `sha256:${"b".repeat(64)}` },
    ]));
    const rows = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`query-${index}`, 0.5]));
    const rawEvidence = {
      kind: "paired-production-seam-v1",
      paired: true,
      arms: Object.fromEntries(Object.keys(arms).map((armId) => [armId, {
        outputDigest: `sha256:${"b".repeat(64)}`,
        scoredRows: 28,
        ndcgByQuery: rows,
      }])),
    };
    const rawDigest = `sha256:${createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex")}`;
    expect(validateMeasurementManifest(
      validManifest({ arms, rawEvidence, rawDigest }),
      { required: true, expectedQrelsHash: DIGEST },
    ).rawDigest).toBe(rawDigest);
    expect(() => validateMeasurementManifest(
      validManifest({ arms, rawEvidence, rawDigest: `sha256:${"c".repeat(64)}` }),
      { required: true, expectedQrelsHash: DIGEST },
    )).toThrow(/rawDigest does not match/);
  });

  it("never fabricates real-vault qrels from an injected query label file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oms-golden-labels-"));
    const queryPath = path.join(dir, "queries.json");
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `external-${index}`,
      type: "lex",
      query: `external query ${index}`,
      expectedNotes: ["fabricated.md"],
      curated: true,
      queryClass: GOLDEN_QUERY_CLASSES[index % GOLDEN_QUERY_CLASSES.length],
    }));
    const previousQueries = process.env.OMS_GOLDEN_QUERIES;
    const previousQrels = process.env.OMS_GOLDEN_QRELS;
    process.env.OMS_GOLDEN_QUERIES = queryPath;
    delete process.env.OMS_GOLDEN_QRELS;
    writeFileSync(queryPath, JSON.stringify(rows));
    try {
      await expect(runHarness({ files: [] })).rejects.toThrow(/OMS_GOLDEN_QRELS is required/);
    } finally {
      if (previousQueries === undefined) delete process.env.OMS_GOLDEN_QUERIES;
      else process.env.OMS_GOLDEN_QUERIES = previousQueries;
      if (previousQrels === undefined) delete process.env.OMS_GOLDEN_QRELS;
      else process.env.OMS_GOLDEN_QRELS = previousQrels;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a preregistered digest before scoring caller-supplied qrels", async () => {
    await expect(runHarness({ qrels: GOLDEN_QRELS })).rejects.toThrow(/preregistered qrels hash/);
    const report = await runHarness({
      qrels: GOLDEN_QRELS,
      qrelsHash: qrelsSha256(GOLDEN_QRELS),
    });
    expect(report.qrelsHash).toBe(qrelsSha256(GOLDEN_QRELS));
  });

  it("refuses a shape-valid no-default waiver with an invalid runtime contract", () => {
    // A well-formed waiver record is not sufficient. E-1 Rule 1 also requires
    // machine-verified runtime behaviour, so an accepted waiver without the
    // contract hooks must fail closed rather than pass on paperwork alone.
    // The production positive path lives in test/measurement-gate.test.ts.
    expect(() => checkMeasurementManifest({
      required: true,
      profile: "model-default",
      manifestPath: undefined,
      waiver: {
        profile: "model-default",
        noDefault: true,
        reason: "measurement host unavailable",
        approvedBy: "release-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      noDefaultContract: {},
    })).toThrow(/no-default assertion failed/);
  });

  it("cross-checks C040 pairs against baseline and candidate arm evidence", () => {
    const manifest = validManifest();
    const arms = manifest.arms as Record<string, Record<string, unknown>>;
    arms["boost-zero"] = {
      ...arms["boost-zero"],
      p95: 25,
    };
    expect(() => validateMeasurementManifest(manifest)).toThrow(/arm mismatch for p95/);
  });

  it("uses paired top-level bootstrap evidence instead of independent arm intervals", () => {
    const manifest = validManifest();
    const arms = manifest.arms as Record<string, Record<string, unknown>>;
    arms["boost-zero"] = {
      ...arms["boost-zero"],
      bootstrap: { ciLow: -0.5, ciHigh: 0.5 },
    };
    arms["boost-k-scale"] = {
      ...arms["boost-k-scale"],
      bootstrap: { ciLow: -0.25, ciHigh: 0.25 },
    };
    expect(validateMeasurementManifest(manifest).c040.pass).toBe(true);
  });

  it("rejects an arm whose recorded policy does not match its preregistered id", () => {
    const manifest = validManifest();
    const arms = manifest.arms as Record<string, Record<string, unknown>>;
    arms["boost-per-list"] = { ...arms["boost-per-list"], policy: "boost-zero" };
    expect(() => validateMeasurementManifest(manifest)).toThrow(/policy mismatch/);
  });

  it("requires model-default evidence for the model-default profile", () => {
    expect(() => validateMeasurementManifest(validManifest({
      profile: "model-default",
      modelDefault: undefined,
    }))).toThrow(/modelDefault evidence/);
    const checked = validateMeasurementManifest(validManifest({
      profile: "model-default",
      modelDefault: {
        provider: "gguf",
        model: "bge-m3",
        source: "installed-default",
        sha256: DIGEST,
      },
    }));
    expect(checked.modelDefault.sha256).toBe(`sha256:${DIGEST}`);
    const minimal = validateMeasurementManifest({
      schemaVersion: 1,
      profile: "model-default",
      harnessCommit: "0123456789abcdef",
      modelDefault: {
        provider: "gguf",
        model: "bge-m3",
        source: "setup",
        sha256: DIGEST,
      },
    });
    expect(minimal.profile).toBe("model-default");
    expect(minimal.modelDefault.provider).toBe("gguf");
  });

  it("does not let a boost-c040 waiver bypass model-default evidence", () => {
    expect(() => checkMeasurementManifest({
      required: true,
      profile: "model-default",
      manifestPath: undefined,
      waiver: {
        profile: "boost-c040",
        noDefault: true,
        reason: "measurement host unavailable",
        approvedBy: "release-owner",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    })).toThrow(/profile mismatch|boost-c040 is never waivable/);
  });

  it("requires an explicit E-1 no-default waiver marker", () => {
    const waiver = {
      profile: "model-default",
      reason: "measurement host unavailable",
      approvedBy: "release-owner",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(() => validateNoDefaultWaiver(waiver, "model-default"))
      .toThrow(/noDefault must be true/);
    expect(() => validateNoDefaultWaiver({ ...waiver, noDefault: true }, "boost-c040"))
      .toThrow(/boost-c040 is never waivable/);
  });

  it("honors a selected file slice and explicit database path on the production seam", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oms-golden-inputs-"));
    const dbPath = path.join(dir, "measurement.sqlite");
    try {
      const report = await runHarness({
        files: ["notes/idea.md"],
        dbPath,
        configOverrides: { embeddingDimensions: 384 },
      });
      expect(existsSync(dbPath)).toBe(true);
      for (const row of report.queries) {
        expect(row.engineTop10.every((docPath) => docPath === "notes/idea.md")).toBe(true);
      }
      expect(report.overallPass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors configOverrides.files and configOverrides.dbPath", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oms-golden-config-"));
    const dbPath = path.join(dir, "override.sqlite");
    try {
      const report = await runHarness({
        configOverrides: {
          files: ["references/clean-architecture.md"],
          dbPath,
        },
      });
      expect(existsSync(dbPath)).toBe(true);
      expect(report.queries.every((row) =>
        row.engineTop10.every((docPath) => docPath === "references/clean-architecture.md"),
      )).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects arm evidence that is not exactly the nine preregistered classes", () => {
    const arms = Object.fromEntries(BOOST_ARM_IDS.map((armId) => [
      armId,
      {
        armId,
        policy: armId,
        ndcgByClass: Object.fromEntries(
          GOLDEN_QUERY_CLASSES.map((queryClass) => [queryClass, 0]),
        ),
        p95: 1,
        bootstrap: { ciLow: 0, ciHigh: 0 },
        ndcgByQuery: { q1: 0 },
      },
    ]));
    delete arms["boost-zero"].ndcgByClass["en"];
    expect(() => calculateC040(arms as never)).toThrow(/nine preregistered classes/);
  });

  it("keeps ranked arm evidence deterministic for equivalent file selections", async () => {
    const first = await runHarness({
      files: ["references/clean-architecture.md", "notes/idea.md"],
      bootstrap: { seed: 17, samples: 100 },
    });
    const second = await runHarness({
      files: ["notes/idea.md", "references/clean-architecture.md"],
      bootstrap: { seed: 17, samples: 100 },
    });
    expect(second.queries.map((row) => [row.id, row.engineTop10, row.error]))
      .toEqual(first.queries.map((row) => [row.id, row.engineTop10, row.error]));
    for (const armId of BOOST_ARM_IDS) {
      expect(second.arms[armId].outputDigest).toBe(first.arms[armId].outputDigest);
      expect(second.arms[armId].ndcgByQuery).toEqual(first.arms[armId].ndcgByQuery);
    }
  }, 30_000);

  it("executes each declared modality and records distinct production arm outputs", async () => {
    const report = await runHarness();
    const digests = BOOST_ARM_IDS.map((armId) => report.arms[armId].outputDigest);
    expect(new Set(digests).size).toBeGreaterThan(1);
    expect(report.queries.find((row) => row.type === "lex")?.error).toBeUndefined();
    expect(report.queries.find((row) => row.type === "vec")?.error).toMatch(/unavailable/);
    expect(report.queries.find((row) => row.type === "hyde")?.error).toMatch(/unavailable/);
    expect(report.queries.find((row) => row.type === "graph")?.error).toMatch(/graph traversal/);
    const paired = pairedBootstrapMeanCI(
      report.arms["boost-k-scale"],
      report.arms["boost-zero"],
    );
    expect(report.pairedBootstrap).toEqual(paired);
    expect(report.bootstrap).toEqual(paired);
  });
});
