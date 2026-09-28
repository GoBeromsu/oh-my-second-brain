import { describe, expect, it } from "vitest";
import type { ScoredHit } from "../types.js";
import { KO_LEXICAL_RRF_K, fuseKoreanLexical } from "./lexical-fusion.js";
import { fuseRRF } from "./rrf.js";

function hit(docPath: string, score: number): ScoredHit {
  return { docPath, chunkOrdinal: 0, score };
}

describe("fuseKoreanLexical", () => {
  it("uses RRF with k=60", () => {
    const cur = [hit("a.md", 1), hit("b.md", 0.5)];
    const bigram = [hit("c.md", 1), hit("a.md", 0.5)];
    expect(KO_LEXICAL_RRF_K).toBe(60);
    expect(fuseKoreanLexical(cur, bigram)).toEqual(fuseRRF([cur, bigram], 60));
  });

  it("ranks a hit found by both channels first and keeps hits only one channel found", () => {
    const fused = fuseKoreanLexical([hit("a.md", 1), hit("b.md", 0.5)], [hit("c.md", 1), hit("a.md", 0.5)]);
    expect(fused[0].docPath).toBe("a.md");
    expect(new Set(fused.map((entry) => entry.docPath))).toEqual(new Set(["a.md", "b.md", "c.md"]));
  });

  it("returns the bigram list when CUR finds nothing", () => {
    expect(fuseKoreanLexical([], [hit("c.md", 1)]).map((entry) => entry.docPath)).toEqual(["c.md"]);
  });
});
