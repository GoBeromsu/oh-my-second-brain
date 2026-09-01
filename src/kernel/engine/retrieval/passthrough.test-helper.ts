/**
 * TEST-ONLY passthrough reranker.
 *
 * This file MUST NOT be imported by any production (non-test) module.
 *
 * It used to live in the production retrieval barrel, exported as the "default
 * no-op reranker". That made a fake capability reachable as a real one: the MCP
 * facade decides reranking is available by checking only whether a reranker is
 * defined, so injecting this one made an explicit `rerank: true` request report
 * **success** while returning the unchanged RRF order. The caller asked for
 * cross-encoder precision and was told it happened when it had not — the
 * "passthrough presented as success" that ADR-007's no-fake-fallback rule and the
 * approved model-capability plan both forbid.
 *
 * It survives here because tests legitimately need a `Reranker` that reorders
 * nothing: asserting that `retrieve()` preserves fused order, or that a caller-
 * owned reranker is never disposed by assembly, requires an inert implementation.
 * Production code must instead leave the reranker absent, which makes an explicit
 * rerank request fail loudly with its configuration remedy.
 *
 * Import from test files only.
 */

import type { ScoredHit } from "../types.js";
import type { Reranker } from "./reranker.js";

/** Returns hits unchanged, preserving RRF-fused order and scores. */
export class PassthroughReranker implements Reranker {
  async rerank(
    _query: string,
    hits: ScoredHit[],
    cancel?: { readonly cancelled: boolean },
  ): Promise<ScoredHit[]> {
    // Cancellation is still honoured: a cancelled retrieval must not look like a
    // successful no-op rerank.
    if (cancel?.cancelled) throw new Error("Retrieval cancelled");
    return hits;
  }
}

/** Shared inert instance — safe to reuse across test calls. */
export const passthroughReranker: Reranker = new PassthroughReranker();
