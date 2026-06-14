/**
 * Request/response mappers for axis-based retrieval ops:
 *   oms_retrieve_by_axis  — axis-first narrowing with optional lex query.
 *   oms_retrieve_context  — axis narrowing + semantic fan-out.
 *
 * Both ops reduce to TypedSubQuery[] fan-outs:
 *   - Axis fields (concept/folder/wikilink/property+value) → "lex" sub-query.
 *   - Optional free-text `query` → "vec" sub-query.
 *   - Optional `semanticSearches` (oms_retrieve_context only) → typed sub-queries.
 *
 * The facade calls dispatch() on the combined list and maps results back through
 * retrievalResultsToAxisResult.
 *
 * R18: NO import from src/search.
 */

import type { TypedSubQuery, RetrievalResult } from "../types.js";
import type {
  McpAxisFilters,
  McpRetrieveContextOptions,
  McpSemanticSearchHit,
  McpSemanticQueryResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Request mappers
// ---------------------------------------------------------------------------

/**
 * Map McpAxisFilters (oms_retrieve_by_axis) → TypedSubQuery[].
 *
 * Axis filters are composed into a single "lex" query string; the optional
 * free-text `query` adds a "vec" sub-query for semantic ranking.
 */
export function axisFiltersToSubQueries(filters: McpAxisFilters): TypedSubQuery[] {
  const parts: string[] = [];
  if (filters.concept !== undefined && filters.concept.length > 0) {
    parts.push(`concept:${filters.concept}`);
  }
  if (filters.folder !== undefined && filters.folder.length > 0) {
    parts.push(`folder:${filters.folder}`);
  }
  if (filters.wikilink !== undefined && filters.wikilink.length > 0) {
    parts.push(`wikilink:${filters.wikilink}`);
  }
  if (
    filters.property !== undefined &&
    filters.property.length > 0 &&
    filters.value !== undefined &&
    filters.value.length > 0
  ) {
    parts.push(`${filters.property}:${filters.value}`);
  }

  const subQueries: TypedSubQuery[] = [];

  if (parts.length > 0) {
    subQueries.push({ type: "lex", query: parts.join(" ") });
  }

  if (filters.query !== undefined && filters.query.length > 0) {
    subQueries.push({ type: "vec", query: filters.query });
  }

  // Fallback: if no axis parts but a free-text query exists, lex-search on it.
  if (subQueries.length === 0 && filters.query !== undefined && filters.query.length > 0) {
    subQueries.push({ type: "lex", query: filters.query });
  }

  return subQueries;
}

/**
 * Map McpRetrieveContextOptions (oms_retrieve_context) → TypedSubQuery[].
 *
 * Extends axisFiltersToSubQueries with optional semanticSearches fan-out.
 * Deduplicates by keeping the order: axis-lex → axis-vec → semantic.
 */
export function retrieveContextToSubQueries(opts: McpRetrieveContextOptions): TypedSubQuery[] {
  const base = axisFiltersToSubQueries(opts);

  if (opts.semanticSearches === undefined || opts.semanticSearches.length === 0) {
    return base;
  }

  const semantic = opts.semanticSearches.map((s): TypedSubQuery => ({
    type: s.type,
    query: s.query,
  }));

  return [...base, ...semantic];
}

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

/**
 * Map engine RetrievalResult[] → McpSemanticQueryResult for axis retrieve ops.
 *
 * Shares the same shape as the query-mapper response, but limit is applied
 * directly (no minScore on axis ops — axis narrowing already constrains set).
 */
export function retrievalResultsToAxisResult(
  results: readonly RetrievalResult[],
  limit?: number,
): McpSemanticQueryResult {
  const hits: readonly RetrievalResult[] =
    limit !== undefined ? results.slice(0, limit) : results;

  const searchHits: McpSemanticSearchHit[] = hits.map((r): McpSemanticSearchHit => ({
    docid: r.docPath,
    score: r.score,
    uri: `vault://${r.docPath}`,
    path: r.docPath,
    snippet: "",
    evidence: {
      lexical: (r.perTypeScores?.["lex"] ?? 0) > 0,
      vector:
        (r.perTypeScores?.["vec"] ?? 0) > 0 || (r.perTypeScores?.["hyde"] ?? 0) > 0,
    },
  }));

  return { available: true, hits: searchHits };
}
