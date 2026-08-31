import { describe, expect, it } from "vitest";
import {
  AGGREGATE_FLOORS,
  assertFrozenThresholds,
  evaluateOperabilityGate,
  evaluateParityGate,
  evaluateRelevanceGate,
  FORBIDDEN_THRESHOLD_OVERRIDES,
  MAX_QMD_DEFICIT,
  MODALITY_FLOORS,
  OPERABILITY_LIMITS,
  type OperabilityInput,
  type ParityMetric,
  type ParityModality,
  type ParityRelevanceInput,
  type ParityScopeMeasurement,
} from "./parity-gate.js";

/** Metrics comfortably above the given floors, so each test fails for one reason. */
function passingMetrics(
  floors: Readonly<Record<ParityMetric, number>>,
  bump = 0.05,
): Record<ParityMetric, number> {
  return {
    recallAt10: floors.recallAt10 + bump,
    ndcgAt10: floors.ndcgAt10 + bump,
    mrrAt10: floors.mrrAt10 + bump,
  };
}

function scope(
  floors: Readonly<Record<ParityMetric, number>>,
  overrides: Partial<ParityScopeMeasurement> = {},
): ParityScopeMeasurement {
  const oms = passingMetrics(floors);
  return {
    scoredRows: 7,
    curatedRows: 7,
    languageStrata: ["ko", "en-or-mixed"],
    oms,
    // A comparator that OMS matches exactly: any deficit is then the test's own.
    qmd: { ...oms },
    ...overrides,
  };
}

function relevanceInput(overrides: Partial<ParityRelevanceInput> = {}): ParityRelevanceInput {
  return {
    expectedModalities: ["lex", "vec"],
    modalities: {
      lex: scope(MODALITY_FLOORS),
      vec: scope(MODALITY_FLOORS),
    },
    aggregate: scope(AGGREGATE_FLOORS),
    ...overrides,
  };
}

function operabilityInput(overrides: Partial<OperabilityInput> = {}): OperabilityInput {
  return {
    exitCode: 0,
    scanned: 21_251,
    indexed: 20_959,
    skipped: 292,
    errors: 0,
    vectorCount: 48_100,
    expectedVectorCount: 48_100,
    peakRssBytes: 3 * 1024 * 1024 * 1024,
    embedWallMs: 90 * 60 * 1000,
    plainQueryP95Ms: 1_200,
    precisionQueryP95Ms: 18_000,
    ...overrides,
  };
}

describe("frozen thresholds", () => {
  it("keeps the published floors and deficit allowance as constants", () => {
    // These are the numbers the preregistration commits to. If a change here is
    // intended, it invalidates prior runs and needs a new preregistration, so the
    // test states them literally rather than deriving them from the module.
    expect(MODALITY_FLOORS).toEqual({ recallAt10: 0.8, ndcgAt10: 0.7, mrrAt10: 0.65 });
    expect(AGGREGATE_FLOORS).toEqual({ recallAt10: 0.85, ndcgAt10: 0.75, mrrAt10: 0.7 });
    expect(MAX_QMD_DEFICIT).toBe(-0.02);
    // The aggregate bar must be the stricter one, or the per-modality gate would
    // be the only thing that ever binds.
    for (const metric of ["recallAt10", "ndcgAt10", "mrrAt10"] as const) {
      expect(AGGREGATE_FLOORS[metric]).toBeGreaterThan(MODALITY_FLOORS[metric]);
    }
  });

  it("refuses every environment override of a frozen threshold", () => {
    expect(FORBIDDEN_THRESHOLD_OVERRIDES).toContain("OMS_GOLDEN_MIN_RECALL");
    for (const name of FORBIDDEN_THRESHOLD_OVERRIDES) {
      expect(() => assertFrozenThresholds({ [name]: "0.1" })).toThrow(
        /thresholds are frozen and cannot be overridden/,
      );
    }
  });

  it("ignores an empty or absent override rather than failing a clean run", () => {
    expect(() => assertFrozenThresholds({})).not.toThrow();
    expect(() => assertFrozenThresholds({ OMS_GOLDEN_MIN_RECALL: "   " })).not.toThrow();
  });

  it("rejects the override before any measurement is considered", () => {
    // The check must not be reachable only after seeing results, or it could be
    // discovered too late to matter.
    expect(() =>
      evaluateParityGate(relevanceInput(), operabilityInput(), { OMS_GOLDEN_MIN_RECALL: "0.01" }),
    ).toThrow(/thresholds are frozen/);
  });
});

