import { describe, expect, it } from "vitest";
import {
  assertReleasePermitted,
  assertReplacementClaimPermitted,
  decideStopPolicy,
  serializeOutcome,
  type ParityEvidenceRefs,
} from "./parity-stop-policy.js";
import {
  AGGREGATE_FLOORS,
  evaluateParityGate,
  MODALITY_FLOORS,
  type OperabilityInput,
  type ParityMetric,
  type ParityModality,
  type ParityRelevanceInput,
  type ParityScopeMeasurement,
} from "./parity-gate.js";
import { PINNED_QMD_COMMIT, type ParityProfile } from "./parity-preregistration.js";

const EVIDENCE: ParityEvidenceRefs = {
  corpusDigest: "a".repeat(64),
  queriesSha256: "b".repeat(64),
  qrelsSha256: "c".repeat(64),
  rawResultsDigest: "d".repeat(64),
  baselineCommit: PINNED_QMD_COMMIT,
};

function metrics(
  floors: Readonly<Record<ParityMetric, number>>,
  bump: number,
): Record<ParityMetric, number> {
  return {
    recallAt10: floors.recallAt10 + bump,
    ndcgAt10: floors.ndcgAt10 + bump,
    mrrAt10: floors.mrrAt10 + bump,
  };
}

function scope(
  floors: Readonly<Record<ParityMetric, number>>,
  bump = 0.05,
): ParityScopeMeasurement {
  const oms = metrics(floors, bump);
  return {
    scoredRows: 7,
    curatedRows: 7,
    languageStrata: ["ko", "en-or-mixed"],
    oms,
    qmd: { ...oms },
  };
}

/** A run that clears every frozen bound, for the profile's declared modalities. */
function passingRelevance(modalities: readonly ParityModality[]): ParityRelevanceInput {
  return {
    expectedModalities: modalities,
    modalities: Object.fromEntries(modalities.map((m) => [m, scope(MODALITY_FLOORS)])),
    aggregate: scope(AGGREGATE_FLOORS),
  };
}

/**
 * The synthetic below-threshold arm AC-24 requires.
 *
 * Deliberately built by driving the real gate rather than hand-writing a failing
 * verdict: a fabricated verdict would prove only that the policy reads a boolean,
 * not that a genuinely poor run is actually caught.
 */
function failingRelevance(modalities: readonly ParityModality[]): ParityRelevanceInput {
  const base = passingRelevance(modalities);
  const first = modalities[0]!;
  const sunk = { recallAt10: 0.31, ndcgAt10: 0.22, mrrAt10: 0.18 };
  return {
    ...base,
    modalities: {
      ...base.modalities,
      [first]: { ...scope(MODALITY_FLOORS), oms: sunk, qmd: { ...metrics(MODALITY_FLOORS, 0.05) } },
    },
  };
}

function operability(overrides: Partial<OperabilityInput> = {}): OperabilityInput {
  return {
    exitCode: 0,
    scanned: 21_045,
    indexed: 20_900,
    skipped: 145,
    errors: 0,
    vectorCount: 48_000,
    expectedVectorCount: 48_000,
    peakRssBytes: 3 * 1024 * 1024 * 1024,
    embedWallMs: 90 * 60 * 1000,
    plainQueryP95Ms: 1_100,
    ...overrides,
  };
}

function outcomeFor(
  profile: ParityProfile,
  relevance: ParityRelevanceInput,
  operabilityInput: OperabilityInput = operability(),
) {
  return decideStopPolicy(
    profile,
    evaluateParityGate(relevance, operabilityInput, {}),
    EVIDENCE,
  );
}

describe("stop policy on a synthetic below-threshold arm (AC-24)", () => {
  it("blocks B2, release, and the replacement claim together", async () => {
    const outcome = outcomeFor("b1-foundation", failingRelevance(["lex", "vec"]));

    expect(outcome.passed).toBe(false);
    // All three gated decisions deny at once; none may be salvaged individually.
    expect(outcome.mayStartB2).toBe(false);
    expect(outcome.mayRelease).toBe(false);
    expect(outcome.mayClaimReplacement).toBe(false);
  });

  it("preserves the raw evidence rather than discarding a disappointing run", async () => {
    // A miss is exactly when there is pressure to re-run quietly and keep the
    // better number, so the inputs that produced it must survive verbatim.
    const outcome = outcomeFor("b1-foundation", failingRelevance(["lex", "vec"]));
    expect(outcome.evidence).toEqual(EVIDENCE);
    expect(outcome.failures.join("\n")).toMatch(/below the frozen floor/);
  });

  it("requires a reviewed correction plan and forbids loosening the bounds", async () => {
    const outcome = outcomeFor("b1-foundation", failingRelevance(["lex", "vec"]));
    expect(outcome.requiredFollowUp).toMatch(/separately reviewed retrieval-correction plan/);
    expect(outcome.requiredFollowUp).toMatch(/do not loosen any frozen threshold/);
    // The clamp may be named as a cause but not changed under this plan.
    expect(outcome.requiredFollowUp).toMatch(/4096 sqlite-vec knn clamp/);
  });

  it("blocks release and the claim through the assertion helpers", async () => {
    const outcome = outcomeFor("b1-foundation", failingRelevance(["lex", "vec"]));
    expect(() => assertReleasePermitted(outcome)).toThrow(/release is blocked/);
    expect(() => assertReleasePermitted(outcome)).toThrow(/below the frozen floor/);
    expect(() => assertReplacementClaimPermitted(outcome)).toThrow(/replacement claim is blocked/);
  });

  it("blocks everything when only operability fails, despite perfect relevance", async () => {
    // The separation asserted in parity-gate must survive into the policy: a run
    // that could not complete is not releasable however well it ranked.
    const outcome = outcomeFor(
      "b1-foundation",
      passingRelevance(["lex", "vec"]),
      operability({ exitCode: 137, errors: 12 }),
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.mayRelease).toBe(false);
    expect(outcome.mayStartB2).toBe(false);
    expect(outcome.failures.join("\n")).toMatch(/exit code 137/);
  });
});

