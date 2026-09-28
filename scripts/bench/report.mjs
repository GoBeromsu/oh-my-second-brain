// Aggregate-only bench reports. A report carries query ids, query types, and
// numbers. It never carries query text, document paths, or vault paths, so a
// tier-3 report built from a private vault is safe to paste into an issue.

import { aggregate } from "./metrics.mjs";
import { bootstrapMeanCI, pairedRandomizationTest } from "./stats.mjs";

export const REPORT_SCHEMA = "oms-ko-bench/1";

/** Per-query metrics compared between channels. */
export const COMPARED_METRICS = /** @type {const} */ (["r5", "mrr", "ndcg10"]);

/**
 * @typedef {import("./metrics.mjs").QueryMetrics} QueryMetrics
 * @typedef {{ id: string, type: string, metrics: QueryMetrics, latencyMs: number }} QueryRun
 * @typedef {{ label: string, runs: readonly QueryRun[] }} ChannelRun
 */

/**
 * @param {readonly QueryRun[]} runs
 * @returns {{ overall: Record<string, number>, byType: Record<string, Record<string, number>> }}
 */
function summarize(runs) {
  /** @type {Map<string, QueryRun[]>} */
  const groups = new Map();
  for (const run of runs) groups.set(run.type, [...(groups.get(run.type) ?? []), run]);
  /** @type {Record<string, Record<string, number>>} */
  const byType = {};
  for (const type of [...groups.keys()].sort()) {
    const group = groups.get(type) ?? [];
    byType[type] = aggregate(group.map((run) => run.metrics), group.map((run) => run.latencyMs));
  }
  return { overall: aggregate(runs.map((run) => run.metrics), runs.map((run) => run.latencyMs)), byType };
}

/**
 * @param {readonly QueryRun[]} baseline
 * @param {readonly QueryRun[]} candidate
 * @param {string} metric
 * @param {number} seed
 * @param {number} permutations
 */
function compare(baseline, candidate, metric, seed, permutations) {
  const byId = new Map(candidate.map((run) => [run.id, run]));
  const a = [];
  const b = [];
  for (const run of baseline) {
    const other = byId.get(run.id);
    if (!other) throw new Error(`query ${run.id} is missing from the candidate channel`);
    a.push(/** @type {number} */ (run.metrics[/** @type {keyof QueryMetrics} */ (metric)]));
    b.push(/** @type {number} */ (other.metrics[/** @type {keyof QueryMetrics} */ (metric)]));
  }
  const test = pairedRandomizationTest(a, b, { seed, permutations });
  const ci = bootstrapMeanCI(
    a.map((value, index) => b[index] - value),
    { seed, resamples: permutations },
  );
  return { n: a.length, meanDiff: test.meanDiff, pValue: test.pValue, ci95: [ci.lower, ci.upper] };
}

/**
 * Builds an aggregate-only report. The first channel is the baseline every other channel is tested against.
 * @param {{ tier: number, seed: number, permutations?: number, channels: readonly ChannelRun[], skipped?: Record<string, string> }} input
 */
export function buildReport(input) {
  const permutations = input.permutations ?? 10_000;
  const [baseline, ...candidates] = input.channels;
  if (!baseline) throw new Error("a report needs at least one channel");
  /** @type {Record<string, ReturnType<typeof summarize>>} */
  const channels = {};
  for (const channel of input.channels) channels[channel.label] = summarize(channel.runs);

  const comparisons = candidates.map((candidate) => {
    /** @type {Record<string, unknown>} */
    const overall = {};
    /** @type {Record<string, Record<string, unknown>>} */
    const byType = {};
    for (const metric of COMPARED_METRICS) {
      overall[metric] = compare(baseline.runs, candidate.runs, metric, input.seed, permutations);
    }
    const types = [...new Set(baseline.runs.map((run) => run.type))].sort();
    for (const type of types) {
      byType[type] = {};
      const base = baseline.runs.filter((run) => run.type === type);
      const cand = candidate.runs.filter((run) => run.type === type);
      for (const metric of COMPARED_METRICS) byType[type][metric] = compare(base, cand, metric, input.seed, permutations);
    }
    return { baseline: baseline.label, candidate: candidate.label, overall, byType };
  });

  const perQuery = Object.fromEntries(input.channels.map((channel) => [
    channel.label,
    channel.runs.map((run) => ({
      id: run.id,
      type: run.type,
      r5: run.metrics.r5,
      mrr: run.metrics.mrr,
      ndcg10: run.metrics.ndcg10,
      hitAtExpectedK: run.metrics.hitAtExpectedK,
    })),
  ]));

  return {
    schema: REPORT_SCHEMA,
    tier: input.tier,
    seed: input.seed,
    permutations,
    queryCount: baseline.runs.length,
    channels,
    comparisons,
    perQuery,
    skipped: input.skipped ?? {},
  };
}

