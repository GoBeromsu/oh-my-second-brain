import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import type { McpSemanticQueryResult, McpSemanticTypedSearch } from "../engine/mcp/types.js";
import { normalizeSearchRequest, type SearchBackend, type SearchRequest } from "./search-backend.js";
export { InvalidSearchRequestError } from "./search-backend.js";

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
    const normalized = normalizeSearchRequest(request);

    const adapter = typeof this.adapterOrResolver === "function"
      ? this.adapterOrResolver(requiresEmbeddings({ searches: normalized.searches }))
      : this.adapterOrResolver;
    const searchCollection = async (collectionPath?: string): Promise<McpSemanticQueryResult> => adapter.semanticQuery({
      vault: this.vault,
      query: "",
      searches: normalized.searches,
      limit: normalized.limit,
      candidateLimit: normalized.candidateLimit,
      minScore: normalized.minScore,
      intent: normalized.intent,
      collection: normalized.collection,
      collectionPath,
      index: normalized.index,
      rerank: normalized.rerank,
    });

    if (normalized.collections.length === 0) {
      return searchCollection();
    }

    const results = await Promise.all(normalized.collections.map(searchCollection));
    const unavailable = results.find((result) => !result.available);
    if (unavailable !== undefined) return unavailable;
    const hits = results.flatMap((result) => result.hits)
      .sort((left, right) => right.score - left.score);
    return {
      available: true,
      hits: normalized.limit === undefined ? hits : hits.slice(0, normalized.limit),
    };
  }
}
