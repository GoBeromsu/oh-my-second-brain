import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import type { McpSemanticQueryResult, McpSemanticTypedSearch } from "../engine/mcp/types.js";
import type { SearchBackend, SearchRequest } from "./search-backend.js";

/** Raised when a request violates the query-XOR-searches contract. */
export class InvalidSearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSearchRequestError";
  }
}

/**
 * Expand a plain query into typed sub-queries.
 *
 * A caller who sends plain text has not chosen a retrieval strategy, so the
 * backend picks lexical, which needs no model and no configuration.
 *
 * Vector retrieval is deliberately NOT added for an unspecified query. An
 * explicit `vsearch` mode is converted to the same `vec` sub-query as every
 * other explicit vector spelling. Measured behaviour: a query containing a
 * `vec` sub-query returns `available: false` with
 * "graph-only engine: embedding provider unavailable. Configure embeddings via
 * OMS_EMBEDDING_PROVIDER + OMS_EMBEDDING_MODEL..." whenever no provider is
 * configured. That is ADR-007's permanently-locked no-fake-fallback rule doing
 * its job, and it is the correct answer to an explicit request for vector
 * search. It is the wrong answer to "find me something" - silently expanding a
 * plain query into a strategy the deployment cannot run would convert a
 * perfectly good lexical answer into a failure.
 *
 * Probing status first was tried and rejected: `semanticStatus()` reports
 * `available: true` for a graph-only engine because the STORE is available,
 * while `models.embedding` reads `deferred:graph-only`. Keying expansion off
 * that string would be a heuristic on a diagnostic message.
 *
 * So: plain query means "answer with what is configured"; an explicit `vec`
 * sub-query means "I want vector search" and fails loudly when it cannot run.
 */
function expandPlainQuery(
  query: string,
  mode: SearchRequest["mode"],
): readonly McpSemanticTypedSearch[] {
  return [{ type: mode === "vsearch" ? "vec" : "lex", query }];
}

/**
 * Did the caller explicitly ask for a strategy that needs embeddings?
 *
 * Every signal is considered here, not just the one that happened to be
 * inspected at the call site. A caller can express vector intent through a
 * typed sub-search, through `mode`, or through the `vec`/`hyde` shorthands, and
 * a per-signal check leaves whichever one it forgot silently answering with
 * lexical results. That has now happened twice: first `mode: "vsearch"` was
 * missed entirely, then it was honoured only on the plain-query path and
 * ignored when `searches` was also supplied. One decision point, all signals.
 */
export function requiresEmbeddings(request: {
  readonly searches?: readonly McpSemanticTypedSearch[];
  readonly mode?: SearchRequest["mode"];
  readonly vec?: string;
  readonly hyde?: string;
}): boolean {
  if (request.mode === "vsearch") return true;
  if (typeof request.vec === "string" && request.vec.length > 0) return true;
  if (typeof request.hyde === "string" && request.hyde.length > 0) return true;
  return (request.searches ?? []).some((search) => search.type === "vec" || search.type === "hyde");
}

/** SearchBackend adapter for the in-repository OMS engine. */
export class EngineSearchBackend implements SearchBackend {
  constructor(
    private readonly adapterOrResolver: McpEngineAdapter | ((requiresEmbeddings: boolean) => McpEngineAdapter),
    private readonly vault: string,
  ) {}

  async search(request: SearchRequest): Promise<McpSemanticQueryResult> {
    // The XOR lives in the type, but a request parsed from JSON at the MCP
    // boundary is unchecked, so it has to be enforced here as well.
    const hasQuery = typeof request.query === "string" && request.query.trim().length > 0;
    const hasSearches = Array.isArray(request.searches) && request.searches.length > 0;

    if (hasQuery && hasSearches) {
      throw new InvalidSearchRequestError(
        "'query' and 'searches' are mutually exclusive; provide exactly one",
      );
    }
    if (!hasQuery && !hasSearches) {
      throw new InvalidSearchRequestError("provide either 'query' or a non-empty 'searches'");
    }

    // ANY explicit mode alongside explicit `searches` is contradictory: the
    // caller has both named a strategy and supplied its own sub-queries, and
    // one of the two has to be discarded. Refusing beats guessing.
    //
    // Scoping this to `vsearch` alone was the previous shape and it was wrong
    // twice over: it left `mode: "search"` and `mode: "query"` silently
    // dropped, and a rule that fires on one value of a field but not its
    // siblings is the kind of inconsistency that grows the next hole.
    if (hasSearches && request.mode !== undefined) {
      throw new InvalidSearchRequestError(
        `'mode: ${request.mode}' and explicit 'searches' are contradictory; supply typed searches or a mode, not both`,
      );
    }

    const searches = hasSearches
      ? (request.searches as readonly McpSemanticTypedSearch[])
      : expandPlainQuery((request.query as string).trim(), request.mode);

    const adapter = typeof this.adapterOrResolver === "function"
      ? this.adapterOrResolver(requiresEmbeddings({ ...request, searches }))
      : this.adapterOrResolver;
    return adapter.semanticQuery({
      vault: this.vault,
      query: "",
      searches,
      limit: request.limit,
      minScore: request.minScore,
      intent: request.intent,
      collection: request.collection,
      mode: request.mode,
      index: request.index,
    });
  }
}
