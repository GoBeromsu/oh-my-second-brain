/**
 * Centerpiece mapper: MCP SemanticQueryOptions ↔ engine TypedSubQuery[].
 *
 * queryOptionsToSubQueries     — request side: build TypedSubQuery[] from MCP input.
 * retrievalResultsToQueryResult — response side: shape RetrievalResult[] into
 *                                 McpSemanticQueryResult.
 *
 * R18: NO import from src/search.
 */

import type { TypedSubQuery, RetrievalResult } from "../types.js";
import type {
  McpSemanticQueryOptions,
  McpSemanticQueryResult,
  McpSemanticSearchHit,
  McpSemanticFacet,
  McpSemanticReceipt,
} from "./types.js";

// ---------------------------------------------------------------------------
// Request mapper
// ---------------------------------------------------------------------------

export interface NormalizedQueryOptions {
  readonly options: McpSemanticQueryOptions & { readonly limit: number };
  readonly subQueries: readonly TypedSubQuery[];
  readonly overview: boolean;
  /** Effective page size. Public query responses default to ten hits. */
  readonly limit: number;
  /** Query text used by the model-free axis path, when one is available. */
  readonly lexicalQuery: string;
}

const DEFAULT_QUERY_LIMIT = 10;

/**
 * Normalize every query shape once before dispatch:
 * explicit typed searches, shorthand channels, mode defaults, and the empty
 * overview call all share this contract. The facade uses this object for both
 * node/EAV and embedding-backed paths so a mode or cursor cannot be dropped by
 * one branch.
 */
export function normalizeQueryOptions(opts: McpSemanticQueryOptions): NormalizedQueryOptions {
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("Semantic query options must be an object.");
  }
  if (opts.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error('Query "limit" must be a finite non-negative number.');
  }
  if (opts.cursor !== undefined && typeof opts.cursor !== "string") {
    throw new Error('Query "cursor" must be a string offset.');
  }
  if (opts.cursor !== undefined && opts.cursor.trim() !== "" && !/^\d+$/u.test(opts.cursor)) {
    throw new Error(`Invalid query cursor "${opts.cursor}".`);
  }
  if (opts.cursor !== undefined && opts.cursor.trim() !== "" && !Number.isSafeInteger(Number(opts.cursor))) {
    throw new Error(`Invalid query cursor "${opts.cursor}".`);
  }
  const subQueries = queryOptionsToSubQueries(opts);
  const lexical = subQueries.find((subQuery) => subQuery.type === "lex")?.query;
  const lexicalQuery = lexical ?? (subQueries.length === 0 ? opts.query ?? "" : "");
  const hasQuery = typeof opts.query === "string" && opts.query.trim().length > 0;
  const hasAxes = opts.axes !== undefined;
  const overview = !hasQuery && subQueries.length === 0 && !hasAxes;
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
  return {
    // Keep every caller-provided property (including collection, axes, mode,
    // and cursor) while making the effective default explicit to downstream
    // adapters. No branch may reconstruct a partial options object and drop
    // an input field.
    options: { ...opts, limit },
    subQueries,
    overview,
    limit,
    lexicalQuery,
  };
}

/**
 * Convert McpSemanticQueryOptions into TypedSubQuery[] for the engine dispatcher.
 *
 * Priority order:
 *   1. Explicit `searches` array (non-empty) — used verbatim.
 *      MCP types `"lex"|"vec"|"hyde"` are a strict subset of the engine's
 *      `"lex"|"vec"|"hyde"|"graph"`, so the coercion is always safe.
 *   2. Individual `lex` / `vec` / `hyde` shorthand fields (non-empty strings).
 *   3. Mode-driven defaults applied to `query`:
 *      - `"vsearch"` → single vec sub-query.
 *      - `"query"` | `"search"` | (default) → hybrid lex + vec.
 *   4. No query/searches → no sub-query (the facade serves an overview).
 */