/**
 * @param {unknown} value
 * @param {(text: string) => void} visit
 */
function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      walkStrings(item, visit);
    }
  }
}

// Below this length a substring check is unreliable: a 1-2 character tier-3
// query (a single Korean syllable, say) can match inside an unrelated word
// that happens to share those characters, which fails closed but is a
// false positive. Below the threshold we only flag an exact value match
// (the whole JSON string equals the query), which is what a real leak of a
// short query looks like in an aggregate-only report; at or above it, the
// existing substring check still fails closed on any leak.
const MIN_SUBSTRING_LEAK_LENGTH = 3;

/**
 * Throws when a report leaks query text, a document path, or an absolute path.
 * @param {unknown} report
 * @param {{ queryTexts: readonly string[] }} context
 */
export function assertReportPrivacy(report, context) {
  const texts = context.queryTexts.map((text) => text.normalize("NFC")).filter((text) => text.length > 0);
  walkStrings(report, (raw) => {
    const value = raw.normalize("NFC");
    if (/\.md\b/i.test(value)) throw new Error("report leaks a document path");
    if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) {
      throw new Error("report leaks an absolute path");
    }
    for (const text of texts) {
      if (value === text) throw new Error("report leaks query text");
      if (text.length >= MIN_SUBSTRING_LEAK_LENGTH && value.includes(text)) throw new Error("report leaks query text");
    }
  });
}

/**
 * @param {number} value
 */
function fmt(value) {
  return value.toFixed(3);
}

/**
 * Markdown tables for docs/measurements. Aggregates only.
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function formatMarkdown(report) {
  const lines = [];
  const labels = Object.keys(report.channels);
  lines.push("| Type | Channel | n | R@1 | R@3 | R@5 | MRR | nDCG@10 | P@5 | p50 ms | p95 ms |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const types = ["overall", ...Object.keys(report.channels[labels[0]].byType)];
  for (const type of types) {
    for (const label of labels) {
      const row = type === "overall" ? report.channels[label].overall : report.channels[label].byType[type];
      lines.push(`| ${type} | ${label} | ${row.n} | ${fmt(row.r1)} | ${fmt(row.r3)} | ${fmt(row.r5)} | ${fmt(row.mrr)} | ${fmt(row.ndcg10)} | ${fmt(row.p5)} | ${row.p50Ms?.toFixed(1) ?? "-"} | ${row.p95Ms?.toFixed(1) ?? "-"} |`);
    }
  }
  for (const comparison of report.comparisons) {
    lines.push("");
    lines.push(`Paired randomization, ${comparison.candidate} vs ${comparison.baseline} (${report.permutations} permutations, seed ${report.seed}):`);
    lines.push("");
    lines.push("| Type | ΔR@5 | p | ΔMRR | p | ΔnDCG@10 | p |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    const rows = [["overall", comparison.overall], ...Object.entries(comparison.byType)];
    for (const [type, cells] of rows) {
      const c = /** @type {Record<string, { meanDiff: number, pValue: number }>} */ (cells);
      lines.push(`| ${type} | ${fmt(c.r5.meanDiff)} | ${fmt(c.r5.pValue)} | ${fmt(c.mrr.meanDiff)} | ${fmt(c.mrr.pValue)} | ${fmt(c.ndcg10.meanDiff)} | ${fmt(c.ndcg10.pValue)} |`);
    }
  }
  return lines.join("\n");
}
