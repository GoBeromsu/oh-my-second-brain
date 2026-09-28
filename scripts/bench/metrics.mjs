// Retrieval metrics for the Korean retrieval bench. Pure functions, no I/O.
//
// Relevance is binary: a result is relevant when its path is in `expected`.
// `ranked` holds distinct document paths, best first. Paths are compared after
// NFC normalization, because the ko-vault holds one NFD filename on disk.

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizePath(value) {
  return value.normalize("NFC").replace(/\\/g, "/");
}

/**
 * Drops repeated paths (several chunks of one note) and keeps the first rank.
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function dedupeRanked(paths) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of paths) {
    const docPath = normalizePath(raw);
    if (seen.has(docPath)) continue;
    seen.add(docPath);
    out.push(docPath);
  }
  return out;
}

/**
 * @param {readonly string[]} expected
 * @returns {Set<string>}
 */
function relevantSet(expected) {
  return new Set(expected.map(normalizePath));
}

/**
 * @param {number} k
 */
function assertK(k) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
}

/**
 * Fraction of relevant documents found in the top k.
 * @param {readonly string[]} ranked
 * @param {readonly string[]} expected
 * @param {number} k
 * @returns {number}
 */
export function recallAtK(ranked, expected, k) {
  assertK(k);
  const relevant = relevantSet(expected);
  if (relevant.size === 0) return 0;
  const hits = ranked.slice(0, k).filter((docPath) => relevant.has(normalizePath(docPath))).length;
  return hits / relevant.size;
}

/**
 * Fraction of the top k slots that hold a relevant document.
 * @param {readonly string[]} ranked
 * @param {readonly string[]} expected
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(ranked, expected, k) {
  assertK(k);
  const relevant = relevantSet(expected);
  const hits = ranked.slice(0, k).filter((docPath) => relevant.has(normalizePath(docPath))).length;
  return hits / k;
}

/**
 * Reciprocal rank of the first relevant document, 0 when none is ranked.
 * @param {readonly string[]} ranked
 * @param {readonly string[]} expected
 * @returns {number}
 */
export function reciprocalRank(ranked, expected) {
  const relevant = relevantSet(expected);
  const index = ranked.findIndex((docPath) => relevant.has(normalizePath(docPath)));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Binary-relevance nDCG at k.
 * @param {readonly string[]} ranked
 * @param {readonly string[]} expected
 * @param {number} k
 * @returns {number}
 */
export function ndcgAtK(ranked, expected, k) {
  assertK(k);
  const relevant = relevantSet(expected);
  if (relevant.size === 0) return 0;
  let dcg = 0;
  ranked.slice(0, k).forEach((docPath, index) => {
    if (relevant.has(normalizePath(docPath))) dcg += 1 / Math.log2(index + 2);
  });
  let ideal = 0;
  for (let index = 0; index < Math.min(relevant.size, k); index += 1) ideal += 1 / Math.log2(index + 2);
  return dcg / ideal;
}

/**
 * Nearest-rank percentile, matching scripts/bench/latency-baseline.mjs.
 * @param {readonly number[]} values
 * @param {number} p
 * @returns {number}
 */
export function percentile(values, p) {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * @typedef {object} QueryMetrics
 * @property {number} r1
 * @property {number} r3
 * @property {number} r5
 * @property {number} p1
 * @property {number} p3
 * @property {number} p5
 * @property {number} mrr
 * @property {number} ndcg10
 * @property {boolean} hitAtExpectedK true when a relevant doc sits within the query's expected_in_top_k
 */

/** Metric keys that are averaged across queries. */
export const METRIC_KEYS = /** @type {const} */ (["r1", "r3", "r5", "p1", "p3", "p5", "mrr", "ndcg10"]);

/**
 * @param {readonly string[]} rankedPaths raw result paths, best first; repeats are removed
 * @param {readonly string[]} expected
 * @param {number} expectedInTopK
 * @returns {QueryMetrics}
 */
export function scoreQuery(rankedPaths, expected, expectedInTopK) {
  const ranked = dedupeRanked(rankedPaths);
  return {
    r1: recallAtK(ranked, expected, 1),
    r3: recallAtK(ranked, expected, 3),
    r5: recallAtK(ranked, expected, 5),
    p1: precisionAtK(ranked, expected, 1),
    p3: precisionAtK(ranked, expected, 3),
    p5: precisionAtK(ranked, expected, 5),
    mrr: reciprocalRank(ranked, expected),
    ndcg10: ndcgAtK(ranked, expected, 10),
    hitAtExpectedK: recallAtK(ranked, expected, expectedInTopK) > 0,
  };
}

/**
 * Mean of each metric plus latency percentiles.
 * @param {readonly QueryMetrics[]} rows
 * @param {readonly number[]} latenciesMs
 * @returns {Record<string, number>}
 */
export function aggregate(rows, latenciesMs) {
  /** @type {Record<string, number>} */
  const out = { n: rows.length };
  for (const key of METRIC_KEYS) {
    out[key] = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  }
  out.hitRate = rows.length === 0 ? 0 : rows.filter((row) => row.hitAtExpectedK).length / rows.length;
  if (latenciesMs.length > 0) {
    out.p50Ms = percentile(latenciesMs, 50);
    out.p95Ms = percentile(latenciesMs, 95);
  }
  return out;
}
