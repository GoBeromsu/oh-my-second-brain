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
} from "./types.js";

// ---------------------------------------------------------------------------
// Request mapper
// ---------------------------------------------------------------------------

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
 */
export function queryOptionsToSubQueries(opts: McpSemanticQueryOptions): TypedSubQuery[] {
  // 1. Explicit typed searches.
  if (opts.searches !== undefined && opts.searches.length > 0) {
    return opts.searches.map((s): TypedSubQuery => ({ type: s.type, query: s.query }));
  }

  // 2. Shorthand field overrides.
  const shorthand: TypedSubQuery[] = [];
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
  const q = opts.query;
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
  opts: Pick<McpSemanticQueryOptions, "minScore" | "limit">,
): McpSemanticQueryResult {
  let hits: readonly RetrievalResult[] = results;

  if (opts.minScore !== undefined) {
    const threshold = opts.minScore;
    hits = hits.filter((r) => r.score >= threshold);
  }

  if (opts.limit !== undefined) {
    hits = hits.slice(0, opts.limit);
  }

  const searchHits: McpSemanticSearchHit[] = hits.map((r): McpSemanticSearchHit => {
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

  return { available: true, hits: searchHits };
}

/**
 * Build a failed McpSemanticQueryResult for the unavailable / error case.
 */
export function queryResultUnavailable(reason: string): McpSemanticQueryResult {
  return { available: false, reason, hits: [] };
}