describe("relevance gate", () => {
  it("passes a run that clears every floor and matches the comparator", () => {
    expect(evaluateRelevanceGate(relevanceInput())).toEqual({ passed: true, failures: [] });
  });

  it("fails a scope with zero scored rows instead of treating it as a pass", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: { lex: scope(MODALITY_FLOORS, { scoredRows: 0 }), vec: scope(MODALITY_FLOORS) },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/zero scored rows/);
  });

  it("fails when even one curated comparator row did not produce a score", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { scoredRows: 6, curatedRows: 7 }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/scored 6 of 7 curated rows/);
  });

  it.each(["recallAt10", "ndcgAt10", "mrrAt10"] as const)(
    "fails when %s is a hair below its modality floor",
    (metric) => {
      const oms = passingMetrics(MODALITY_FLOORS);
      oms[metric] = MODALITY_FLOORS[metric] - 0.0001;
      const verdict = evaluateRelevanceGate(
        relevanceInput({
          modalities: {
            lex: scope(MODALITY_FLOORS, { oms, qmd: { ...oms } }),
            vec: scope(MODALITY_FLOORS),
          },
        }),
      );
      expect(verdict.passed).toBe(false);
      expect(verdict.failures.join("\n")).toMatch(
        new RegExp(`${metric} .* is below the frozen floor`),
      );
    },
  );

  it("accepts a metric exactly at the floor", () => {
    const oms = { ...MODALITY_FLOORS };
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { oms, qmd: { ...oms } }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict).toEqual({ passed: true, failures: [] });
  });

  it("fails when the qmd comparator is missing", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { qmd: undefined }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/no matching qmd arm was measured/);
  });

  it("fails when OMS trails qmd beyond the frozen allowance", () => {
    const oms = passingMetrics(MODALITY_FLOORS, 0.1);
    const qmd = { ...oms, ndcgAt10: oms.ndcgAt10 + 0.03 };
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: { lex: scope(MODALITY_FLOORS, { oms, qmd }), vec: scope(MODALITY_FLOORS) },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/trails qmd by 0\.0300/);
  });

  it("tolerates a deficit inside the allowance", () => {
    const oms = passingMetrics(MODALITY_FLOORS, 0.1);
    const qmd = { ...oms, ndcgAt10: oms.ndcgAt10 + 0.01 };
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: { lex: scope(MODALITY_FLOORS, { oms, qmd }), vec: scope(MODALITY_FLOORS) },
      }),
    );
    expect(verdict).toEqual({ passed: true, failures: [] });
  });

  it("fails a modality the profile expects but did not measure", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({ expectedModalities: ["lex", "vec", "hyde"] }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/modality hyde: expected by the profile but not measured/);
  });

  it("fails a measured modality the profile never declared", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        expectedModalities: ["lex"],
        modalities: { lex: scope(MODALITY_FLOORS), vec: scope(MODALITY_FLOORS) },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/modality vec: measured but not declared/);
  });

  it("fails when a modality lacks required language coverage", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { languageStrata: ["en-or-mixed"] }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/missing required language coverage: ko/);
  });

  it("fails when curated rows fall below the frozen minimum", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { curatedRows: 4 }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/4 curated rows is below the frozen minimum of 5/);
  });

  it("applies the stricter aggregate floors to the aggregate scope", () => {
    // Values that clear the per-modality bar but not the aggregate bar must fail,
    // otherwise the aggregate gate is decorative.
    const oms = passingMetrics(MODALITY_FLOORS, 0.01);
    const verdict = evaluateRelevanceGate(
      relevanceInput({ aggregate: scope(AGGREGATE_FLOORS, { oms, qmd: { ...oms } }) }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/aggregate: recallAt10 .* below the frozen floor 0\.85/);
  });

  it("reports every failure at once rather than stopping at the first", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { curatedRows: 2, languageStrata: [], qmd: undefined }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
    );
    expect(verdict.failures.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a non-finite or out-of-range metric", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const oms = { ...passingMetrics(MODALITY_FLOORS), recallAt10: bad };
      const verdict = evaluateRelevanceGate(
        relevanceInput({
          modalities: {
            lex: scope(MODALITY_FLOORS, { oms, qmd: { ...oms } }),
            vec: scope(MODALITY_FLOORS),
          },
        }),
      );
      expect(verdict.passed).toBe(false);
      expect(verdict.failures.join("\n")).toMatch(/recallAt10 is not a finite ratio/);
    }
  });

  it("fails an empty expected-modality list", () => {
    const verdict = evaluateRelevanceGate(
      relevanceInput({ expectedModalities: [] as readonly ParityModality[], modalities: {} }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/at least one expected modality/);
  });
});

