import { describe, expect, it } from "vitest";
import { DEFAULT_INTERVIEW_CONFIG } from "./types.js";
import {
  computeAmbiguity,
  meetsThreshold,
  validateScores,
} from "./ambiguity.js";
import type { DimensionScore } from "./types.js";

// ---------------------------------------------------------------------------
// computeAmbiguity
// ---------------------------------------------------------------------------

describe("computeAmbiguity", () => {
  it("returns 0 when all sub-dimensions are fully resolved (1.0)", () => {
    const scores: DimensionScore = { goal: 1, constraint: 1, criteria: 1, context: 1 };
    expect(computeAmbiguity(scores)).toBe(0);
  });

  it("returns 1 when all sub-dimensions are completely unresolved (0.0)", () => {
    const scores: DimensionScore = { goal: 0, constraint: 0, criteria: 0, context: 0 };
    expect(computeAmbiguity(scores)).toBe(1);
  });

  it("returns 0.5 when mean score is 0.5", () => {
    const scores: DimensionScore = { goal: 0.5, constraint: 0.5, criteria: 0.5, context: 0.5 };
    expect(computeAmbiguity(scores)).toBeCloseTo(0.5);
  });

  it("computes correct mean across mixed scores", () => {
    // mean = (1 + 0.8 + 0.6 + 0.4) / 4 = 0.7  → ambiguity = 0.3
    const scores: DimensionScore = { goal: 1, constraint: 0.8, criteria: 0.6, context: 0.4 };
    expect(computeAmbiguity(scores)).toBeCloseTo(0.3);
  });

  it("is deterministic for the same input", () => {
    const scores: DimensionScore = { goal: 0.9, constraint: 0.7, criteria: 0.8, context: 0.6 };
    expect(computeAmbiguity(scores)).toBe(computeAmbiguity(scores));
  });
});

// ---------------------------------------------------------------------------
// meetsThreshold
// ---------------------------------------------------------------------------

describe("meetsThreshold", () => {
  it("returns true when ambiguity equals the threshold exactly (boundary inclusive)", () => {
    // ambiguity = 1 − mean(0.8, 0.8, 0.8, 0.8) = 0.2 → equals default threshold 0.20
    const scores: DimensionScore = { goal: 0.8, constraint: 0.8, criteria: 0.8, context: 0.8 };
    expect(meetsThreshold(scores, DEFAULT_INTERVIEW_CONFIG)).toBe(true);
  });

  it("returns true when ambiguity is below the threshold", () => {
    const scores: DimensionScore = { goal: 0.9, constraint: 0.9, criteria: 0.9, context: 0.9 };
    expect(meetsThreshold(scores, DEFAULT_INTERVIEW_CONFIG)).toBe(true);
  });

  it("returns false when ambiguity exceeds the threshold", () => {
    const scores: DimensionScore = { goal: 0.5, constraint: 0.5, criteria: 0.5, context: 0.5 };
    expect(meetsThreshold(scores, DEFAULT_INTERVIEW_CONFIG)).toBe(false);
  });

  it("respects a custom threshold", () => {
    const scores: DimensionScore = { goal: 0.5, constraint: 0.5, criteria: 0.5, context: 0.5 };
    // ambiguity = 0.5 — should fail at threshold 0.4 but pass at threshold 0.6
    expect(meetsThreshold(scores, { ambiguityThreshold: 0.4, maxRoundsPerDimension: 5 })).toBe(false);
    expect(meetsThreshold(scores, { ambiguityThreshold: 0.6, maxRoundsPerDimension: 5 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateScores
// ---------------------------------------------------------------------------

describe("validateScores", () => {
  it("accepts valid scores with all values in [0, 1]", () => {
    const scores: DimensionScore = { goal: 0, constraint: 0.5, criteria: 1, context: 0.75 };
    const result = validateScores(scores);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a score above 1", () => {
    const scores: DimensionScore = { goal: 1.1, constraint: 0.5, criteria: 1, context: 0.75 };
    const result = validateScores(scores);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.subDimension === "goal")).toBe(true);
  });

  it("rejects a score below 0", () => {
    const scores: DimensionScore = { goal: 0, constraint: -0.1, criteria: 1, context: 0.75 };
    const result = validateScores(scores);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.subDimension === "constraint")).toBe(true);
  });

  it("rejects NaN values", () => {
    const scores: DimensionScore = { goal: NaN, constraint: 0.5, criteria: 1, context: 0.75 };
    const result = validateScores(scores);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.subDimension === "goal")).toBe(true);
  });

  it("collects errors for all invalid sub-dimensions at once", () => {
    const scores: DimensionScore = { goal: -1, constraint: 2, criteria: NaN, context: 0.5 };
    const result = validateScores(scores);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});
