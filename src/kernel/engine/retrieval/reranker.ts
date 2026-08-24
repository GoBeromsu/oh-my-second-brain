/**
 * Cross-encoder reranker hook.
 *
 * This module defines the Reranker interface and ships a passthrough (no-op)
 * default so the precision-mode pipeline is wired end-to-end in M1 without
 * requiring a loaded reranker model.
 *
 * Intended production implementations (inject at the integrate phase):
 *   - bge-reranker-v2-m3  (BAAI, Apache-2.0) — strong multilingual reranker,
 *     ~570 M params, load via node-llama-cpp or a local REST endpoint.
 *   - Qwen3-Reranker-0.6B (Alibaba Cloud, Apache-2.0) — lightweight reranker,
 *     good for low-latency on-device use; also loadable via node-llama-cpp.
 *
 * Wire a real impl by passing it to retrieve() as `opts.reranker`.
 */

import type { ScoredHit } from "../types.js";

/**
 * Opt-in cross-encoder reranker hook.
 *
 * A reranker receives the original query string and a candidate hit list
 * (already fused by RRF) and returns a re-scored / re-ordered list.
 * Implementations may call an external model or REST endpoint; the caller
 * awaits the result before returning the final RetrievalResult[].
 */
export interface Reranker {
  /**
   * Re-score and reorder `hits` with respect to `query`.
   *
   * @param query - The original natural-language query string.
   * @param hits  - RRF-fused candidate list, sorted descending by fused score.
   * @returns A new list sorted descending by the reranker's cross-encoder score.
   *          The returned list may be shorter than `hits` (e.g. top-k precision cut).
   */
  rerank(query: string, hits: ScoredHit[]): Promise<ScoredHit[]>;
}

/**
 * Passthrough (no-op) reranker — returns hits unchanged.
 *
 * Preserves the RRF-fused order and scores. Use this when no reranker model
 * is available or when reranking overhead is not desired.
 */
export class PassthroughReranker implements Reranker {
  async rerank(_query: string, hits: ScoredHit[]): Promise<ScoredHit[]> {
    return hits;
  }
}

/** Shared singleton passthrough instance — safe to reuse across calls. */
export const passthroughReranker: Reranker = new PassthroughReranker();
