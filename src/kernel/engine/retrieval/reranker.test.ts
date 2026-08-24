import { describe, expect, it } from "vitest";
import { PassthroughReranker, passthroughReranker } from "./reranker.js";
import type { Reranker } from "./reranker.js";
import type { ScoredHit } from "../types.js";

function hit(docPath: string, score: number): ScoredHit {
  return { docPath, chunkOrdinal: 0, score };
}

describe("PassthroughReranker", () => {
  it("satisfies the Reranker interface", () => {
    const r: Reranker = new PassthroughReranker();
    expect(typeof r.rerank).toBe("function");
  });

  it("returns hits in the original order unchanged", async () => {
    const hits: ScoredHit[] = [
      hit("first.md", 0.9),
      hit("second.md", 0.7),
      hit("third.md", 0.5),
    ];
    const result = await passthroughReranker.rerank("some query", hits);
    expect(result).toHaveLength(3);
    expect(result[0]!.docPath).toBe("first.md");
    expect(result[1]!.docPath).toBe("second.md");
    expect(result[2]!.docPath).toBe("third.md");
  });

  it("preserves scores exactly", async () => {
    const hits: ScoredHit[] = [hit("a.md", 0.123456), hit("b.md", 0.654321)];
    const result = await passthroughReranker.rerank("q", hits);
    expect(result[0]!.score).toBe(0.123456);
    expect(result[1]!.score).toBe(0.654321);
  });

  it("handles empty hit list", async () => {
    const result = await passthroughReranker.rerank("q", []);
    expect(result).toEqual([]);
  });

  it("singleton and new instance behave identically", async () => {
    const hits = [hit("x.md", 0.5)];
    const fromSingleton = await passthroughReranker.rerank("q", hits);
    const fromNew = await new PassthroughReranker().rerank("q", hits);
    expect(fromSingleton).toEqual(fromNew);
  });
});
