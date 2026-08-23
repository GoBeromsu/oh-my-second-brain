import { describe, expect, it } from "vitest";
import {
  queryOptionsToSubQueries,
  queryResultUnavailable,
  retrievalResultsToQueryResult,
} from "./query-mapper.js";
import type { McpSemanticQueryOptions } from "./types.js";
import type { RetrievalResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE: McpSemanticQueryOptions = { query: "hello world" };

function makeResult(
  docPath: string,
  score: number,
  perTypeScores?: Record<string, number>,
): RetrievalResult {
  return { docPath, score, perTypeScores };
}

// ---------------------------------------------------------------------------
// queryOptionsToSubQueries
// ---------------------------------------------------------------------------

describe("queryOptionsToSubQueries — searches array", () => {
  it("uses explicit searches verbatim (lex + vec)", () => {
    const opts: McpSemanticQueryOptions = {
      ...BASE,
      searches: [
        { type: "lex", query: "foo" },
        { type: "vec", query: "bar" },
      ],
    };
    expect(queryOptionsToSubQueries(opts)).toEqual([
      { type: "lex", query: "foo" },
      { type: "vec", query: "bar" },
    ]);
  });

  it("uses explicit searches verbatim (single hyde)", () => {
    const opts: McpSemanticQueryOptions = {
      ...BASE,
      searches: [{ type: "hyde", query: "hypothetical answer" }],
    };
    expect(queryOptionsToSubQueries(opts)).toEqual([
      { type: "hyde", query: "hypothetical answer" },
    ]);
  });

  it("empty searches array falls through to mode defaults", () => {
    const opts: McpSemanticQueryOptions = { ...BASE, searches: [] };
    expect(queryOptionsToSubQueries(opts)).toEqual([
      { type: "lex", query: "hello world" },
      { type: "vec", query: "hello world" },
    ]);
  });

  it("searches takes priority over lex/vec shorthand fields", () => {
    const opts: McpSemanticQueryOptions = {
      ...BASE,
      searches: [{ type: "hyde", query: "from-searches" }],
      lex: "should-be-ignored",
      vec: "also-ignored",
    };
    expect(queryOptionsToSubQueries(opts)).toEqual([
      { type: "hyde", query: "from-searches" },
    ]);
  });
});

describe("queryOptionsToSubQueries — shorthand fields", () => {
  it("lex shorthand alone", () => {
    expect(queryOptionsToSubQueries({ ...BASE, lex: "keyword" })).toEqual([
      { type: "lex", query: "keyword" },
    ]);
  });

  it("vec shorthand alone", () => {
    expect(queryOptionsToSubQueries({ ...BASE, vec: "semantic" })).toEqual([
      { type: "vec", query: "semantic" },
    ]);
  });

  it("hyde shorthand alone", () => {
    expect(queryOptionsToSubQueries({ ...BASE, hyde: "hypo" })).toEqual([
      { type: "hyde", query: "hypo" },
    ]);
  });

  it("lex + vec shorthand combined", () => {
    expect(queryOptionsToSubQueries({ ...BASE, lex: "kw", vec: "sem" })).toEqual([
      { type: "lex", query: "kw" },
      { type: "vec", query: "sem" },
    ]);
  });

  it("all three shorthands combined", () => {
    expect(
      queryOptionsToSubQueries({ ...BASE, lex: "kw", vec: "sem", hyde: "hyp" }),
    ).toEqual([
      { type: "lex", query: "kw" },
      { type: "vec", query: "sem" },
      { type: "hyde", query: "hyp" },
    ]);
  });

  it("empty-string shorthands are ignored — falls through to defaults", () => {
    const opts: McpSemanticQueryOptions = { ...BASE, lex: "", vec: "" };
    expect(queryOptionsToSubQueries(opts)).toEqual([
      { type: "lex", query: "hello world" },
      { type: "vec", query: "hello world" },
    ]);
  });
});

describe("queryOptionsToSubQueries — mode-driven defaults", () => {
  it("no mode → hybrid lex + vec", () => {
    expect(queryOptionsToSubQueries(BASE)).toEqual([
      { type: "lex", query: "hello world" },
      { type: "vec", query: "hello world" },
    ]);
  });

  it("mode: query → hybrid lex + vec", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "query" })).toEqual([
      { type: "lex", query: "hello world" },
      { type: "vec", query: "hello world" },
    ]);
  });

  it("mode: search → hybrid lex + vec", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "search" })).toEqual([
      { type: "lex", query: "hello world" },
      { type: "vec", query: "hello world" },
    ]);
  });

  it("mode: vsearch → single vec", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "vsearch" })).toEqual([
      { type: "vec", query: "hello world" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// retrievalResultsToQueryResult
// ---------------------------------------------------------------------------

describe("retrievalResultsToQueryResult — shape", () => {
  it("empty results → available=true with empty hits", () => {
    expect(retrievalResultsToQueryResult([], {})).toEqual({ available: true, hits: [] });
  });

  it("maps docPath to docid, path, and vault:// uri", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("notes/foo.md", 0.9, { lex: 0.8 })],
      {},
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    const hit = result.hits[0]!;
    expect(hit.docid).toBe("notes/foo.md");
    expect(hit.path).toBe("notes/foo.md");
    expect(hit.uri).toBe("vault://notes/foo.md");
    expect(hit.score).toBe(0.9);
    expect(hit.snippet).toBe("");
  });
});

describe("retrievalResultsToQueryResult — evidence flags", () => {
  it("lex score > 0 → lexical=true, vector=false", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("a.md", 0.8, { lex: 0.8, vec: 0 })],
      {},
    );
    if (!result.available) return;
    expect(result.hits[0]!.evidence).toEqual({ lexical: true, vector: false });
  });

  it("vec score > 0 → vector=true", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("b.md", 0.7, { vec: 0.7 })],
      {},
    );
    if (!result.available) return;
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: true });
  });

  it("hyde score > 0 → vector=true (hyde counted as vector)", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("c.md", 0.6, { hyde: 0.6 })],
      {},
    );
    if (!result.available) return;
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: true });
  });

  it("no perTypeScores → evidence all false", () => {
    const result = retrievalResultsToQueryResult([makeResult("d.md", 0.5)], {});
    if (!result.available) return;
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: false });
  });

  it("both lex and vec → both true", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("e.md", 0.9, { lex: 0.8, vec: 0.7 })],
      {},
    );
    if (!result.available) return;
    expect(result.hits[0]!.evidence).toEqual({ lexical: true, vector: true });
  });
});

