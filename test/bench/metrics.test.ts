import { describe, expect, it } from "vitest";
import {
  aggregate,
  dedupeRanked,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreQuery,
} from "../../scripts/bench/metrics.mjs";

const RANKED = ["a.md", "b.md", "c.md", "d.md", "e.md"];

describe("bench metrics", () => {
  it("computes recall at k over the relevant set", () => {
    expect(recallAtK(RANKED, ["b.md", "z.md"], 1)).toBe(0);
    expect(recallAtK(RANKED, ["b.md", "z.md"], 3)).toBe(0.5);
    expect(recallAtK(RANKED, ["b.md", "e.md"], 5)).toBe(1);
    expect(recallAtK(RANKED, [], 5)).toBe(0);
  });

  it("computes precision at k over k slots", () => {
    expect(precisionAtK(RANKED, ["a.md", "c.md"], 3)).toBeCloseTo(2 / 3);
    expect(precisionAtK(["a.md"], ["a.md"], 5)).toBe(0.2);
  });

  it("computes the reciprocal rank of the first relevant hit", () => {
    expect(reciprocalRank(RANKED, ["c.md"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(RANKED, ["c.md", "a.md"])).toBe(1);
    expect(reciprocalRank(RANKED, ["z.md"])).toBe(0);
  });

  it("computes binary nDCG against the ideal ranking", () => {
    expect(ndcgAtK(RANKED, ["a.md"], 10)).toBe(1);
    expect(ndcgAtK(RANKED, ["b.md"], 10)).toBeCloseTo(1 / Math.log2(3));
    // two relevant at ranks 1 and 3: (1 + 1/log2 4) / (1 + 1/log2 3)
    expect(ndcgAtK(RANKED, ["a.md", "c.md"], 10)).toBeCloseTo((1 + 0.5) / (1 + 1 / Math.log2(3)));
    expect(ndcgAtK(RANKED, ["z.md"], 10)).toBe(0);
  });

  it("rejects a non-positive k", () => {
    expect(() => recallAtK(RANKED, ["a.md"], 0)).toThrow(/positive integer/);
    expect(() => ndcgAtK(RANKED, ["a.md"], 1.5)).toThrow(/positive integer/);
  });

  it("dedupes chunk repeats and matches NFD paths against NFC expectations", () => {
    const nfd = "지식/낙상 위험 평가.md".normalize("NFD");
    expect(dedupeRanked(["x.md", "x.md", nfd, "win\\y.md"])).toEqual(["x.md", "지식/낙상 위험 평가.md", "win/y.md"]);
    expect(recallAtK([nfd], ["지식/낙상 위험 평가.md"], 1)).toBe(1);
  });

  it("scores one query and flags a hit within expected_in_top_k", () => {
    const scored = scoreQuery(["a.md", "a.md", "b.md", "c.md"], ["c.md"], 3);
    expect(scored.r1).toBe(0);
    expect(scored.r3).toBe(1);
    expect(scored.mrr).toBeCloseTo(1 / 3);
    expect(scored.hitAtExpectedK).toBe(true);
    expect(scoreQuery(["a.md", "b.md", "c.md"], ["c.md"], 2).hitAtExpectedK).toBe(false);
  });

  it("uses nearest-rank percentiles and aggregates means", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(() => percentile([], 50)).toThrow(/empty/);
    const rows = [scoreQuery(["a.md"], ["a.md"], 1), scoreQuery(["a.md"], ["b.md"], 1)];
    const summary = aggregate(rows, [10, 30]);
    expect(summary).toMatchObject({ n: 2, r1: 0.5, mrr: 0.5, hitRate: 0.5, p50Ms: 10, p95Ms: 30 });
    expect(aggregate([], [])).toMatchObject({ n: 0, r5: 0, hitRate: 0 });
    expect(aggregate([], [])).not.toHaveProperty("p50Ms");
  });
});