export function queryOptionsToSubQueries(opts: McpSemanticQueryOptions): TypedSubQuery[] {
  if (opts.query !== undefined && typeof opts.query !== "string") {
    throw new Error('Query "query" must be a string.');
  }
  if (opts.mode !== undefined && opts.mode !== "query" && opts.mode !== "search" && opts.mode !== "vsearch") {
    throw new Error(`Unknown query mode "${String(opts.mode)}".`);
  }
  if (opts.searches !== undefined && !Array.isArray(opts.searches)) {
    throw new Error('Query "searches" must be an array.');
  }
  // 1. Explicit typed searches.
  if (opts.searches !== undefined && opts.searches.length > 0) {
    return opts.searches.map((s): TypedSubQuery => {
      if (
        s === null
        || typeof s !== "object"
        || (s.type !== "lex" && s.type !== "vec" && s.type !== "hyde")
        || typeof s.query !== "string"
      ) {
        throw new Error('Each query "searches" item must contain a lex, vec, or hyde type and string query.');
      }
      return { type: s.type, query: s.query };
    });
  }

  // 2. Shorthand field overrides.
  const shorthand: TypedSubQuery[] = [];
  for (const [name, value] of [["lex", opts.lex], ["vec", opts.vec], ["hyde", opts.hyde]] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Query "${name}" must be a string.`);
    }
  }
  if (opts.lex !== undefined && opts.lex.length > 0) {
    shorthand.push({ type: "lex", query: opts.lex });
  }
  if (opts.vec !== undefined && opts.vec.length > 0) {
    shorthand.push({ type: "vec", query: opts.vec });
  }
  if (opts.hyde !== undefined && opts.hyde.length > 0) {
    shorthand.push({ type: "hyde", query: opts.hyde });
  }
  if (shorthand.length > 0) return shorthand;

  // 3. Mode-driven defaults on the primary `query` field.
  const q = opts.query ?? "";
  if (q.trim().length === 0) return [];
  switch (opts.mode) {
    case "vsearch":
      return [{ type: "vec", query: q }];
    case "search":
    case "query":
    default:
      return [
        { type: "lex", query: q },
        { type: "vec", query: q },
      ];
  }
}

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

/**
 * Shape engine RetrievalResult[] into McpSemanticQueryResult.
 *
 * - Applies optional `minScore` filter (inclusive threshold).
 * - Truncates to `limit` after filtering.
 * - Derives evidence flags from `perTypeScores` (lex → lexical; vec|hyde → vector).
 * - Uses `docPath` as the synthetic `docid` (engine has no separate hash id).
 * - `snippet` is empty: the engine returns ranked paths, not extracted text.
 */
export function retrievalResultsToQueryResult(
  results: readonly RetrievalResult[],
  opts: Pick<McpSemanticQueryOptions, "minScore" | "limit" | "cursor" | "intent"> & {
    readonly facetValues?: readonly McpSemanticFacet[];
    readonly usedChannels?: readonly McpSemanticReceipt["usedChannels"][number][];
    readonly approximated?: boolean;
    readonly drift?: boolean;
  },
): McpSemanticQueryResult {
  // The engine fuses chunk hits, while the public MCP envelope is
  // document-addressable. Collapse duplicate chunks before filtering,
  // counting, and cursor paging so one document cannot consume a page twice.
  let hits: readonly RetrievalResult[] = dedupeDocumentResults(results);

  if (opts.minScore !== undefined) {
    const threshold = opts.minScore;
    hits = hits.filter((r) => r.score >= threshold);
  }

  const totalCount = hits.length;
  const offset = decodeCursor(opts.cursor);
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
  const page = hits.slice(offset, offset + Math.max(0, limit));
  const nextOffset = offset + page.length;
  const cursor = nextOffset < totalCount ? encodeCursor(nextOffset) : null;

  const searchHits: McpSemanticSearchHit[] = page.map((r): McpSemanticSearchHit => {
    const lexScore = r.perTypeScores?.["lex"] ?? 0;
    const vecScore = r.perTypeScores?.["vec"] ?? 0;
    const hydeScore = r.perTypeScores?.["hyde"] ?? 0;
    return {
      docid: r.docPath,
      score: r.score,
      uri: `vault://${r.docPath}`,
      path: r.docPath,
      snippet: "",
      evidence: {
        lexical: lexScore > 0,
        vector: vecScore > 0 || hydeScore > 0,
      },
    };
  });

  const usedChannels = [...new Set(opts.usedChannels ?? deriveChannels(results))];
  const receipt: McpSemanticReceipt = {
    usedChannels,
    approximated: opts.approximated ?? false,
    drift: opts.drift ?? false,
  };
  return {
    available: true,
    hits: searchHits,
    totalCount,
    facets: opts.facetValues ?? [],
    cursor,
    ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
    receipt,
  };
}

function dedupeDocumentResults(results: readonly RetrievalResult[]): RetrievalResult[] {
  const byPath = new Map<string, RetrievalResult>();
  for (const result of results) {
    const prior = byPath.get(result.docPath);
    if (prior === undefined) {
      byPath.set(result.docPath, result);
      continue;
    }
    const preferred = result.score > prior.score ? result : prior;
    const secondary = preferred === result ? prior : result;
    const perTypeScores: Record<string, number> = {
      ...(secondary.perTypeScores ?? {}),
      ...(preferred.perTypeScores ?? {}),
    };
    for (const [type, score] of Object.entries(secondary.perTypeScores ?? {})) {
      perTypeScores[type] = Math.max(perTypeScores[type] ?? 0, score);
    }
    for (const [type, score] of Object.entries(preferred.perTypeScores ?? {})) {
      perTypeScores[type] = Math.max(perTypeScores[type] ?? 0, score);
    }
    byPath.set(result.docPath, {
      ...preferred,
      ...(Object.keys(perTypeScores).length > 0 ? { perTypeScores } : {}),
    });
  }
  return [...byPath.values()];
}

/**
 * Build a failed McpSemanticQueryResult for the unavailable / error case.
 */
export function queryResultUnavailable(reason: string): McpSemanticQueryResult {
  return {
    available: false,
    reason,
    hits: [],
    totalCount: 0,
    facets: [],
    cursor: null,
    receipt: { usedChannels: [], approximated: false, drift: false },
  };
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim() === "") return 0;
  if (!/^\d+$/u.test(cursor)) throw new Error(`Invalid query cursor "${cursor}".`);
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error(`Invalid query cursor "${cursor}".`);
  return offset;
}

function deriveChannels(results: readonly RetrievalResult[]): McpSemanticReceipt["usedChannels"] {
  const used = new Set<McpSemanticReceipt["usedChannels"][number]>();
  for (const result of results) {
    if ((result.perTypeScores?.["lex"] ?? 0) > 0) used.add("lex");
    if ((result.perTypeScores?.["vec"] ?? 0) > 0) used.add("vec");
    if ((result.perTypeScores?.["hyde"] ?? 0) > 0) used.add("hyde");
  }
  return [...used];
}
