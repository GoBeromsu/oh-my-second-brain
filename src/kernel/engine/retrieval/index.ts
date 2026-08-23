/**
 * Retrieval pipeline barrel.
 *
 * Public surface exposed to the integrate phase:
 *   - retrieve()   — top-level entrypoint (dispatch → optional rerank)
 *   - fuseRRF()    — RRF fusion (useful standalone)
 *   - Reranker     — cross-encoder hook interface
 *   - passthroughReranker — default no-op reranker
 *   - CancelToken / createCancelToken — cancellation primitives
 *   - DispatcherDeps — dependency-injection bag for backends
 */

export { fuseRRF } from "./rrf.js";
export type { Reranker } from "./reranker.js";
export { PassthroughReranker, passthroughReranker } from "./reranker.js";
export {
  dispatch,
  createCancelToken,
} from "./dispatcher.js";
export type { CancelToken, DispatcherDeps, HydeGenerator } from "./dispatcher.js";

import type { RetrievalResult, ScoredHit } from "../types.js";
import { dispatch } from "./dispatcher.js";
import type { CancelToken, DispatcherDeps } from "./dispatcher.js";
import type { Reranker } from "./reranker.js";
import type { TypedSubQuery } from "../types.js";

// ---------------------------------------------------------------------------
// Top-level retrieve() entrypoint
// ---------------------------------------------------------------------------

/** Options for the top-level retrieve() call. */
export interface RetrieveOptions {
  /** One or more typed sub-queries to fan out across retrieval modalities. */
  subQueries: TypedSubQuery[];
  /** Injected backend dependencies (store, embed, optional graph + HyDE). */
  deps: DispatcherDeps;
  /** Number of candidate hits to request from each backend (default 10). */
  k?: number;
  /**
   * Optional cross-encoder reranker.
   * When provided, the fused RRF list is re-scored before returning.
   * Defaults to passthrough (no reranking) when absent.
   */
  reranker?: Reranker;
  /**
   * Natural-language query string passed to the reranker.
   * Required when `reranker` is supplied; ignored otherwise.
   */
  query?: string;
  /** Optional cancel token to abort in-flight retrieval. */
  cancel?: CancelToken;
}

/**
 * Execute a hybrid retrieval query and return a ranked result list.
 *
 * Pipeline:
 *   1. Fan-out: each TypedSubQuery is dispatched to its backend in parallel.
 *   2. Fuse:    per-type ranked lists are merged via RRF (k=60 default).
 *   3. Boost:   provenance-grade signal lifts authored > curated > external-raw.
 *   4. Rerank:  optional cross-encoder reranker re-scores the fused list.
 *
 * @param opts - Retrieval options including sub-queries, deps, and optional reranker.
 * @returns Ranked RetrievalResult[] sorted descending by final score.
 */
export async function retrieve(opts: RetrieveOptions): Promise<RetrievalResult[]> {
  // Step 1–3: dispatch + RRF fusion + provenance boost
  const results = await dispatch(opts.subQueries, opts.deps, opts.k, opts.cancel);

  // Step 4: optional cross-encoder reranking
  if (!opts.reranker) return results;

  // Convert document-level results to ScoredHit[] for the reranker interface
  const hits: ScoredHit[] = results.map((r) => ({
    docPath: r.docPath,
    chunkOrdinal: 0,
    score: r.score,
  }));

  const reranked = await opts.reranker.rerank(opts.query ?? "", hits);

  // Reconstruct RetrievalResult[] in the reranker's order with new scores
  const resultByPath = new Map(results.map((r) => [r.docPath, r]));
  return reranked
    .map((hit) => {
      const base = resultByPath.get(hit.docPath);
      if (base === undefined) return undefined;
      return { ...base, score: hit.score } satisfies RetrievalResult;
    })
    .filter((r): r is RetrievalResult => r !== undefined);
}
