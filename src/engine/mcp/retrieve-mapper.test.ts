import { describe, expect, it } from "vitest";
import {
  axisFiltersToSubQueries,
  retrieveContextToSubQueries,
  retrievalResultsToAxisResult,
} from "./retrieve-mapper.js";
import type { McpAxisFilters, McpRetrieveContextOptions } from "./types.js";
import type { RetrievalResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  docPath: string,
  score: number,
  perTypeScores?: Record<string, number>,
): RetrievalResult {
  return { docPath, score, perTypeScores };
}

// ---------------------------------------------------------------------------
// axisFiltersToSubQueries
// ---------------------------------------------------------------------------

describe("axisFiltersToSubQueries — empty input", () => {
  it("empty filters → empty array", () => {
    expect(axisFiltersToSubQueries({})).toEqual([]);
  });
});

describe("axisFiltersToSubQueries — concept axis", () => {
  it("concept → single lex sub-query with concept: prefix", () => {
    const result = axisFiltersToSubQueries({ concept: "Project" });
    expect(result).toEqual([{ type: "lex", query: "concept:Project" }]);
  });

  it("empty concept string → treated as absent, no lex sub-query", () => {
    expect(axisFiltersToSubQueries({ concept: "" })).toEqual([]);
  });
});

describe("axisFiltersToSubQueries — folder axis", () => {
  it("folder → lex with folder: prefix", () => {
    expect(axisFiltersToSubQueries({ folder: "references" })).toEqual([
      { type: "lex", query: "folder:references" },
    ]);
  });
});

describe("axisFiltersToSubQueries — wikilink axis", () => {
  it("wikilink → lex with wikilink: prefix", () => {
    expect(axisFiltersToSubQueries({ wikilink: "My Note" })).toEqual([
      { type: "lex", query: "wikilink:My Note" },
    ]);
  });
});

describe("axisFiltersToSubQueries — property+value axis", () => {
  it("property + value → lex with property:value format", () => {
    expect(axisFiltersToSubQueries({ property: "status", value: "active" })).toEqual([
      { type: "lex", query: "status:active" },
    ]);
  });

  it("property without value → omitted (no partial axis key)", () => {
    expect(axisFiltersToSubQueries({ property: "status" })).toEqual([]);
  });

  it("value without property → omitted", () => {
    expect(axisFiltersToSubQueries({ value: "active" })).toEqual([]);
  });
});

describe("axisFiltersToSubQueries — free-text query", () => {
  it("query alone → vec sub-query", () => {
    expect(axisFiltersToSubQueries({ query: "deep work" })).toEqual([
      { type: "vec", query: "deep work" },
    ]);
  });

  it("empty query string → no sub-queries", () => {
    expect(axisFiltersToSubQueries({ query: "" })).toEqual([]);
  });
});

describe("axisFiltersToSubQueries — combined axis + free-text", () => {
  it("concept + query → lex (axis) + vec (free-text)", () => {
    const result = axisFiltersToSubQueries({ concept: "Project", query: "planning" });
    expect(result).toEqual([
      { type: "lex", query: "concept:Project" },
      { type: "vec", query: "planning" },
    ]);
  });

  it("folder + wikilink → single lex with both parts", () => {
    const result = axisFiltersToSubQueries({ folder: "areas", wikilink: "GTD" });
    expect(result).toEqual([
      { type: "lex", query: "folder:areas wikilink:GTD" },
    ]);
  });

  it("concept + folder + property+value + query → lex with all 3 parts + vec", () => {
    const filters: McpAxisFilters = {
      concept: "Book",
      folder: "references",
      property: "status",
      value: "read",
      query: "stoicism",
    };
    const result = axisFiltersToSubQueries(filters);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("lex");
    expect(result[0]!.query).toContain("concept:Book");
    expect(result[0]!.query).toContain("folder:references");
    expect(result[0]!.query).toContain("status:read");
    expect(result[1]).toEqual({ type: "vec", query: "stoicism" });
  });

  it("limit is not reflected in sub-queries (limit is applied post-dispatch)", () => {
    const result = axisFiltersToSubQueries({ concept: "Note", limit: 5 });
    expect(result).toEqual([{ type: "lex", query: "concept:Note" }]);
  });
});

// ---------------------------------------------------------------------------
// retrieveContextToSubQueries
// ---------------------------------------------------------------------------

