import { describe, expect, it } from "vitest";
import { bootstrapMeanCI, pairedRandomizationTest, quantile, seededRandom } from "../../scripts/bench/stats.mjs";

describe("bench stats", () => {
  it("computes a type-7 (linear interpolation) quantile against known values", () => {
    // Reference values are numpy's/R's default ("linear"/type-7) quantile,
    // which floor(q * n) indexing does not reproduce: it would give 1 for
    // q=0.25 here instead of the correctly-interpolated 2.
    const data = [1, 2, 3, 4, 5];
    expect(quantile(data, 0)).toBe(1);
    expect(quantile(data, 0.25)).toBe(2);
    expect(quantile(data, 0.5)).toBe(3);
    expect(quantile(data, 0.75)).toBe(4);
    expect(quantile(data, 1)).toBe(5);
    // An even-length input interpolates between its two middle values.
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    // A single-element input has nothing to interpolate between.
    expect(quantile([7], 0.3)).toBe(7);
  });

  it("rejects an empty sample", () => {
    expect(() => quantile([], 0.5)).toThrow(/empty/);
  });

  it("draws a reproducible stream for a seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(first[0]);
  });

  it("returns p = 1 when the channels are identical", () => {
    const result = pairedRandomizationTest([1, 0, 1, 0], [1, 0, 1, 0], { permutations: 500, seed: 3 });
    expect(result.meanDiff).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.permutations).toBe(500);
  });

  it("matches the exact sign-flip p-value on a small sample", () => {
    // Six +1 differences: only the all-plus and all-minus flips are as extreme,
    // so the exact two-sided p is 2 / 64.
    const result = pairedRandomizationTest([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], { permutations: 10_000, seed: 11 });
    expect(result.meanDiff).toBe(1);
    expect(result.pValue).toBeGreaterThan(0.02);
    expect(result.pValue).toBeLessThan(0.045);
  });

  it("finds a large consistent improvement significant", () => {
    const baseline = Array.from({ length: 30 }, () => 0);
    const candidate = Array.from({ length: 30 }, (_, index) => (index % 5 === 0 ? 0 : 1));
    const result = pairedRandomizationTest(baseline, candidate, { seed: 1 });
    expect(result.meanDiff).toBeCloseTo(0.8);
    expect(result.pValue).toBeLessThan(0.001);
  });

  it("is reproducible for a seed", () => {
    const a = [0.2, 0.5, 0.1, 0.9, 0.4];
    const b = [0.3, 0.4, 0.4, 0.9, 0.6];
    expect(pairedRandomizationTest(a, b, { seed: 5, permutations: 1000 })).toEqual(
      pairedRandomizationTest(a, b, { seed: 5, permutations: 1000 }),
    );
  });

  it("rejects unpaired or empty samples", () => {
    expect(() => pairedRandomizationTest([1], [1, 2])).toThrow(/equal length/);
    expect(() => pairedRandomizationTest([], [])).toThrow(/empty/);
  });

  it("brackets the mean with a bootstrap interval", () => {
    const constant = bootstrapMeanCI([0.5, 0.5, 0.5], { seed: 2, resamples: 200 });
    expect(constant).toEqual({ mean: 0.5, lower: 0.5, upper: 0.5 });
    const spread = bootstrapMeanCI([0, 0, 1, 1, 1, 0, 1, 0, 1, 1], { seed: 2, resamples: 2000 });
    expect(spread.mean).toBeCloseTo(0.6);
    expect(spread.lower).toBeLessThan(0.6);
    expect(spread.upper).toBeGreaterThan(0.6);
    expect(spread.lower).toBeGreaterThanOrEqual(0);
    expect(spread.upper).toBeLessThanOrEqual(1);
    expect(() => bootstrapMeanCI([])).toThrow(/empty/);
  });
});
