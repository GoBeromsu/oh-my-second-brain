// Significance and confidence helpers for the Korean retrieval bench.
// Every random draw goes through a seeded generator so a report is reproducible.

/**
 * mulberry32: a small 32-bit seeded PRNG returning floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {readonly number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Two-sided paired randomization (sign-flip) test on per-query scores.
 * Each permutation flips the sign of every paired difference with probability 1/2.
 * The p-value uses the (count + 1) / (permutations + 1) correction, so it is never 0.
 * @param {readonly number[]} baseline
 * @param {readonly number[]} candidate
 * @param {{ permutations?: number, seed?: number }} [options]
 * @returns {{ meanDiff: number, pValue: number, permutations: number }}
 */
export function pairedRandomizationTest(baseline, candidate, options = {}) {
  if (baseline.length !== candidate.length) throw new Error("paired samples must have equal length");
  if (baseline.length === 0) throw new Error("paired samples must not be empty");
  const permutations = options.permutations ?? 10_000;
  const random = seededRandom(options.seed ?? 1);
  const diffs = baseline.map((value, index) => candidate[index] - value);
  const observed = mean(diffs);
  const threshold = Math.abs(observed) - 1e-12;
  let extreme = 0;
  for (let round = 0; round < permutations; round += 1) {
    let sum = 0;
    for (const diff of diffs) sum += random() < 0.5 ? -diff : diff;
    if (Math.abs(sum / diffs.length) >= threshold) extreme += 1;
  }
  return { meanDiff: observed, pValue: (extreme + 1) / (permutations + 1), permutations };
}

/**
 * Percentile bootstrap confidence interval of the mean.
 * @param {readonly number[]} values
 * @param {{ resamples?: number, alpha?: number, seed?: number }} [options]
 * @returns {{ mean: number, lower: number, upper: number }}
 */
export function bootstrapMeanCI(values, options = {}) {
  if (values.length === 0) throw new Error("bootstrap sample must not be empty");
  const resamples = options.resamples ?? 10_000;
  const alpha = options.alpha ?? 0.05;
  const random = seededRandom(options.seed ?? 1);
  /** @type {number[]} */
  const means = [];
  for (let round = 0; round < resamples; round += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const at = (/** @type {number} */ q) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  return { mean: mean(values), lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}