describe("retrievalResultsToQueryResult — filtering and limits", () => {
  const HIT_HIGH = makeResult("high.md", 0.9, { lex: 0.9 });
  const HIT_MID = makeResult("mid.md", 0.7, { vec: 0.7 });
  const HIT_LOW = makeResult("low.md", 0.2);

  it("filters by minScore (inclusive)", () => {
    const result = retrievalResultsToQueryResult([HIT_HIGH, HIT_MID, HIT_LOW], {
      minScore: 0.7,
    });
    if (!result.available) return;
    expect(result.hits.map((h) => h.path)).toEqual(["high.md", "mid.md"]);
  });

  it("minScore: 0 passes all hits", () => {
    const result = retrievalResultsToQueryResult([HIT_HIGH, HIT_LOW], { minScore: 0 });
    if (!result.available) return;
    expect(result.hits).toHaveLength(2);
  });

  it("truncates to limit", () => {
    const result = retrievalResultsToQueryResult([HIT_HIGH, HIT_MID, HIT_LOW], { limit: 2 });
    if (!result.available) return;
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.path)).toEqual(["high.md", "mid.md"]);
  });

  it("applies minScore before limit", () => {
    const result = retrievalResultsToQueryResult([HIT_HIGH, HIT_MID, HIT_LOW], {
      minScore: 0.5,
      limit: 1,
    });
    if (!result.available) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.path).toBe("high.md");
  });

  it("limit larger than results → returns all", () => {
    const result = retrievalResultsToQueryResult([HIT_HIGH, HIT_MID], { limit: 100 });
    if (!result.available) return;
    expect(result.hits).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// queryResultUnavailable
// ---------------------------------------------------------------------------

describe("queryResultUnavailable", () => {
  it("returns available=false with the given reason and empty hits", () => {
    const result = queryResultUnavailable("store offline");
    expect(result).toEqual({ available: false, reason: "store offline", hits: [] });
  });
});
