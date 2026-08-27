import type {
  McpSemanticQueryAxes,
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
  /** Vault-relative path prefix that constrains retrieval candidates. */
  readonly collectionPath?: string;
  readonly index?: string;
  /** Opaque offset cursor returned by a previous query. */
  readonly cursor?: string;
  /** Optional model-free axis narrowing shared with the MCP facade. */
  readonly axes?: McpSemanticQueryAxes;
}

export interface NormalizedSearchRequest {
  /** Plain natural-language query retained for an optional reranker. */
  readonly query?: string;
  readonly searches: readonly McpSemanticTypedSearch[];
  readonly mode?: McpSemanticSearchMode;
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly rerank?: boolean;
  readonly minScore?: number;
  readonly intent?: string;
  readonly collection?: string;
  readonly collections: readonly string[];
  readonly collectionPath?: string;
  readonly index?: string;
  readonly cursor?: string;
  readonly axes?: McpSemanticQueryAxes;
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
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new InvalidSearchRequestError("search request must be an object");
  }
  const query = typeof request.query === "string" && request.query.trim() !== ""
    ? request.query.trim()
    : undefined;
  const hasQueryProperty = Object.prototype.hasOwnProperty.call(request, "query");
  if (request.query !== undefined && typeof request.query !== "string") {
    throw new InvalidSearchRequestError('"query" must be a string');
  }
  if (request.mode !== undefined && request.mode !== "query" && request.mode !== "search" && request.mode !== "vsearch") {
    throw new InvalidSearchRequestError(`Unknown query mode "${String(request.mode)}"`);
  }
  if (request.searches !== undefined && !Array.isArray(request.searches)) {
    throw new InvalidSearchRequestError('"searches" must be an array');
  }
  const searches = request.searches?.length
    ? request.searches.map((search) => {
      if (
        search === null ||
        typeof search !== "object" ||
        (search.type !== "lex" && search.type !== "vec" && search.type !== "hyde") ||
        typeof search.query !== "string"
      ) {
        throw new InvalidSearchRequestError(
          'Each "searches" item must contain a lex, vec, or hyde type and string query',
        );
      }
      return search;
    })
    : [];
  const shorthands = searchTypes.flatMap((type) => {
    const value = request[type];
    if (value !== undefined && typeof value !== "string") {
      throw new InvalidSearchRequestError(`"${type}" must be a string`);
    }
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
    // An explicit empty query is the portable overview spelling. Keep a
    // missing property invalid so malformed SearchBackend calls still fail
    // loudly while MCP/CLI can intentionally request an overview.
    if (!hasQueryProperty) {
      throw new InvalidSearchRequestError("provide either 'query' or a non-empty typed search");
    }
  }
  if (request.mode !== undefined && query === undefined) {
    throw new InvalidSearchRequestError("'mode' requires a plain 'query'");
  }

  if (request.collections !== undefined && !Array.isArray(request.collections)) {
    throw new InvalidSearchRequestError('"collections" must be an array');
  }
  const collections = [...new Set(
    (request.collections ?? [])
      .map((collection) => {
        if (typeof collection !== "string") {
          throw new InvalidSearchRequestError('"collections" items must be strings');
        }
        return collection;
      })
      .map((collection) => collection.trim())
      .filter((collection) => collection !== ""),
  )];
  if (request.limit !== undefined && (!Number.isFinite(request.limit) || request.limit < 0)) {
    throw new InvalidSearchRequestError('"limit" must be a finite non-negative number');
  }
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== "string" || (request.cursor !== "" && !/^\d+$/u.test(request.cursor))) {
      throw new InvalidSearchRequestError('"cursor" must be a non-negative integer offset');
    }
    if (request.cursor !== "" && !Number.isSafeInteger(Number(request.cursor))) {
      throw new InvalidSearchRequestError('"cursor" must be a safe integer offset');
    }
  }
  return {
    query,
    searches: hasExplicitSearches
      ? [...searches, ...shorthands]
      : query === undefined
        ? []
        : request.mode === "vsearch"
          ? [{ type: "vec", query }]
          : request.mode === "query" || request.mode === "search"
            ? [{ type: "lex", query }, { type: "vec", query }]
            : [{ type: "lex", query }],
    mode: request.mode,
    limit: request.limit ?? 10,
    candidateLimit: request.candidateLimit,
    rerank: request.rerank ?? false,
    minScore: request.minScore ?? 0,
    intent: request.intent,
    collection: request.collection,
    collections,
    collectionPath: request.collectionPath,
    index: request.index,
    cursor: request.cursor,
    axes: request.axes,
  };
}

/** The portable search capability exposed by an OMS retrieval backend. */
export interface SearchBackend {
  search(request: SearchRequest): Promise<McpSemanticQueryResult>;
}
