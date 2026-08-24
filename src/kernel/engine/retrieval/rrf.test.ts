import { describe, expect, it } from "vitest";
import { fuseRRF } from "./rrf.js";
import type { ScoredHit } from "../types.js";

function hit(docPath: string, chunkOrdinal: number, score: number): ScoredHit {
  return { docPath, chunkOrdinal, score };
}

describe("fuseRRF", () => {
  it("returns empty list for empty input", () => {
    expect(fuseRRF([])).toEqual([]);
  });

  it("returns empty list when all inner lists are empty", () => {
    expect(fuseRRF([[], []])).toEqual([]);
  });

  it("single list: scores equal 1/(k+rank) with k=60", () => {
    const list = [hit("a.md", 0, 10), hit("b.md", 0, 5), hit("c.md", 0, 1)];
    const result = fuseRRF([list]);
    expect(result).toHaveLength(3);
    // rank 1 → 1/61, rank 2 → 1/62, rank 3 → 1/63
    expect(result[0]!.docPath).toBe("a.md");
    expect(result[0]!.score).toBe(1 / 61);
    expect(result[1]!.docPath).toBe("b.md");
    expect(result[1]!.score).toBe(1 / 62);
    expect(result[2]!.docPath).toBe("c.md");
    expect(result[2]!.score).toBe(1 / 63);
  });

  it("two lists: exact RRF fusion with hand-computed values (k=60)", () => {
    // List 1: A rank-1, B rank-2, C rank-3  → A:1/61, B:1/62, C:1/63
    // List 2: B rank-1, A rank-2, D rank-3  → B:1/61, A:1/62, D:1/63
    // Final:  A = 1/61+1/62 = 123/3782
    //         B = 1/62+1/61 = 123/3782  (same as A, ties lex → A before B)
    //         C = 1/63
    //         D = 1/63                  (C before D lexicographically)
    const list1: ScoredHit[] = [
      hit("doc-a.md", 0, 10),
      hit("doc-b.md", 0, 5),
      hit("doc-c.md", 0, 1),
    ];
    const list2: ScoredHit[] = [
      hit("doc-b.md", 0, 9),
      hit("doc-a.md", 0, 3),
      hit("doc-d.md", 0, 1),
    ];

    const result = fuseRRF([list1, list2]);

    expect(result).toHaveLength(4);

    const expectedAB = 1 / 61 + 1 / 62; // 123/3782
    const expectedCD = 1 / 63;

    expect(result[0]!.docPath).toBe("doc-a.md");
    expect(result[0]!.score).toBe(expectedAB);

    expect(result[1]!.docPath).toBe("doc-b.md");
    expect(result[1]!.score).toBe(expectedAB);

    // A and B must have identical scores (symmetric contributions)
    expect(result[0]!.score).toBe(result[1]!.score);

    expect(result[2]!.docPath).toBe("doc-c.md");
    expect(result[2]!.score).toBe(expectedCD);

    expect(result[3]!.docPath).toBe("doc-d.md");
    expect(result[3]!.score).toBe(expectedCD);

    // C and D must have identical scores
    expect(result[2]!.score).toBe(result[3]!.score);
  });

  it("custom k changes scores proportionally", () => {
    const list = [hit("x.md", 0, 1)];
    const r10 = fuseRRF([list], 10);
    const r60 = fuseRRF([list], 60);
    expect(r10[0]!.score).toBe(1 / 11); // 1/(10+1)
    expect(r60[0]!.score).toBe(1 / 61); // 1/(60+1)
    expect(r10[0]!.score).toBeGreaterThan(r60[0]!.score);
  });

  it("handles multiple chunks from the same document independently", () => {
    const list1 = [hit("note.md", 0, 5), hit("note.md", 1, 3)];
    const list2 = [hit("note.md", 1, 7), hit("note.md", 0, 2)];
    const result = fuseRRF([list1, list2]);
    expect(result).toHaveLength(2);
    // chunk 0: list1 rank1 + list2 rank2 = 1/61 + 1/62 = 123/3782
    // chunk 1: list1 rank2 + list2 rank1 = 1/62 + 1/61 = 123/3782
    expect(result[0]!.score).toBe(result[1]!.score);
    // tie-break on ordinal → chunk 0 first
    expect(result[0]!.chunkOrdinal).toBe(0);
    expect(result[1]!.chunkOrdinal).toBe(1);
  });

  it("document in only one list gets scored only from that list", () => {
    const list1 = [hit("only-here.md", 0, 8)];
    const list2 = [hit("other.md", 0, 9)];
    const result = fuseRRF([list1, list2]);
    expect(result).toHaveLength(2);
    const onlyHere = result.find((r) => r.docPath === "only-here.md");
    const other = result.find((r) => r.docPath === "other.md");
    expect(onlyHere!.score).toBe(1 / 61);
    expect(other!.score).toBe(1 / 61);
  });

  it("three lists: document in all three accumulates the highest score", () => {
    // doc-x appears first in all three lists → 3 × (1/61)
    const mkList = (first: string, rest: string[]) =>
      [hit(first, 0, 10), ...rest.map((d) => hit(d, 0, 1))];
    const result = fuseRRF([
      mkList("doc-x.md", ["doc-y.md"]),
      mkList("doc-x.md", ["doc-z.md"]),
      mkList("doc-x.md", ["doc-w.md"]),
    ]);
    const topHit = result[0]!;
    expect(topHit.docPath).toBe("doc-x.md");
    expect(topHit.score).toBeCloseTo(3 / 61, 12);
  });
});