describe("operability gate", () => {
  it("passes a clean run", () => {
    expect(evaluateOperabilityGate(operabilityInput())).toEqual({ passed: true, failures: [] });
  });

  it("fails a non-zero exit code", () => {
    const verdict = evaluateOperabilityGate(operabilityInput({ exitCode: 1 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/exit code 1 is not 0/);
  });

  it("fails any reported file error", () => {
    const verdict = evaluateOperabilityGate(operabilityInput({ errors: 1 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/1 file errors were reported/);
  });

  it("fails internally inconsistent counts", () => {
    const verdict = evaluateOperabilityGate(
      operabilityInput({ scanned: 100, indexed: 90, skipped: 20 }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/counts are inconsistent/);
  });

  it("fails when stored vectors do not match the expected chunk count", () => {
    const verdict = evaluateOperabilityGate(operabilityInput({ vectorCount: 48_099 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/does not equal the expected embeddable chunk count/);
  });

  it("fails a run over the RSS ceiling and a run reporting no memory at all", () => {
    expect(
      evaluateOperabilityGate(
        operabilityInput({ peakRssBytes: OPERABILITY_LIMITS.maxPeakRssBytes + 1 }),
      ).failures.join("\n"),
    ).toMatch(/peak RSS/);
    // Zero RSS means the probe never measured anything; that is missing evidence,
    // not a frugal run.
    expect(evaluateOperabilityGate(operabilityInput({ peakRssBytes: 0 })).passed).toBe(false);
  });

  it("fails an embed run and a query set over their time ceilings", () => {
    expect(
      evaluateOperabilityGate(
        operabilityInput({ embedWallMs: OPERABILITY_LIMITS.maxEmbedWallMs + 1 }),
      ).failures.join("\n"),
    ).toMatch(/embed wall time/);
    expect(
      evaluateOperabilityGate(
        operabilityInput({ plainQueryP95Ms: OPERABILITY_LIMITS.maxPlainQueryP95Ms + 1 }),
      ).failures.join("\n"),
    ).toMatch(/plain query p95/);
    expect(
      evaluateOperabilityGate(
        operabilityInput({ precisionQueryP95Ms: OPERABILITY_LIMITS.maxPrecisionQueryP95Ms + 1 }),
      ).failures.join("\n"),
    ).toMatch(/precision query p95/);
  });

  it("fails when vectors were stored but no embed time was measured", () => {
    // An upper bound alone cannot catch this: a harness that skipped the embed
    // phase reports exactly 0 ms and would satisfy the six-hour ceiling. Storing
    // vectors necessarily costs time, so 0 is missing evidence, not a fast run.
    const verdict = evaluateOperabilityGate(
      operabilityInput({ embedWallMs: 0, vectorCount: 48_100, expectedVectorCount: 48_100 }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/embed phase was not measured/);
  });

  it("permits zero embed time only when no vectors were stored", () => {
    // A lexical-only profile embeds nothing, so zero is the honest measurement.
    const verdict = evaluateOperabilityGate(
      operabilityInput({ embedWallMs: 0, vectorCount: 0, expectedVectorCount: 0 }),
    );
    expect(verdict).toEqual({ passed: true, failures: [] });
  });

  it("allows an absent precision latency when the profile ran none", () => {
    expect(
      evaluateOperabilityGate(operabilityInput({ precisionQueryP95Ms: undefined })),
    ).toEqual({ passed: true, failures: [] });
  });

  it("holds plain queries to the tighter budget than precision queries", () => {
    // A plain lexical query must not be allowed the 30s precision budget.
    const between = OPERABILITY_LIMITS.maxPlainQueryP95Ms + 1;
    expect(evaluateOperabilityGate(operabilityInput({ plainQueryP95Ms: between })).passed).toBe(false);
    expect(
      evaluateOperabilityGate(operabilityInput({ precisionQueryP95Ms: between })).passed,
    ).toBe(true);
  });
});

describe("gate separation", () => {
  it("does not let a fast, stable run pass on irrelevant results", () => {
    const oms = { recallAt10: 0.1, ndcgAt10: 0.1, mrrAt10: 0.1 };
    const verdict = evaluateParityGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { oms, qmd: { ...oms } }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
      operabilityInput(),
      {},
    );
    expect(verdict.operability.passed).toBe(true);
    expect(verdict.relevance.passed).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.mayClaimReplacement).toBe(false);
  });

  it("does not let excellent relevance excuse a run that could not complete", () => {
    const verdict = evaluateParityGate(
      relevanceInput(),
      operabilityInput({ exitCode: 137, peakRssBytes: OPERABILITY_LIMITS.maxPeakRssBytes * 2 }),
      {},
    );
    expect(verdict.relevance.passed).toBe(true);
    expect(verdict.operability.passed).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.mayClaimReplacement).toBe(false);
  });

  it("permits a replacement claim only when both halves pass", () => {
    const verdict = evaluateParityGate(relevanceInput(), operabilityInput(), {});
    expect(verdict.passed).toBe(true);
    expect(verdict.mayClaimReplacement).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("surfaces failures from both halves together", () => {
    const oms = { recallAt10: 0.1, ndcgAt10: 0.1, mrrAt10: 0.1 };
    const verdict = evaluateParityGate(
      relevanceInput({
        modalities: {
          lex: scope(MODALITY_FLOORS, { oms, qmd: { ...oms } }),
          vec: scope(MODALITY_FLOORS),
        },
      }),
      operabilityInput({ errors: 3 }),
      {},
    );
    expect(verdict.failures.join("\n")).toMatch(/below the frozen floor/);
    expect(verdict.failures.join("\n")).toMatch(/3 file errors/);
  });
});