describe("stop policy on a passing run", () => {
  it("unlocks B2 and the 0.9 release after the B1 profile passes", async () => {
    const outcome = outcomeFor("b1-foundation", passingRelevance(["lex", "vec"]));
    expect(outcome.passed).toBe(true);
    expect(outcome.mayStartB2).toBe(true);
    expect(outcome.mayRelease).toBe(true);
    expect(outcome.requiredFollowUp).toBeUndefined();
    expect(() => assertReleasePermitted(outcome)).not.toThrow();
  });

  it("does not let B1 alone authorize a qmd-replacement claim", async () => {
    // Lexical and vector parity says nothing about the generated strategies qmd
    // enables by default, so the strongest claim stays gated behind B2.
    const outcome = outcomeFor("b1-foundation", passingRelevance(["lex", "vec"]));
    expect(outcome.mayClaimReplacement).toBe(false);
    expect(() => assertReplacementClaimPermitted(outcome)).toThrow(
      /requires the full b2-parity profile/,
    );
  });

  it("authorizes the replacement claim only on a passing full B2 profile", async () => {
    const outcome = outcomeFor("b2-parity", passingRelevance(["lex", "vec", "hyde"]));
    expect(outcome.mayClaimReplacement).toBe(true);
    expect(outcome.mayRelease).toBe(true);
    // B2 is already underway, so passing it does not re-authorize starting it.
    expect(outcome.mayStartB2).toBe(false);
    expect(() => assertReplacementClaimPermitted(outcome)).not.toThrow();
  });

  it("blocks the B2 replacement claim when B2 itself misses", async () => {
    const outcome = outcomeFor("b2-parity", failingRelevance(["lex", "vec", "hyde"]));
    expect(outcome.mayClaimReplacement).toBe(false);
    expect(outcome.mayRelease).toBe(false);
  });
});

describe("outcome record", () => {
  it("serializes deterministically with a stable key order", async () => {
    const outcome = outcomeFor("b1-foundation", passingRelevance(["lex", "vec"]));
    const once = serializeOutcome(outcome);
    expect(serializeOutcome(outcome)).toBe(once);
    expect(Object.keys(JSON.parse(once) as Record<string, unknown>)).toEqual([
      "schema",
      "profile",
      "passed",
      "mayStartB2",
      "mayRelease",
      "mayClaimReplacement",
      "evidence",
      "failures",
    ]);
  });

  it("records every evidence digest and the pinned baseline commit", async () => {
    const outcome = outcomeFor("b1-foundation", passingRelevance(["lex", "vec"]));
    const parsed = JSON.parse(serializeOutcome(outcome)) as {
      evidence: Record<string, string>;
    };
    expect(parsed.evidence).toEqual({
      baselineCommit: PINNED_QMD_COMMIT,
      corpusDigest: EVIDENCE.corpusDigest,
      queriesSha256: EVIDENCE.queriesSha256,
      qrelsSha256: EVIDENCE.qrelsSha256,
      rawResultsDigest: EVIDENCE.rawResultsDigest,
    });
  });

  it("carries the follow-up and failures on a miss", async () => {
    const outcome = outcomeFor("b1-foundation", failingRelevance(["lex", "vec"]));
    const parsed = JSON.parse(serializeOutcome(outcome)) as {
      failures: string[];
      requiredFollowUp?: string;
    };
    expect(parsed.failures.length).toBeGreaterThan(0);
    expect(parsed.requiredFollowUp).toMatch(/separately reviewed/);
  });

  it("omits the follow-up key entirely on a pass", async () => {
    const outcome = outcomeFor("b1-foundation", passingRelevance(["lex", "vec"]));
    expect(serializeOutcome(outcome)).not.toMatch(/requiredFollowUp/);
  });

  it("still refuses to serialize a run whose thresholds were overridden", () => {
    // The env refusal lives in the gate, so it must fire before any outcome can
    // be derived at all.
    expect(() =>
      evaluateParityGate(passingRelevance(["lex", "vec"]), operability(), {
        OMS_GOLDEN_MIN_RECALL: "0.01",
      }),
    ).toThrow(/thresholds are frozen/);
  });
});
