/**
 * Reciprocal Rank Fusion (RRF) — k=60 standard implementation.
 *
 * Algorithm (idea-only, no verbatim code):
 *   nashsu/llm_wiki (GPL-3.0) — RRF weight schedule concept.
 *   MS GraphRAG technical report — k=60 default calibration.
 *
 * Formula: score(d) = Σ_i  1 / (k + rank_i(d))
 * where rank_i(d) is the 1-based position of document d in list i.
 * Documents absent from a list contribute 0 for that list.
 */

import type { ScoredHit } from "../types.js";

/**
 * Fuse multiple ranked lists into a single list using Reciprocal Rank Fusion.
 *
 * @param rankedLists - Per-modality ranked hit lists. Each inner list need not be
 *   pre-sorted unless `preserveInputOrder` is enabled.
 * @param k - RRF smoothing constant (default 60). Higher values reduce the impact
 *   of rank position; typical range is 50–70.
 * @param options - Ranking behavior for each input list.
 * @returns Fused list sorted descending by RRF score. Ties are broken
 *   lexicographically by the composite key `"docPath\0chunkOrdinal"`.
 */
export interface FuseRRFOptions {
  /**
   * Treat each list as already ranked and use its supplied order. This is
   * required when a caller has established rank with a non-score policy.
   */
  preserveInputOrder?: boolean;
}

function validateRrfInputs(
  rankedLists: ScoredHit[][],
  k: number,
  options: FuseRRFOptions,
): void {
  if (!Array.isArray(rankedLists)) {
    throw new Error("RRF ranked lists must be an array.");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("RRF options must be an object.");
  }
  if (!Number.isFinite(k) || k < 0) {
    throw new Error("RRF smoothing constant k must be a finite non-negative number.");
  }
  if (typeof options.preserveInputOrder !== "undefined" && typeof options.preserveInputOrder !== "boolean") {
    throw new Error("RRF preserveInputOrder must be a boolean.");
  }
  for (const list of rankedLists) {
    if (!Array.isArray(list)) {
      throw new Error("RRF ranked lists must be arrays of scored hits.");
    }
    for (const hit of list) {
      if (
        hit === null ||
        typeof hit !== "object" ||
        typeof hit.docPath !== "string" ||
        hit.docPath.trim().length === 0 ||
        !Number.isSafeInteger(hit.chunkOrdinal) ||
        hit.chunkOrdinal < 0 ||
        !Number.isFinite(hit.score)
      ) {
        throw new Error("RRF scored hits must have a non-empty path, non-negative ordinal, and finite score.");
      }
    }
  }
}

export function fuseRRF(
  rankedLists: ScoredHit[][],
  k = 60,
  options: FuseRRFOptions = {},
): ScoredHit[] {
  validateRrfInputs(rankedLists, k, options);
  if (rankedLists.length === 0) return [];

  // key → { accumulated RRF score, original hit metadata }
  const accum = new Map<string, { score: number; hit: ScoredHit }>();

  for (const list of rankedLists) {
    if (list.length === 0) continue;

    // Dispatch policies may establish rank independently of raw score. In that
    // case, preserve the caller's order rather than replacing it here.
    const sorted = options.preserveInputOrder
      ? list
      : [...list].sort(
          (a, b) =>
            b.score - a.score ||
            a.docPath.localeCompare(b.docPath) ||
            a.chunkOrdinal - b.chunkOrdinal,
        );

    for (let idx = 0; idx < sorted.length; idx++) {
      const hit = sorted[idx]!;
      const key = `${hit.docPath}\x00${hit.chunkOrdinal}`;
      // idx is 0-based; rank is 1-based → 1/(k + idx + 1)
      const contribution = 1 / (k + idx + 1);
      const existing = accum.get(key);
      if (existing !== undefined) {
        existing.score += contribution;
      } else {
        accum.set(key, { score: contribution, hit });
      }
    }
  }

  return [...accum.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.hit.docPath}\x00${a.hit.chunkOrdinal}`.localeCompare(
          `${b.hit.docPath}\x00${b.hit.chunkOrdinal}`,
        ),
    )
    .map(({ score, hit }) => ({ ...hit, score }));
}
