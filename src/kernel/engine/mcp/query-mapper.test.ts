import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeQueryOptions,
  queryOptionsToSubQueries,
  queryResultUnavailable,
  retrievalResultsToQueryResult,
} from "./query-mapper.js";
import type { McpSemanticQueryOptions } from "./types.js";
import { semanticQueryOptionsFromArgs } from "../../semantic/semantic-retrieve-args.js";
import { parseSearchArgs, searchQueryOptions } from "../../../cli/search-args.js";
import type { RetrievalResult } from "../types.js";
import { filterNodesByQueryAxes } from "../graph/node.js";
import type { EngineGraphNode } from "../graph/node.js";
import { McpEngineAdapter } from "./facade.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";

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

function makeNode(
  pathName: string,
  folder: string,
  axes: Record<string, string[]> = {},
  wikilinks: string[] = [],
): EngineGraphNode {
  return {
    path: pathName,
    folder,
    concept: null,
    axes,
    wikilinks,
    bodyPreview: "",
    searchTerms: new Set(),
  };
}

// ---------------------------------------------------------------------------
// queryOptionsToSubQueries
// ---------------------------------------------------------------------------

describe("queryOptionsToSubQueries — searches array", () => {
  it("uses explicit searches verbatim (lex + vec)", () => {
    const opts: McpSemanticQueryOptions = {
      ...BASE,
      query: undefined,
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
      query: undefined,
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
    ]);
  });

  it("rejects query plus explicit searches instead of silently choosing one", () => {
    const opts: McpSemanticQueryOptions = {
      ...BASE,
      searches: [{ type: "hyde", query: "from-searches" }],
      lex: "should-be-ignored",
      vec: "also-ignored",
    };
    expect(() => queryOptionsToSubQueries(opts)).toThrow(/mutually exclusive/);
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
    ]);
  });
});

describe("queryOptionsToSubQueries — mode-driven defaults", () => {
  it("no mode → lexical only", () => {
    expect(queryOptionsToSubQueries(BASE)).toEqual([
      { type: "lex", query: "hello world" },
    ]);
  });

  it("mode: query → lexical only", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "query" })).toEqual([
      { type: "lex", query: "hello world" },
    ]);
  });

  it("mode: search → lexical only", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "search" })).toEqual([
      { type: "lex", query: "hello world" },
    ]);
  });

  it("mode: vsearch → single vec", () => {
    expect(queryOptionsToSubQueries({ ...BASE, mode: "vsearch" })).toEqual([
      { type: "vec", query: "hello world" },
    ]);
  });

  it("normalizes overview and explicit channel requests through one seam", () => {
    expect(normalizeQueryOptions({ query: "" })).toMatchObject({
      overview: true,
      subQueries: [],
      lexicalQuery: "",
    });
    expect(normalizeQueryOptions({
      searches: [{ type: "lex", query: "explicit" }],
    })).toMatchObject({
      overview: false,
      subQueries: [{ type: "lex", query: "explicit" }],
      lexicalQuery: "explicit",
    });
  });

  it("distinguishes an explicit empty axes object from a true overview", () => {
    expect(normalizeQueryOptions({}).overview).toBe(true);
    expect(normalizeQueryOptions({ axes: {} })).toMatchObject({
      overview: false,
      limit: 10,
      options: { axes: {}, limit: 10 },
    });
  });

  it("keeps cursor and collection fields while applying the default page size", () => {
    const normalized = normalizeQueryOptions({
      query: "query",
      collection: "notes",
      cursor: "10",
    });
    expect(normalized).toMatchObject({
      limit: 10,
      options: { collection: "notes", cursor: "10", limit: 10 },
    });
    expect(
      retrievalResultsToQueryResult(
        Array.from({ length: 12 }, (_, index) => makeResult(`note-${index}.md`, 1)),
        { cursor: "10" },
      ),
    ).toMatchObject({
      totalCount: 12,
      hits: [{ path: "note-10.md" }, { path: "note-11.md" }],
      cursor: null,
    });
  });

  it.each([
    ["fractional limit", { query: "q", limit: 1.5 }],
    ["non-finite limit", { query: "q", limit: Number.POSITIVE_INFINITY }],
    ["zero candidate limit", { query: "q", candidateLimit: 0 }],
    ["non-finite candidate limit", { query: "q", candidateLimit: Number.NaN }],
    ["non-finite score", { query: "q", minScore: Number.NEGATIVE_INFINITY }],
  ] as const)("rejects invalid query budget: %s", (_case, options) => {
    expect(() => normalizeQueryOptions(options)).toThrow(/limit|finite|score/i);
  });

  it("retains typed searches and axes through the runtime argument parser", () => {
    const parsed = semanticQueryOptionsFromArgs("/vault", {
      searches: [{ type: "lex", query: "exact lexical" }],
      axes: { folder: ["notes"], field: { done: true }, link: "target" },
      collection: "notes",
      cursor: "3",
    });
    expect(parsed).toMatchObject({
      searches: [{ type: "lex", query: "exact lexical" }],
      axes: { folder: ["notes"], field: { done: true }, link: "target" },
      collection: "notes",
      cursor: "3",
    });
  });

  it("builds folder/field/link axes from CLI flags without dropping the query", () => {
    const args = parseSearchArgs([
      "search",
      "retrieval",
      "--folder",
      "notes",
      "--field",
      "done=true",
      "--link",
      "target",
    ]);
    expect(searchQueryOptions("query", "/vault", args, "retrieval")).toMatchObject({
      query: "retrieval",
      axes: { folder: "notes", field: { done: true }, link: "target" },
    });
  });

  it("keeps repeated field flags separate from comma-delimited values", () => {
    const args = parseSearchArgs([
      "search",
      "--field",
      "tag=one,two",
      "--field",
      "status=open",
    ]);
    expect(searchQueryOptions("query", "/vault", args, "")).toMatchObject({
      axes: { field: { tag: ["one", "two"], status: "open" } },
    });
  });

  it("does not silently discard a contradictory CLI mode", () => {
    const args = parseSearchArgs(["search", "--mode", "vsearch"]);
    expect(() => searchQueryOptions("query", "/vault", args, "retrieval")).toThrow(/contradict/i);
  });

  it("rejects malformed cursor and typed-search input instead of falling back", () => {
    expect(() => normalizeQueryOptions({ query: "query", cursor: "page-two" })).toThrow(/cursor/i);
    expect(() => queryOptionsToSubQueries({
      searches: [{ type: "vector", query: "query" }],
    } as never)).toThrow(/searches/i);
    expect(() => queryOptionsToSubQueries({ mode: "unexpected" } as never)).toThrow(/mode/i);
  });
});

