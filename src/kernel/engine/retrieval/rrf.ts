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
 *   pre-sorted; fuseRRF sorts each list descending by score before ranking.
 * @param k - RRF smoothing constant (default 60). Higher values reduce the impact
 *   of rank position; typical range is 50–70.
 * @returns Fused list sorted descending by RRF score. Ties are broken
 *   lexicographically by the composite key `"docPath\0chunkOrdinal"`.
 */
export function fuseRRF(rankedLists: ScoredHit[][], k = 60): ScoredHit[] {
  if (rankedLists.length === 0) return [];

  // key → { accumulated RRF score, original hit metadata }
  const accum = new Map<string, { score: number; hit: ScoredHit }>();

  for (const list of rankedLists) {
    if (list.length === 0) continue;

    // Sort descending by score; secondary lex sort ensures deterministic ranking
    // when two hits in the same list have the same score.
    const sorted = [...list].sort(
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