describe("retrieveContextToSubQueries — base axis only", () => {
  it("no semanticSearches → same as axisFiltersToSubQueries", () => {
    const opts: McpRetrieveContextOptions = { concept: "Project", query: "planning" };
    expect(retrieveContextToSubQueries(opts)).toEqual(
      axisFiltersToSubQueries(opts),
    );
  });

  it("empty semanticSearches array → same as axisFiltersToSubQueries", () => {
    const opts: McpRetrieveContextOptions = { concept: "A", semanticSearches: [] };
    expect(retrieveContextToSubQueries(opts)).toEqual(
      axisFiltersToSubQueries({ concept: "A" }),
    );
  });
});

describe("retrieveContextToSubQueries — semantic fan-out", () => {
  it("semanticSearches only (no axis) → typed sub-queries", () => {
    const opts: McpRetrieveContextOptions = {
      semanticSearches: [
        { type: "lex", query: "keyword" },
        { type: "vec", query: "meaning" },
      ],
    };
    expect(retrieveContextToSubQueries(opts)).toEqual([
      { type: "lex", query: "keyword" },
      { type: "vec", query: "meaning" },
    ]);
  });

  it("axis + semanticSearches → axis sub-queries first, then semantic", () => {
    const opts: McpRetrieveContextOptions = {
      concept: "Project",
      query: "planning",
      semanticSearches: [{ type: "hyde", query: "project kickoff doc" }],
    };
    const result = retrieveContextToSubQueries(opts);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "lex", query: "concept:Project" });
    expect(result[1]).toEqual({ type: "vec", query: "planning" });
    expect(result[2]).toEqual({ type: "hyde", query: "project kickoff doc" });
  });

  it("maxNeighbors and useCache are not reflected in sub-queries (façade concern)", () => {
    const opts: McpRetrieveContextOptions = {
      concept: "Note",
      maxNeighbors: 5,
      useCache: true,
    };
    const result = retrieveContextToSubQueries(opts);
    expect(result).toEqual([{ type: "lex", query: "concept:Note" }]);
  });
});

// ---------------------------------------------------------------------------
// retrievalResultsToAxisResult
// ---------------------------------------------------------------------------

describe("retrievalResultsToAxisResult — shape", () => {
  it("empty results → available=true with empty hits", () => {
    expect(retrievalResultsToAxisResult([])).toEqual({ available: true, hits: [] });
  });

  it("maps docPath to docid, path, and vault:// uri", () => {
    const result = retrievalResultsToAxisResult([
      makeResult("refs/book.md", 0.8, { lex: 0.8 }),
    ]);
    if (!result.available) throw new Error("unreachable");
    const h = result.hits[0]!;
    expect(h.docid).toBe("refs/book.md");
    expect(h.path).toBe("refs/book.md");
    expect(h.uri).toBe("vault://refs/book.md");
    expect(h.score).toBe(0.8);
    expect(h.snippet).toBe("");
  });
});

describe("retrievalResultsToAxisResult — evidence flags", () => {
  it("lex score > 0 → lexical=true", () => {
    const result = retrievalResultsToAxisResult([makeResult("a.md", 0.9, { lex: 0.9 })]);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits[0]!.evidence).toEqual({ lexical: true, vector: false });
  });

  it("vec score > 0 → vector=true", () => {
    const result = retrievalResultsToAxisResult([makeResult("b.md", 0.7, { vec: 0.7 })]);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: true });
  });

  it("hyde score > 0 → vector=true", () => {
    const result = retrievalResultsToAxisResult([makeResult("c.md", 0.6, { hyde: 0.6 })]);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: true });
  });

  it("no perTypeScores → evidence all false", () => {
    const result = retrievalResultsToAxisResult([makeResult("d.md", 0.5)]);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits[0]!.evidence).toEqual({ lexical: false, vector: false });
  });
});

describe("retrievalResultsToAxisResult — limit", () => {
  const HITS = [
    makeResult("a.md", 0.9),
    makeResult("b.md", 0.7),
    makeResult("c.md", 0.5),
  ];

  it("no limit → returns all hits", () => {
    const result = retrievalResultsToAxisResult(HITS);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits).toHaveLength(3);
  });

  it("limit=2 → first 2 hits only", () => {
    const result = retrievalResultsToAxisResult(HITS, 2);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
  });

  it("limit larger than results → returns all", () => {
    const result = retrievalResultsToAxisResult(HITS, 100);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits).toHaveLength(3);
  });

  it("limit=0 → empty hits", () => {
    const result = retrievalResultsToAxisResult(HITS, 0);
    if (!result.available) throw new Error("unreachable");
    expect(result.hits).toHaveLength(0);
  });
});