describe("queryOptionsToSubQueries — explicit expansion strategy", () => {
  const strategy = { kind: "expand", profile: "qmd-v2.8.3" } as const;

  it("returns an empty seed for the facade to replace asynchronously", () => {
    expect(queryOptionsToSubQueries({ query: "what is ataraxia", strategy })).toEqual([]);
  });

  it.each([
    ["empty query", { query: "", strategy }],
    ["explicit searches", { query: "q", strategy, searches: [] }],
    ["lex shorthand", { query: "q", strategy, lex: "x" }],
    ["vec shorthand", { query: "q", strategy, vec: "x" }],
    ["hyde shorthand", { query: "q", strategy, hyde: "x" }],
    ["vector mode", { query: "q", strategy, mode: "vsearch" }],
    ["axis query", { query: "q", strategy, axes: { folder: "notes" } }],
  ] as const)("rejects %s", (_case, options) => {
    expect(() => queryOptionsToSubQueries(options as McpSemanticQueryOptions)).toThrow();
  });

  it.each([
    null,
    "expand",
    { kind: "expand", profile: "latest" },
    { kind: "other", profile: "qmd-v2.8.3" },
    { kind: "expand", profile: "qmd-v2.8.3", unknown: true },
  ])("rejects malformed or open strategy %j", (strategyInput) => {
    expect(() => queryOptionsToSubQueries({
      query: "q",
      strategy: strategyInput as never,
    })).toThrow(/strategy/i);
  });

  it.each([0, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxQueries %s",
    (maxQueries) => {
      expect(() => queryOptionsToSubQueries({
        query: "q",
        strategy: { ...strategy, maxQueries },
      })).toThrow(/between 1 and 32/);
    },
  );
});

// ---------------------------------------------------------------------------
// retrievalResultsToQueryResult
// ---------------------------------------------------------------------------

describe("retrievalResultsToQueryResult — shape", () => {
  it("empty results → available=true with empty hits", () => {
    expect(retrievalResultsToQueryResult([], {})).toMatchObject({
      available: true,
      hits: [],
      totalCount: 0,
      facets: [],
      cursor: null,
      receipt: {
        usedChannels: [],
        approximated: false,
        indexDrift: false,
        requestedStrategy: "plain",
        generatedSearches: [],
        rerankApplied: false,
        taxonomyIntents: [],
        warnings: [],
      },
    });
  });

  it("unavailable results retain the complete query envelope", () => {
    const result = queryResultUnavailable("semantic index unavailable");
    expect(result).toEqual({
      available: false,
      reason: "semantic index unavailable",
      hits: [],
      totalCount: 0,
      facets: [],
      cursor: null,
      receipt: {
        usedChannels: [],
        approximated: false,
        indexDrift: false,
        requestedStrategy: "plain",
        generatedSearches: [],
        rerankApplied: false,
        taxonomyIntents: [],
        warnings: [],
      },
    });
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

  it("reports totalCount before the limit and round-trips a cursor", () => {
    const results = Array.from({ length: 55 }, (_, index) => makeResult(`note-${index}.md`, 1));
    const first = retrievalResultsToQueryResult(results, { limit: 2 });
    expect(first).toMatchObject({ totalCount: 55, cursor: "2" });
    if (!first.available || first.cursor === null || first.cursor === undefined) return;
    const second = retrievalResultsToQueryResult(results, { limit: 2, cursor: first.cursor });
    expect(second).toMatchObject({ totalCount: 55, cursor: "4" });
    if (!second.available) return;
    expect(second.hits.map((hit) => hit.path)).toEqual(["note-2.md", "note-3.md"]);
  });

  it("keeps facet counts separate from hits and preserves intent", () => {
    const result = retrievalResultsToQueryResult(
      [makeResult("notes/a.md", 1), makeResult("notes/b.md", 0.5)],
      {
        limit: 1,
        intent: "reference lookup",
        facetValues: [{ axis: "folder", value: "notes", count: 2, intent: "Reference notes" }],
      },
    );
    expect(result).toMatchObject({
      totalCount: 2,
      intent: "reference lookup",
      facets: [{ axis: "folder", value: "notes", count: 2, intent: "Reference notes" }],
    });
    if (result.available) expect(result.hits).toHaveLength(1);
  });
});

describe("query axes — closed predicate algebra", () => {
  const nodes = [
    makeNode("a.md", "notes", { status: ["Open"], tags: ["one"] }, ["target.md"]),
    makeNode("b.md", "archive", { status: ["closed"], tags: ["one", "two"] }, ["other.md"]),
    makeNode("c.md", "projects", { status: ["Open"], tags: ["three"] }, ["target.md"]),
  ];

  it("ORs values within an axis and ANDs different axes", () => {
    const result = filterNodesByQueryAxes(nodes, {
      folder: ["notes", "projects"],
      field: { status: ["open", "pending"] },
      link: "target",
    });
    expect(result.map((node) => node.path)).toEqual(["a.md", "c.md"]);
  });

  it("rejects an unknown public axis instead of silently broadening", () => {
    expect(() => filterNodesByQueryAxes(nodes, { concept: "secret" } as never)).toThrow(/Unknown query axis/i);
  });

  it("supports date ranges and multi-value inclusion on field axes", () => {
    const dated = [
      makeNode("old.md", "notes", { date: ["2024-01-01"], tags: ["one"] }),
      makeNode("new.md", "notes", { date: ["2024-06-01"], tags: ["one", "two"] }),
    ];
    const result = filterNodesByQueryAxes(dated, {
      field: {
        date: { gte: "2024-05-01", lte: "2024-12-31" },
        tags: { contains: "two" },
      },
    });
    expect(result.map((node) => node.path)).toEqual(["new.md"]);
  });

  it("keeps numeric and boolean frontmatter values typed for predicates", () => {
    const typed = [
      makeNode("high.md", "notes", {
        rating: [5] as unknown as string[],
        done: [true] as unknown as string[],
      }),
      makeNode("low.md", "notes", {
        rating: [2] as unknown as string[],
        done: [false] as unknown as string[],
      }),
    ];
    expect(filterNodesByQueryAxes(typed, {
      field: { rating: { gte: 4 }, done: true },
    }).map((node) => node.path)).toEqual(["high.md"]);
    expect(filterNodesByQueryAxes(typed, {
      field: { done: false },
    }).map((node) => node.path)).toEqual(["low.md"]);
  });
});

describe("read-only overview on an empty vault", () => {
  it("returns an empty envelope without creating .oms state", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-query-empty-"));
    const deps: DispatcherDeps = {
      store: {
        upsert: vi.fn(),
        queryLex: vi.fn().mockReturnValue([]),
        queryVec: vi.fn().mockReturnValue([]),
        close: vi.fn(),
      },
      embed: {
        model: "test",
        dimensions: 1,
        embed: vi.fn(),
        dispose: vi.fn(),
      },
    };
    try {
      const adapter = new McpEngineAdapter(deps, vault, undefined, undefined, false, false);
      const result = await adapter.semanticQuery({ vault, axes: {} });
      expect(result).toMatchObject({ available: true, hits: [], totalCount: 0, facets: [], cursor: null });
      expect(readdirSync(vault)).toEqual([]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// queryResultUnavailable
// ---------------------------------------------------------------------------

describe("queryResultUnavailable", () => {
  it("returns available=false with the given reason and empty hits", () => {
    const result = queryResultUnavailable("store offline");
    expect(result).toMatchObject({
      available: false,
      reason: "store offline",
      hits: [],
      totalCount: 0,
      facets: [],
      cursor: null,
      receipt: { usedChannels: [], approximated: false, indexDrift: false },
    });
  });
});
