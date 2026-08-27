import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import type {
  McpSemanticFacet,
  McpSemanticQueryResult,
  McpSemanticReceipt,
  McpSemanticSearchHit,
  McpSemanticTypedSearch,
} from "../engine/mcp/types.js";
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
    // Typed searches have no plain `query`, but their text is still the caller's
    // retrieval intent. Preserve it for an explicitly requested reranker.
    const rerankQuery = normalized.query ?? normalized.searches.map((search) => search.query).join(" ");
    const searchCollection = async (
      collectionPath = normalized.collectionPath,
    ): Promise<McpSemanticQueryResult> => adapter.semanticQuery({
      vault: this.vault,
      query: rerankQuery,
      searches: normalized.searches,
      mode: normalized.mode,
      // Collection aggregation applies one global limit after all candidate
      // collections have been merged. Per-collection truncation would make
      // totalCount/cursor and facet counts dependent on collection order.
      limit: normalized.collections.length === 0 ? normalized.limit : undefined,
      candidateLimit: normalized.candidateLimit,
      minScore: normalized.minScore,
      intent: normalized.intent,
      collection: normalized.collection,
      collectionPath,
      index: normalized.index,
      rerank: normalized.rerank,
      cursor: normalized.collections.length === 0 ? normalized.cursor : undefined,
      axes: normalized.axes,
    });

    if (normalized.collections.length === 0) {
      return searchCollection();
    }

    const results = await Promise.all(normalized.collections.map(searchCollection));
    const unavailable = results.find((result) => !result.available);
    if (unavailable !== undefined) {
      return {
        ...unavailable,
        hits: unavailable.hits ?? [],
        totalCount: unavailable.totalCount ?? 0,
        facets: unavailable.facets ?? [],
        cursor: unavailable.cursor ?? null,
        receipt: unavailable.receipt ?? { usedChannels: [], approximated: false, drift: false },
        ...(normalized.intent === undefined && unavailable.intent === undefined
          ? {}
          : { intent: normalized.intent ?? unavailable.intent }),
      };
    }
    const hits = dedupeDocumentHits(results.flatMap((result) => result.hits))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const totalCount = hits.length;
    const limit = normalized.limit;
    const offset = decodeCursor(normalized.cursor);
    const page = limit === undefined ? hits.slice(offset) : hits.slice(offset, offset + Math.max(0, limit));
    const facets = mergeFacets(results);
    const receipt = mergeReceipts(results);
    const intent = normalized.intent ?? results.find((result) => result.intent !== undefined)?.intent;
    const nextOffset = offset + page.length;
    return {
      available: true,
      hits: page,
      totalCount,
      facets,
      cursor: nextOffset < totalCount ? String(nextOffset) : null,
      ...(intent === undefined ? {} : { intent }),
      receipt,
    };
  }
}

function dedupeDocumentHits(hits: readonly McpSemanticSearchHit[]): McpSemanticSearchHit[] {
  const byPath = new Map<string, McpSemanticSearchHit>();
  for (const hit of hits) {
    const prior = byPath.get(hit.path);
    if (prior === undefined) {
      byPath.set(hit.path, hit);
      continue;
    }
    const preferred = hit.score > prior.score ? hit : prior;
    const secondary = preferred === hit ? prior : hit;
    byPath.set(hit.path, {
      ...preferred,
      evidence: {
        lexical: preferred.evidence.lexical || secondary.evidence.lexical,
        vector: preferred.evidence.vector || secondary.evidence.vector,
      },
    });
  }
  return [...byPath.values()];
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim() === "") return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : 0;
}

function mergeFacets(results: readonly McpSemanticQueryResult[]): McpSemanticFacet[] {
  const merged = new Map<string, McpSemanticFacet>();
  for (const result of results) {
    for (const facet of result.facets ?? []) {
      const key = `${facet.axis}\u0000${facet.key ?? ""}\u0000${facet.value.trim().toLocaleLowerCase()}`;
      const prior = merged.get(key);
      if (prior === undefined) {
        merged.set(key, { ...facet });
      } else {
        merged.set(key, { ...prior, count: prior.count + facet.count });
      }
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.axis.localeCompare(right.axis)
    || (left.key ?? "").localeCompare(right.key ?? "")
    || left.value.localeCompare(right.value),
  );
}

function mergeReceipts(results: readonly McpSemanticQueryResult[]): McpSemanticReceipt {
  const used = new Set<McpSemanticReceipt["usedChannels"][number]>();
  let approximated = false;
  let drift = false;
  for (const result of results) {
    for (const channel of result.receipt?.usedChannels ?? []) used.add(channel);
    approximated ||= result.receipt?.approximated ?? false;
    drift ||= result.receipt?.drift ?? false;
  }
  return { usedChannels: [...used], approximated, drift };
}
