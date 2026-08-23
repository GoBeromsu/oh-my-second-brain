import type {
  McpSemanticQueryResult,
  McpSemanticSearchMode,
  McpSemanticTypedSearch,
} from "../engine/mcp/types.js";

/**
 * Every public spelling accepted for a semantic query.
 *
 * `normalizeSearchRequest()` is the sole authority that turns this into typed
 * sub-queries before a backend is selected.
 */
export interface SearchRequest {
  readonly query?: string;
  readonly searches?: readonly McpSemanticTypedSearch[];
  readonly mode?: McpSemanticSearchMode;
  readonly lex?: string;
  readonly vec?: string;
  readonly hyde?: string;
  readonly limit?: number;
  readonly candidateLimit?: number;
  /** Apply the configured reranker (opt-in; ADR-011). */
  readonly rerank?: boolean;
  readonly minScore?: number;
  /** Context that disambiguates a query without becoming a sub-query. */
  readonly intent?: string;
  readonly collection?: string;
  readonly collections?: readonly string[];
  readonly index?: string;
}

export interface NormalizedSearchRequest {
  /** Plain natural-language query retained for an optional reranker. */
  readonly query?: string;
  readonly searches: readonly McpSemanticTypedSearch[];
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly rerank?: boolean;
  readonly minScore?: number;
  readonly intent?: string;
  readonly collection?: string;
  readonly collections: readonly string[];
  readonly index?: string;
}

export class InvalidSearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSearchRequestError";
  }
}

const searchTypes = ["lex", "vec", "hyde"] as const;

/** Normalize all public semantic-query spellings before backend selection. */
export function normalizeSearchRequest(request: SearchRequest): NormalizedSearchRequest {
  const query = typeof request.query === "string" && request.query.trim() !== ""
    ? request.query.trim()
    : undefined;
  const searches = Array.isArray(request.searches) && request.searches.length > 0
    ? request.searches
    : [];
  const shorthands = searchTypes.flatMap((type) => {
    const value = request[type];
    return typeof value === "string" && value.trim() !== "" ? [{ type, query: value.trim() }] : [];
  });
  const hasExplicitSearches = searches.length > 0 || shorthands.length > 0;

  if (query !== undefined && hasExplicitSearches) {
    throw new InvalidSearchRequestError(
      "'query' and explicit typed searches are contradictory; provide one representation",
    );
  }
  if (request.mode !== undefined && hasExplicitSearches) {
    throw new InvalidSearchRequestError(
      `'mode: ${request.mode}' and explicit typed searches are contradictory; supply typed searches or a mode, not both`,
    );
  }
  if (query === undefined && !hasExplicitSearches) {
    throw new InvalidSearchRequestError("provide either 'query' or a non-empty typed search");
  }
  if (request.mode !== undefined && query === undefined) {
    throw new InvalidSearchRequestError("'mode' requires a plain 'query'");
  }

  const collections = (request.collections ?? []).filter((collection) => collection.trim() !== "");
  return {
    query,
    searches: hasExplicitSearches
      ? [...searches, ...shorthands]
      : [{ type: request.mode === "vsearch" ? "vec" : "lex", query: query! }],
    limit: request.limit ?? 10,
    candidateLimit: request.candidateLimit,
    rerank: request.rerank ?? false,
    minScore: request.minScore ?? 0,
    intent: request.intent,
    collection: request.collection,
    collections,
    index: request.index,
  };
}

/** The portable search capability exposed by an OMS retrieval backend. */
export interface SearchBackend {
  search(request: SearchRequest): Promise<McpSemanticQueryResult>;
}
