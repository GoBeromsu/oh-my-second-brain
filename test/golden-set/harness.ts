/**
 * Golden-set measurement harness for the assembled production search surface.
 *
 * After the src/search teardown there is no second backend to compare against,
 * so this is an ENGINE-ONLY recall gate (previously a parity comparator vs the
 * retired src/search baseline). For each curated golden query:
 *   1. Run the assembled production adapter (offline lexical seam).
 *   2. Compute recall@10 and graded nDCG@10 from frozen qrels.
 *   3. Record latency and emit aggregate p50/p95 and seeded bootstrap CI.
 *
 * Gate rule (enforced in golden.test.ts):
 *   per-type engine recall@10 average >= floor (OMS_GOLDEN_MIN_RECALL, default 0.5)
 *   AND at least one curated query was scored (0 scored => inconclusive => fail).
 *
 * FAIL-LOUD guarantees:
 *   - Uncurated queries (curated !== true) are EXCLUDED from scoring with a
 *     visible console.warn; they are NEVER silently scored 0.
 *   - If runTracer() throws, the error propagates — never swallowed as [].
 *   - A zero or absent measurement is NOT auto-pass: "measured nothing ≠ pass".
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { runTracer, makeTracerConfig, type TracerConfig } from "../../src/kernel/engine/tracer.js";
import { assembleCoreSemanticEngine, type AssembledEngine } from "../../src/kernel/engine/assemble.js";
import { syncEngineStore } from "../../src/kernel/engine/embed/sync.js";
import { dispatch } from "../../src/kernel/engine/retrieval/dispatcher.js";
import type { Provenance, RetrievalResult } from "../../src/kernel/engine/types.js";
import {
  GOLDEN_QUERIES,
  GOLDEN_QRELS,
  GOLDEN_QUERY_CLASSES,
  validateGoldenCoverage,
  type GoldenQuery,
  type GoldenQueryClass,
  type QueryType,
} from "./queries.js";

// ---------------------------------------------------------------------------
// External golden-set loader (privacy-preserving)
// ---------------------------------------------------------------------------

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Load golden queries from OMS_GOLDEN_QUERIES env path if set,
 * otherwise fall back to the built-in synthetic GOLDEN_QUERIES.
 *
 * This allows CI to inject real-vault-backed queries without committing them.
 * 0 scored => inconclusive => fail: an empty or unresolvable path is an error.
 */
export function loadGoldenQueries(): GoldenQuery[] {
  const p = envValue("OMS_GOLDEN_QUERIES");
  if (!p) return GOLDEN_QUERIES;
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(raw)) throw new Error("OMS_GOLDEN_QUERIES at " + p + " is not a JSON array");
  for (const q of raw) {
    if (!q || typeof q.id !== "string" || !q.id.trim() ||
        typeof q.type !== "string" || typeof q.query !== "string" || !q.query.trim() ||
        !Array.isArray(q.expectedNotes) ||
        q.expectedNotes.some((docPath) => typeof docPath !== "string" || !docPath.trim()) ||
        typeof q.queryClass !== "string" ||
        !(GOLDEN_QUERY_CLASSES as readonly string[]).includes(q.queryClass) ||
        !["lex", "vec", "hyde", "graph"].includes(q.type) ||
        (q.curated !== undefined && typeof q.curated !== "boolean"))
      throw new Error("OMS_GOLDEN_QUERIES malformed row: " + JSON.stringify(q));
  }
  const queries = raw as GoldenQuery[];
  const ids = queries.map((query) => query.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("OMS_GOLDEN_QUERIES contains duplicate query ids");
  }
  validateGoldenCoverage(queries, { allowUncurated: true });
  return queries;
}

export function validateQrels(input: unknown, source = "qrels"): Qrels {
  const normalized: Record<string, Record<string, number>> = {};
  const seenRows = new Set<string>();
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== "object") throw new Error(`${source} qrel rows must be objects`);
      const value = row as Record<string, unknown>;
      const queryId = typeof value.queryId === "string"
        ? value.queryId
        : typeof value.query_id === "string"
          ? value.query_id
          : value.query;
      const docPath = typeof value.docPath === "string"
        ? value.docPath
        : typeof value.doc_id === "string"
          ? value.doc_id
          : value.doc;
      const relevance = value.relevance ?? value.rel;
      if (typeof queryId !== "string" || typeof docPath !== "string" || typeof relevance !== "number" ||
          !queryId.trim() || !docPath.trim() || !Number.isFinite(relevance) || relevance < 0) {
        throw new Error(`${source} qrel rows require queryId, docPath, and finite non-negative relevance`);
      }
      const rowKey = `${queryId}\u0000${docPath}`;
      if (seenRows.has(rowKey)) throw new Error(`${source} contains duplicate qrel row: ${queryId}/${docPath}`);
      seenRows.add(rowKey);
      (normalized[queryId] ??= {})[docPath] = relevance;
    }
    return normalized;
  }
  if (!input || typeof input !== "object") throw new Error(`${source} must be an object keyed by query id`);
  for (const [queryId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!queryId.trim()) throw new Error(`${source} contains an empty query id`);
    if (!value || typeof value !== "object") {
      throw new Error(`${source} qrels for ${queryId} must be an object keyed by document path`);
    }
    const rows: Record<string, number> = {};
    if (Array.isArray(value)) {
      for (const row of value) {
        if (!row || typeof row !== "object") throw new Error(`${source} qrel rows for ${queryId} must be objects`);
        const entry = row as Record<string, unknown>;
        const docPath = typeof entry.docPath === "string"
          ? entry.docPath
          : typeof entry.doc_id === "string"
            ? entry.doc_id
            : entry.doc;
        const relevance = entry.relevance ?? entry.rel;
        if (typeof docPath !== "string" || !docPath.trim() || typeof relevance !== "number" ||
            !Number.isFinite(relevance) || relevance < 0) {
          throw new Error(`${source} qrel ${queryId} rows require docPath and finite non-negative relevance`);
        }
        const rowKey = `${queryId}\u0000${docPath}`;
        if (seenRows.has(rowKey)) throw new Error(`${source} contains duplicate qrel row: ${queryId}/${docPath}`);
        seenRows.add(rowKey);
        rows[docPath] = relevance;
      }
      normalized[queryId] = rows;
      continue;
    }
    for (const [docPath, relevance] of Object.entries(value as Record<string, unknown>)) {
      if (!docPath.trim() || typeof relevance !== "number" || !Number.isFinite(relevance) || relevance < 0) {
        throw new Error(`${source} qrel ${queryId}/${docPath} must have a finite non-negative relevance`);
      }
      const rowKey = `${queryId}\u0000${docPath}`;
      if (seenRows.has(rowKey)) throw new Error(`${source} contains duplicate qrel row: ${queryId}/${docPath}`);
      seenRows.add(rowKey);
      rows[docPath] = relevance;
    }
    normalized[queryId] = rows;
  }
  return normalized;
}

function qrelsForQueries(queries: readonly GoldenQuery[]): Qrels {
  if (queries === GOLDEN_QUERIES) return GOLDEN_QRELS;
  // Expected-note labels in OMS_GOLDEN_QUERIES are user-owned evidence. Do
  // not turn an injected real-vault query file into synthetic qrels: callers
  // must provide the separately curated OMS_GOLDEN_QRELS file.
  throw new Error(
    "OMS_GOLDEN_QRELS is required when OMS_GOLDEN_QUERIES is provided; " +
    "real-vault labels must not be fabricated from expectedNotes",
  );
}

export function loadQrels(queries: readonly GoldenQuery[]): Qrels {
  const p = envValue("OMS_GOLDEN_QRELS") ?? envValue("OMS_PREREG_QRELS");
  if (!p) return qrelsForQueries(queries);
  return validateQrels(JSON.parse(readFileSync(p, "utf8")), `preregistered qrels at ${p}`);
}

/** Minimum per-type engine recall@10 average required to pass (default 0.5). */
function recallFloor(): number {
  const raw = envValue("OMS_GOLDEN_MIN_RECALL");
  if (!raw) return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0.5;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryReport {
  readonly id: string;
  readonly type: QueryType;
  readonly queryClass: GoldenQueryClass;
  readonly query: string;
  readonly expected: string[];
  readonly engineTop10: string[];
  readonly engineRecall: number;
  /** Graded relevance nDCG at rank 10 (derived from qrels). */
  readonly engineNdcg: number;
  /** Alias kept explicit for report consumers that use the metric name. */
  readonly ndcgAt10: number;
  readonly engineNdcgAt10: number;
  /**
   * Reciprocal rank of the first relevant document within the top 10.
   *
   * Reported alongside nDCG rather than instead of it: nDCG rewards good ordering
   * across the whole page, while this answers how far the reader had to look
   * before hitting something useful. An engine can lift aggregate nDCG by packing
   * several moderately-relevant documents lower down while still burying the one
   * obviously-right answer, and only this metric notices.
   */
  readonly mrrAt10: number;
  /** End-to-end engine latency for this query, in milliseconds. */
  readonly latencyMs: number;
  readonly durationMs: number;
  /** true when engineRecall >= floor (curated queries only). */
  readonly pass: boolean;
  /** Explicit capability failure for a requested modality, when unavailable. */
  readonly error?: string;
  /**
   * true when the query was uncurated and excluded from scoring.
   * Skipped rows are included in queries[] for count-consistency but are
   * excluded from all recall averages and gates.
   */
  readonly skipped: boolean;
}

export interface HarnessReport {
  readonly queries: QueryReport[];
  readonly byType: Record<QueryType, { engineAvg: number; ndcgAvg: number; mrrAvg: number; pass: boolean }>;
  /** Paired baseline/current nDCG means by the nine preregistered classes. */
  readonly ndcgByClass: Record<GoldenQueryClass, MetricPair>;
  readonly qrelsHash: string;
  readonly scoredRows: ScoredRowsValidation;
  readonly metrics: HarnessMetrics;
  readonly armIds: readonly BoostArmId[];
  readonly arms: Readonly<Record<BoostArmId, ArmMeasurement>>;
  readonly c040: C040Result;
  /** Candidate selected by the preregistered winner rule. */
  readonly winnerArmId: BoostArmId;
  readonly download: false;
  readonly productionSeam: boolean;
  readonly p50: number;
  readonly p95: MetricPair;
  readonly bootstrap: BootstrapCI;
  /** Paired candidate-minus-baseline nDCG bootstrap interval. */
  readonly pairedBootstrap: BootstrapCI;
  readonly overallPass: boolean;
}

export type Qrels = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface ScoredRowsValidation {
  readonly valid: boolean;
  readonly scored: number;
  readonly errors: readonly string[];
}

export interface BootstrapCI {
  readonly estimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly lower: number;
  readonly upper: number;
  readonly seed: number;
  readonly samples: number;
}

export interface HarnessMetrics {
  readonly ndcgAt10: { mean: number; ci: BootstrapCI };
  readonly mrrAt10: { mean: number; ci: BootstrapCI };
  readonly latencyMs: { p50: number; p95: number };
}

/** The only arm identifiers accepted by the R2 preregistration. */
export const BOOST_ARM_IDS = [
  "boost-k-scale",
  "boost-per-list",
  "boost-zero",
] as const;
export type BoostArmId = (typeof BOOST_ARM_IDS)[number];

/** Primary classes are frozen by the measurement preregistration. */
export const CANONICAL_PRIMARY_CLASSES = GOLDEN_QUERY_CLASSES;

export interface ArmMeasurement {
  readonly armId: BoostArmId;
  /** Production dispatcher policy used for this arm. */
  readonly policy: BoostArmId;
  readonly ndcgByClass: Record<GoldenQueryClass, number>;
  readonly p50: number;
  readonly p95: number;
  readonly bootstrap: BootstrapCI;
  readonly scoredRows: number;
  /** Per-query nDCG values used for paired candidate-minus-baseline resampling. */
  readonly ndcgByQuery: Readonly<Record<string, number>>;
  /** Digest of ranked paths and scores, proving each arm executed separately. */
  readonly outputDigest: string;
}

export interface MetricPair {
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
}

export interface C040Result {
  readonly pass: boolean;
  readonly primary: boolean;
  readonly secondary: boolean;
  readonly latency: boolean;
  readonly bootstrap: boolean;
  readonly reasons: readonly string[];
}

function assertExactClassEvidence(
  ndcgByClass: unknown,
  source: string,
): asserts ndcgByClass is Record<GoldenQueryClass, number> {
  if (!ndcgByClass || typeof ndcgByClass !== "object" || Array.isArray(ndcgByClass)) {
    throw new Error(`${source} ndcgByClass must be an object containing exactly the nine preregistered classes`);
  }
  const value = ndcgByClass as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== CANONICAL_PRIMARY_CLASSES.length ||
    keys.some((queryClass) => !CANONICAL_PRIMARY_CLASSES.includes(queryClass as GoldenQueryClass))
  ) {
    throw new Error(
      `${source} ndcgByClass must exactly match the nine preregistered classes: ` +
      CANONICAL_PRIMARY_CLASSES.join(", "),
    );
  }
  for (const queryClass of CANONICAL_PRIMARY_CLASSES) {
    if (!Object.hasOwn(value, queryClass) || typeof value[queryClass] !== "number" ||
        !Number.isFinite(value[queryClass])) {
      throw new Error(`${source} ndcgByClass.${queryClass} must be finite`);
    }
  }
}

/** Calculate the preregistered C040 rule from measured arm outputs. */
export function calculateC040(
  arms: Readonly<Record<BoostArmId, ArmMeasurement>>,
  primaryClasses: readonly GoldenQueryClass[] = CANONICAL_PRIMARY_CLASSES,
  pairedBootstrap?: BootstrapCI,
  winnerArmId?: BoostArmId,
): C040Result {
  if (
    primaryClasses.length !== CANONICAL_PRIMARY_CLASSES.length ||
    new Set(primaryClasses).size !== CANONICAL_PRIMARY_CLASSES.length ||
    primaryClasses.some((queryClass) => !CANONICAL_PRIMARY_CLASSES.includes(queryClass)) ||
    CANONICAL_PRIMARY_CLASSES.some((queryClass, index) => primaryClasses[index] !== queryClass)
  ) {
    throw new Error(`primary classes are frozen to: ${CANONICAL_PRIMARY_CLASSES.join(", ")}`);
  }
  const armKeys = Object.keys(arms);
  if (
    armKeys.length !== BOOST_ARM_IDS.length ||
    armKeys.some((armId) => !BOOST_ARM_IDS.includes(armId as BoostArmId))
  ) {
    throw new Error(`C040 requires exactly the preregistered arms: ${BOOST_ARM_IDS.join(", ")}`);
  }
  for (const armId of BOOST_ARM_IDS) {
    const arm = arms[armId];
    if (arm === undefined) throw new Error(`C040 requires measured arm: ${armId}`);
    if (arm.armId !== armId || arm.policy !== armId) {
      throw new Error(`C040 arm ${armId} must record its preregistered armId and policy`);
    }
    assertExactClassEvidence(arm.ndcgByClass, `arm ${armId}`);
  }
  const baseline = arms["boost-zero"];
  if (winnerArmId === undefined) {
    throw new Error("C040 calculation requires an explicit winner arm");
  }
  if (winnerArmId === "boost-zero") {
    throw new Error("boost-zero cannot be selected as a C040 candidate");
  }
  const candidate = arms[winnerArmId];
  if (baseline === undefined || candidate === undefined) {
    throw new Error("C040 calculation requires boost-zero and the selected candidate measurements");
  }
  const reasons: string[] = [];
  const epsilon = 1e-12;
  const measuredPair = pairedBootstrap ??
    (baseline !== undefined && candidate !== undefined &&
    baseline.ndcgByQuery !== undefined && candidate.ndcgByQuery !== undefined
      ? pairedBootstrapMeanCI(candidate, baseline)
      : undefined);
  const primarySet = new Set(CANONICAL_PRIMARY_CLASSES);
  const classes = [...CANONICAL_PRIMARY_CLASSES];
  const primary = classes.length > 0 && classes.filter((queryClass) => primarySet.has(queryClass))
    .every((queryClass) => candidate.ndcgByClass[queryClass]! - baseline.ndcgByClass[queryClass]! + epsilon >= 0.05);
  const secondary = classes.length > 0 && classes.filter((queryClass) => !primarySet.has(queryClass))
    .every((queryClass) => candidate.ndcgByClass[queryClass]! - baseline.ndcgByClass[queryClass]! + epsilon >= -0.02);
  const latency = baseline.p95 > 0 && candidate.p95 <= baseline.p95 * 1.5 + epsilon;
  const bootstrap = measuredPair !== undefined
    ? measuredPair.ciLow > 0
    : candidate.bootstrap.ciLow > baseline.bootstrap.ciHigh;
  if (!primary) reasons.push("primary class nDCG improvement is below +0.05");
  if (!secondary) reasons.push("non-primary class nDCG regression exceeds -0.02");
  if (!latency) reasons.push("p95 latency exceeds the 1.5x baseline bound");
  if (!bootstrap) reasons.push("bootstrap confidence intervals do not prove an improvement");
  return {
    pass: primary && secondary && latency && bootstrap,
    primary,
    secondary,
    latency,
    bootstrap,
    reasons,
  };
}

/** Select the strongest measured candidate without embedding a winner. */
function selectWinnerArm(
  arms: Readonly<Record<BoostArmId, ArmMeasurement>>,
): BoostArmId {
  const candidates = BOOST_ARM_IDS.filter((armId) => armId !== "boost-zero");
  const available = candidates.filter((armId) => arms[armId] !== undefined);
  if (available.length === 0) throw new Error("winner selection requires a measured candidate arm");
  return available.reduce((winner, armId) => {
    const winnerScore = GOLDEN_QUERY_CLASSES.reduce(
      (sum, queryClass) => sum + (arms[winner]?.ndcgByClass[queryClass] ?? 0),
      0,
    );
    const candidateScore = GOLDEN_QUERY_CLASSES.reduce(
      (sum, queryClass) => sum + (arms[armId]?.ndcgByClass[queryClass] ?? 0),
      0,
    );
    return candidateScore > winnerScore ? armId : winner;
  });
}

/**
 * Bootstrap the paired candidate-minus-baseline nDCG deltas. Resampling the
 * two arm means independently would discard query pairing and can manufacture
 * confidence that is not present in the measured rows.
 */
export function pairedBootstrapMeanCI(
  candidate: Pick<ArmMeasurement, "ndcgByQuery">,
  baseline: Pick<ArmMeasurement, "ndcgByQuery">,
  options: HarnessOptions["bootstrap"] = {},
): BootstrapCI {
  const queryIds = Object.keys(candidate.ndcgByQuery).sort();
  const baselineIds = Object.keys(baseline.ndcgByQuery).sort();
  if (
    queryIds.length === 0 ||
    queryIds.length !== baselineIds.length ||
    queryIds.some((queryId, index) => queryId !== baselineIds[index])
  ) {
    throw new Error("paired bootstrap requires matching candidate and baseline query rows");
  }
  const deltas = queryIds.map((queryId) => {
    const current = candidate.ndcgByQuery[queryId]!;
    const base = baseline.ndcgByQuery[queryId]!;
    if (!Number.isFinite(current) || !Number.isFinite(base)) {
      throw new Error(`paired bootstrap samples must be finite for query ${queryId}`);
    }
    return current - base;
  });
  return bootstrapMeanCI(deltas, options);
}

export type QrelDocumentInput =
  | Readonly<Record<string, number>>
  | ReadonlyMap<string, number>
  | ReadonlyArray<{ docPath: string; relevance: number }>;
export type RankedDocumentInput = string | { docPath: string; score?: number };

function qrelDocumentMap(qrels: QrelDocumentInput): Readonly<Record<string, number>> {
  if (qrels instanceof Map) return Object.fromEntries(qrels.entries());
  if (Array.isArray(qrels)) {
    const rows: Record<string, number> = {};
    for (const row of qrels) rows[row.docPath] = row.relevance;
    return rows;
  }
  return qrels;
}

/** Linear-interpolated percentile. Empty samples and non-finite values fail closed. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one sample");
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`percentile must be in [0, 1], got ${p}`);
  if (values.some((value) => !Number.isFinite(value))) throw new Error("percentile samples must be finite");
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function latencyPercentiles(values: readonly number[]): { p50: number; p95: number } {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

/**
 * Deterministic bootstrap confidence interval for the arithmetic mean.
 * The local PRNG is deliberately self-contained so this test-only harness
 * does not add a dependency or consult process-global randomness.
 */
export function bootstrapMeanCI(
  values: readonly number[],
  options: { seed?: number; samples?: number; iterations?: number; confidence?: number } = {},
): BootstrapCI {
  if (values.length === 0) throw new Error("bootstrapMeanCI requires at least one sample");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("bootstrap samples must be finite");
  const seed = options.seed ?? 0x9e3779b9;
  const samples = options.samples ?? options.iterations ?? 2_000;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`bootstrap seed must be a non-negative integer, got ${seed}`);
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`bootstrap samples must be a positive integer, got ${samples}`);
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(`bootstrap confidence must be in (0, 1), got ${confidence}`);
  }

  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let draw = 0; draw < values.length; draw += 1) {
      sum += values[Math.floor(next() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  const alpha = (1 - confidence) / 2;
  const ciLow = percentile(means, alpha);
  const ciHigh = percentile(means, 1 - alpha);
  return {
    estimate: values.reduce((sum, value) => sum + value, 0) / values.length,
    ciLow,
    ciHigh,
    lower: ciLow,
    upper: ciHigh,
    seed,
    samples,
  };
}

export const bootstrapCI = bootstrapMeanCI;
export const bootstrapSeededCI = bootstrapMeanCI;

/** Compute graded nDCG using the standard 2^relevance - 1 gain. */
export function ndcgAtK(
  rankedDocs: readonly RankedDocumentInput[],
  qrelsInput: QrelDocumentInput,
  k = 10,
): number {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`nDCG cutoff must be a positive integer, got ${k}`);
  const qrels = qrelDocumentMap(qrelsInput);
  const grades = Object.values(qrels);
  if (grades.length === 0 || grades.every((grade) => grade <= 0)) return 0;
  const seen = new Set<string>();
  const top = rankedDocs
    .slice(0, k)
    .map((doc) => typeof doc === "string" ? { path: doc, score: undefined } : { path: doc.docPath, score: doc.score })
    .filter((doc) => {
      const key = doc.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let dcg = 0;
  for (let rank = 0; rank < top.length;) {
    let end = rank + 1;
    const score = top[rank]!.score;
    if (Number.isFinite(score)) {
      while (end < top.length && top[end]!.score === score) end += 1;
    }
    const discount = Array.from({ length: end - rank }, (_, offset) => 1 / Math.log2(rank + offset + 2))
      .reduce((sum, value) => sum + value, 0) / (end - rank);
    for (let index = rank; index < end; index += 1) {
      const doc = top[index]!.path;
      const relevance = qrels[doc] ?? qrels[Object.keys(qrels).find((key) => key.toLowerCase() === doc.toLowerCase()) ?? ""] ?? 0;
      dcg += (Math.pow(2, relevance) - 1) * discount;
    }
    rank = end;
  }
  const ideal = [...grades]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, relevance, rank) => sum + (Math.pow(2, relevance) - 1) / Math.log2(rank + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export const ndcgAt10 = (rankedDocs: readonly RankedDocumentInput[], qrels: QrelDocumentInput): number =>
  ndcgAtK(rankedDocs, qrels, 10);

/**
 * Mean reciprocal rank of the first relevant document within the top `k`.
 *
 * nDCG rewards good ordering across the whole page; MRR asks a narrower and
 * more human question: how far down did the reader have to look before hitting
 * something useful? The parity gate requires both, because an engine can lift
 * aggregate nDCG by packing several moderately-relevant documents lower on the
 * page while still burying the one obviously-right answer.
 *
 * Relevance is treated as binary here (any positive grade counts), since a
 * reciprocal rank has no way to express *how* relevant the first hit was.
 * Duplicate paths are collapsed before ranking and matched case-insensitively,
 * matching {@link ndcgAtK} so the two metrics never disagree about which
 * document sits at which rank. Returns 0 when no relevant document appears in
 * the top `k`, which is a real measurement rather than a missing one.
 */
export function mrrAtK(
  rankedDocs: readonly RankedDocumentInput[],
  qrelsInput: QrelDocumentInput,
  k = 10,
): number {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`MRR cutoff must be a positive integer, got ${k}`);
  const qrels = qrelDocumentMap(qrelsInput);
  const relevant = new Set(
    Object.entries(qrels)
      .filter(([, grade]) => grade > 0)
      .map(([docPath]) => docPath.toLowerCase()),
  );
  if (relevant.size === 0) return 0;

  const seen = new Set<string>();
  let rank = 0;
  for (const doc of rankedDocs) {
    const docPath = typeof doc === "string" ? doc : doc.docPath;
    const key = docPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (rank >= k) break;
    if (relevant.has(key)) return 1 / (rank + 1);
    rank += 1;
  }
  return 0;
}

export const mrrAt10 = (rankedDocs: readonly RankedDocumentInput[], qrels: QrelDocumentInput): number =>
  mrrAtK(rankedDocs, qrels, 10);

/**
 * Canonical qrels serialization.  Every accepted input is represented as
 * sorted `(queryId, docPath, relevance)` rows, so object insertion order or
 * JSON pretty-printing cannot change the preregistered digest.
 */
export function canonicalQrels(qrels: Qrels | unknown): string {
  const normalized = validateQrels(qrels);
  const rows: Array<{ queryId: string; docPath: string; relevance: number }> = [];
  for (const queryId of Object.keys(normalized).sort()) {
    for (const docPath of Object.keys(normalized[queryId]!).sort()) {
      rows.push({ queryId, docPath, relevance: normalized[queryId]![docPath]! });
    }
  }
  return JSON.stringify(rows);
}

export function qrelsSha256(qrels: Qrels): string {
  return createHash("sha256").update(canonicalQrels(qrels)).digest("hex");
}

/** Validate that every scored query is unique, curated, and has qrels. */
export function validateScoredRows(
  rows: readonly Pick<QueryReport, "id" | "skipped" | "engineTop10" | "error">[],
  qrels: Qrels,
): ScoredRowsValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  let scored = 0;
  for (const row of rows) {
    if (row.skipped) continue;
    // Capability failures are gate evidence, not zero-valued measurements.
    // Keep them visible in the report while excluding them from scored-row
    // counts, qrel validation, and every aggregate metric.
    if (row.error !== undefined) {
      continue;
    }
    scored += 1;
    if (seen.has(row.id)) errors.push(`duplicate scored query id: ${row.id}`);
    seen.add(row.id);
    if (!(row.id in qrels) || Object.keys(qrels[row.id]!).length === 0) {
      errors.push(`missing qrels for scored query: ${row.id}`);
    }
    const docs = row.engineTop10.map((doc) => doc.toLowerCase());
    if (new Set(docs).size !== docs.length) errors.push(`duplicate ranked document in scored query: ${row.id}`);
  }
  if (scored === 0) errors.push("no scored rows");
  return { valid: errors.length === 0, scored, errors };
}

export function assertScoredRows(
  rows: readonly Pick<QueryReport, "id" | "skipped" | "engineTop10" | "error">[],
  qrels: Qrels,
): ScoredRowsValidation {
  const validation = validateScoredRows(rows, qrels);
  if (!validation.valid) throw new Error(`invalid scored rows: ${validation.errors.join("; ")}`);
  return validation;
}

// ---------------------------------------------------------------------------
// Recall computation
// ---------------------------------------------------------------------------

/**
 * Compute recall@K = |expected ∩ topK| / |expected|.
 *
 * Called only for curated queries (expectedNotes verified against a real vault).
 */
function recall(topK: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const hitSet = new Set(topK.map((p) => p.toLowerCase()));
  const found = expected.filter((p) => hitSet.has(p.toLowerCase())).length;
  return found / expected.length;
}

// ---------------------------------------------------------------------------
// Engine runner
// ---------------------------------------------------------------------------

/**
 * Run the retrieval engine for a single query.
 *
 * FAIL-LOUD: any throw from runTracer() propagates directly.
 * An engine failure is a red gate — never a silent empty result.
 */
export async function runEngine(
  q: GoldenQuery,
  config: TracerConfig,
  files?: string[],
): Promise<string[]> {
  const selectedFiles = files ?? config.files;
  const results = await runTracer(
    { ...config, files: selectedFiles as readonly string[] | undefined },
    [{ type: q.type === "graph" ? "graph" : q.type, query: q.query }],
  );
  return results.map((r) => r.docPath);
}

function normalizeRelativeFile(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//u, "");
}

function filterSelectedFiles(
  hits: readonly RetrievalResult[],
  files: readonly string[] | undefined,
): RetrievalResult[] {
  if (files === undefined) return hits.slice(0, 10);
  const selected = new Set(files.map(normalizeRelativeFile));
  return hits
    .filter((hit) => selected.has(normalizeRelativeFile(hit.docPath)))
    .slice(0, 10);
}

/**
 * Run a query through the production dispatcher wired by the assembled core
 * engine. R2 CI keeps the provider deferred, so lexical evidence is measured
 * while vec/HyDE fail explicitly and graph remains unavailable without an
 * injected traversal dependency.
 */
async function runAssembledQuery(
  q: GoldenQuery,
  engine: AssembledEngine,
  files: readonly string[] | undefined,
): Promise<{ readonly hits: readonly RetrievalResult[]; readonly error?: string }> {
  // An explicit empty slice remains empty because the harness syncs only the
  // requested files. Avoid retrying unavailable providers for every empty
  // fixture row; the explicit error still records the requested type.
  if (files !== undefined && files.length === 0) {
    return q.type === "lex"
      ? { hits: [] }
      : { hits: [], error: `${q.type} modality unavailable for an empty file slice` };
  }
  if (q.type === "graph") {
    // The public MCP envelope intentionally excludes graph from its typed
    // search allow-list. Exercise the production dispatcher directly for this
    // preregistered modality instead of relabeling it as lexical evidence.
    try {
      const hits = filterSelectedFiles(
        await dispatch(
          [{ type: "graph", query: q.query }],
          engine.deps,
          files === undefined ? 10 : Number.MAX_SAFE_INTEGER,
        ),
        files,
      );
      return engine.deps.graphTraverse === undefined
        ? { hits, error: "graph modality unavailable: no graph traversal dependency is assembled" }
        : { hits };
    } catch (error) {
      return {
        hits: [],
        error: `assembled production query unavailable for ${q.id}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    const hits = await dispatch([{ type: q.type, query: q.query }], engine.deps, Number.MAX_SAFE_INTEGER);
    return { hits: filterSelectedFiles(hits, files) };
  } catch (error) {
    // An unavailable vec/HyDE provider is an explicit failed measurement, not
    // a lexical fallback. Keep the row visible so the gate remains red while
    // the rest of the fixture can still provide diagnostic evidence.
    return {
      hits: [],
      error: `assembled production query unavailable for ${q.id}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function measureAssembledArm(
  armId: BoostArmId,
  queries: readonly GoldenQuery[],
  qrels: Qrels,
  engine: AssembledEngine,
  files: readonly string[] | undefined,
  bootstrapOptions: HarnessOptions["bootstrap"],
): Promise<ArmMeasurement> {
  const byClass = {} as Record<GoldenQueryClass, number>;
  const latencies: number[] = [];
  const ndcgs: number[] = [];
  const ndcgByQuery: Record<string, number> = {};
  const outputRows: Array<{ queryId: string; hits: readonly RetrievalResult[] }> = [];
  for (const queryClass of GOLDEN_QUERY_CLASSES) {
    const rows = queries.filter((query) => query.queryClass === queryClass && query.curated === true);
    const values: number[] = [];
    for (const query of rows) {
      const startedAt = performance.now();
      const execution = await runAssembledQuery(query, engine, files);
      if (execution.error !== undefined) continue;
      latencies.push(Math.max(0, performance.now() - startedAt));
      const value = ndcgAt10(execution.hits, qrels[query.id]!);
      values.push(value);
      ndcgs.push(value);
      ndcgByQuery[query.id] = value;
      outputRows.push({ queryId: query.id, hits: execution.hits });
    }
    byClass[queryClass] = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  const latency = latencies.length > 0 ? latencyPercentiles(latencies) : { p50: 0, p95: 0 };
  const bootstrap = ndcgs.length > 0
    ? bootstrapMeanCI(ndcgs, bootstrapOptions)
    : {
        estimate: 0,
        ciLow: 0,
        ciHigh: 0,
        lower: 0,
        upper: 0,
        seed: bootstrapOptions?.seed ?? 0x9e3779b9,
        samples: bootstrapOptions?.samples ?? 2_000,
      };
  return {
    armId,
    policy: armId,
    ndcgByClass: byClass,
    p50: latency.p50,
    p95: latency.p95,
    bootstrap,
    scoredRows: ndcgs.length,
    ndcgByQuery: Object.fromEntries(
      Object.entries(ndcgByQuery).sort(([left], [right]) => left.localeCompare(right)),
    ),
    outputDigest: createHash("sha256")
      .update(JSON.stringify(outputRows.sort((left, right) => left.queryId.localeCompare(right.queryId))))
      .digest("hex"),
  };
}

function metricsPlaceholder(rows: readonly QueryReport[]): { p50: number; p95: number } {
  const values = rows
    .filter((row) => !row.skipped && row.error === undefined)
    .map((row) => row.latencyMs);
  return values.length > 0 ? latencyPercentiles(values) : { p50: 0, p95: 0 };
}

function bootstrapPlaceholder(
  rows: readonly QueryReport[],
  options: HarnessOptions["bootstrap"],
): BootstrapCI {
  const values = rows
    .filter((row) => !row.skipped && row.error === undefined)
    .map((row) => row.engineNdcg);
  return values.length > 0
    ? bootstrapMeanCI(values, options)
    : {
        estimate: 0,
        ciLow: 0,
        ciHigh: 0,
        lower: 0,
        upper: 0,
        seed: options?.seed ?? 0x9e3779b9,
        samples: options?.samples ?? 2_000,
      };
}

function hasMatchingBootstrapRows(
  candidate: Pick<ArmMeasurement, "ndcgByQuery">,
  baseline: Pick<ArmMeasurement, "ndcgByQuery">,
): boolean {
  const candidateIds = Object.keys(candidate.ndcgByQuery).sort();
  const baselineIds = Object.keys(baseline.ndcgByQuery).sort();
  return candidateIds.length > 0 &&
    candidateIds.length === baselineIds.length &&
    candidateIds.every((queryId, index) => queryId === baselineIds[index]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Absolute path to the vault. Falls back to OMS_VAULT env. */
  vaultPath?: string;
  /** Frozen in-memory query snapshot; avoids rereading a mutable file mid-run. */
  queries?: readonly GoldenQuery[];
  /**
   * Explicit file list to keep the run fast (slice of vault).
   * Recommended for CI; omit to run against full vault.
   */
  files?: string[];
  /** Override default TracerConfig fields. */
  configOverrides?: Partial<TracerConfig>;
  /**
   * Absolute path to a prebuilt engine SQLite database to reuse across runs,
   * avoiding the cost of re-embedding. Falls back to OMS_GOLDEN_DB env var.
   * When neither is set, a fresh temporary DB is created and deleted on exit.
   */
  dbPath?: string;
  /** Explicit qrels keyed by query id; otherwise expectedNotes are binary qrels. */
  qrels?: Qrels;
  /** Expected SHA-256 of the frozen qrels. Mismatch rejects the run. */
  qrelsHash?: string;
  /** Alias for callers naming the preregistered digest explicitly. */
  preregisteredQrelsHash?: string;
  /** Seed and size for the deterministic nDCG bootstrap interval. */
  bootstrap?: { seed?: number; samples?: number; confidence?: number };
  /**
   * R2's CI contract is download:false.  The option is explicit so callers
   * cannot accidentally turn a measurement run into a model acquisition.
   * `true` is rejected because acquisition belongs to setup, not the harness.
   */
  download?: false;
  /** Execute all rows through the assembled production adapter (default true). */
  productionSeam?: boolean;
  /**
   * Optional vault-owner provenance evidence for arm policy measurement.
   * The harness never infers labels for an injected real-vault query set.
   */
  provenanceMap?: (docPath: string) => Provenance;
  /** Explicit vault-owner provenance mapping, keyed by repository-relative path. */
  provenance?: Readonly<Record<string, Provenance>>;
  /** Write an immutable validator-ready measurement manifest at this path. */
  measurementManifestPath?: string;
  /** Human-owned identity for the measured dataset; required when emitting. */
  datasetId?: string;
  /** Commit or immutable revision of the harness code; required when emitting. */
  harnessCommit?: string;
  /** Explicit winner selection for manifest emission; never inferred from a label. */
  winnerArmId?: BoostArmId;
}

/**
 * The built-in fixture has intentionally known provenance by folder. This
 * mapping is limited to that synthetic fixture and is never applied to a
 * caller-provided or real vault.
 */
function fixtureProvenanceMap(vaultPath: string): ((docPath: string) => Provenance) | undefined {
  const fixtureRoot = path.resolve("test/fixtures/vault");
  if (path.resolve(vaultPath) !== fixtureRoot) return undefined;
  return (docPath: string): Provenance =>
    docPath.startsWith("notes/") ? "authored"
      : docPath.startsWith("references/") ? "curated"
        : "external-raw";
}

const PROVENANCE_VALUES: readonly Provenance[] = ["authored", "curated", "external-raw"];

function loadExternalProvenance(): Readonly<Record<string, Provenance>> | undefined {
  const provenancePath = envValue("OMS_GOLDEN_PROVENANCE");
  if (!provenancePath) return undefined;
  const raw: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`OMS_GOLDEN_PROVENANCE at ${provenancePath} must be an object keyed by document path`);
  }
  const mapping: Record<string, Provenance> = {};
  for (const [docPath, provenance] of Object.entries(raw)) {
    if (!docPath.trim() || typeof provenance !== "string" ||
        !(PROVENANCE_VALUES as readonly string[]).includes(provenance)) {
      throw new Error(`OMS_GOLDEN_PROVENANCE has invalid provenance for ${docPath}`);
    }
    mapping[docPath] = provenance as Provenance;
  }
  return mapping;
}

function provenanceMapFrom(mapping: Readonly<Record<string, Provenance>>): (docPath: string) => Provenance {
  return (docPath) => {
    const provenance = mapping[docPath];
    if (provenance === undefined) {
      throw new Error(`explicit provenance evidence is missing for retrieved document: ${docPath}`);
    }
    return provenance;
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emitMeasurementManifest(report: HarnessReport, options: HarnessOptions): void {
  const manifestPath = options.measurementManifestPath ?? envValue("OMS_MEASUREMENT_MANIFEST_OUTPUT");
  if (!manifestPath) return;
  const measuredVault = options.vaultPath ?? envValue("OMS_VAULT") ?? path.resolve("test/fixtures/vault");
  if (path.resolve(measuredVault) === path.resolve("test/fixtures/vault")) {
    throw new Error("measurement manifest emission requires a real-vault run; fixture evidence cannot be published");
  }
  if (!report.productionSeam || report.armIds.length !== BOOST_ARM_IDS.length) {
    throw new Error("measurement manifest emission requires a production-seam three-arm run");
  }
  if (!report.c040.pass || !report.scoredRows.valid) {
    throw new Error("measurement manifest emission requires passing paired C040 and valid scored rows");
  }
  const outputPath = path.resolve("docs/measurements/boost-c040.json");
  const resolvedPath = path.resolve(manifestPath);
  if (resolvedPath !== outputPath) {
    throw new Error("boost-c040 measurement manifest must be written to docs/measurements/boost-c040.json");
  }
  if (existsSync(resolvedPath)) throw new Error(`measurement manifest is immutable and already exists: ${manifestPath}`);
  const datasetId = options.datasetId ?? envValue("OMS_MEASUREMENT_DATASET_ID");
  const harnessCommit = options.harnessCommit ?? envValue("OMS_MEASUREMENT_HARNESS_COMMIT");
  if (!datasetId?.trim() || !harnessCommit?.trim()) {
    throw new Error("measurement manifest emission requires OMS_MEASUREMENT_DATASET_ID and OMS_MEASUREMENT_HARNESS_COMMIT");
  }
  const rawEvidence = {
    kind: "paired-production-seam-v1",
    paired: true,
    arms: Object.fromEntries(report.armIds.map((armId) => {
      const arm = report.arms[armId];
      return [armId, {
        outputDigest: `sha256:${arm.outputDigest}`,
        scoredRows: arm.scoredRows,
        ndcgByQuery: arm.ndcgByQuery,
      }];
    })),
  };
  const rawDigest = `sha256:${sha256Json(rawEvidence)}`;
  const queryIds = Object.keys(report.arms[report.winnerArmId].ndcgByQuery).sort();
  const manifest = {
    schemaVersion: 1,
    profile: "boost-c040",
    harnessCommit,
    datasetId,
    qrelsHash: `sha256:${report.qrelsHash}`,
    armIds: [...report.armIds],
    arms: report.arms,
    primaryClasses: [...CANONICAL_PRIMARY_CLASSES],
    winnerArmId: report.winnerArmId,
    queryIds,
    ndcgByClass: report.ndcgByClass,
    p50: report.p50,
    p95: report.p95,
    bootstrap: { ...report.pairedBootstrap, paired: true },
    rawEvidence,
    rawDigest,
    verdict: {
      pass: report.c040.pass,
      c040: report.c040.pass,
      winnerArmId: report.winnerArmId,
    },
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
}

/**
 * Run the full golden-set recall comparison and return a structured report.
 *
 * Uncurated queries (curated !== true) are excluded from scoring with a
 * console.warn and appear in report.queries with skipped:true.
 *
 * Uses a temporary SQLite DB (cleaned up after the run) unless opts.dbPath
 * or OMS_GOLDEN_DB is set.
 */
export async function runHarness(opts: HarnessOptions = {}): Promise<HarnessReport> {
  if (opts.download !== undefined && opts.download !== false) {
    throw new Error("R2 harness only supports download:false; acquire models during setup");
  }
  const vaultPath = opts.vaultPath ?? envValue("OMS_VAULT") ?? path.resolve("test/fixtures/vault");
  const floor = recallFloor();
  const loadedQueries = opts.queries === undefined
    ? loadGoldenQueries()
    : [...opts.queries];
  const qrels = validateQrels(opts.qrels ?? loadQrels(loadedQueries), "golden qrels");
  const queries = [...loadedQueries].sort((left, right) => left.id.localeCompare(right.id));
  const queryIds = queries.map((query) => query.id);
  if (new Set(queryIds).size !== queryIds.length) {
    throw new Error("golden query set contains duplicate query ids");
  }
  validateGoldenCoverage(queries, { allowUncurated: true });
  // Normalize caller-supplied qrels before hashing. This keeps the digest
  // contract identical for object, array, and pretty-printed JSON inputs.
  const loadedQueryIds = new Set(queries.map((query) => query.id));
  for (const queryId of Object.keys(qrels)) {
    if (!loadedQueryIds.has(queryId)) throw new Error(`qrels contains unknown query id: ${queryId}`);
  }
  for (const query of queries) {
    // Uncurated rows are intentionally excluded from every score. They do
    // not need (and must not force fabrication of) qrel labels.
    if (query.curated === true && !(query.id in qrels)) {
      throw new Error(`qrels is missing query id: ${query.id}`);
    }
  }
  const actualQrelsHash = qrelsSha256(qrels);
  const expectedQrelsHash =
    opts.qrelsHash ??
    opts.preregisteredQrelsHash ??
    envValue("OMS_GOLDEN_QRELS_HASH") ??
    envValue("OMS_GOLDEN_QRELS_SHA256") ??
    envValue("OMS_PREREG_QRELS_HASH");
  const usesInjectedQrels =
    opts.qrels !== undefined ||
    envValue("OMS_GOLDEN_QRELS") !== undefined ||
    envValue("OMS_PREREG_QRELS") !== undefined ||
    loadedQueries !== GOLDEN_QUERIES;
  if (usesInjectedQrels && expectedQrelsHash === undefined) {
    throw new Error(
      "preregistered qrels hash is required when scoring injected query or qrels evidence",
    );
  }
  if (expectedQrelsHash !== undefined) {
    const normalizedExpected = expectedQrelsHash.replace(/^sha256:/i, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(normalizedExpected)) {
      throw new Error(`qrels hash must be a sha256 digest: ${expectedQrelsHash}`);
    }
    if (normalizedExpected !== actualQrelsHash) {
      throw new Error(`qrels hash mismatch: expected ${expectedQrelsHash}, got sha256:${actualQrelsHash}`);
    }
  }

  const productionSeam = opts.productionSeam !== false;
  const externalProvenance = opts.provenance ?? loadExternalProvenance();
  const provenanceMap = opts.provenanceMap ??
    (externalProvenance === undefined ? fixtureProvenanceMap(vaultPath) : provenanceMapFrom(externalProvenance));
  if (productionSeam && path.resolve(vaultPath) !== path.resolve("test/fixtures/vault") &&
      provenanceMap === undefined) {
    throw new Error(
      "production-seam external measurements require OMS_GOLDEN_PROVENANCE; provenance labels are human input and are never inferred",
    );
  }
  const resolvedDbPath = opts.dbPath ?? envValue("OMS_GOLDEN_DB") ?? opts.configOverrides?.dbPath;
  const useTempDb = resolvedDbPath === undefined;
  const tmpDir = useTempDb ? mkdtempSync(path.join(tmpdir(), "oms-golden-")) : undefined;
  const dbPath = resolvedDbPath ?? path.join(tmpDir!, "golden.db");
  const config = makeTracerConfig({
    vaultPath,
    dbPath,
    embeddingDimensions: 768,
    ...opts.configOverrides,
  });
  const selectedFiles = opts.files ?? config.files;
  const assemblyConfig = {
    vault: config.vaultPath,
    dbPath: config.dbPath,
    ...(config.embeddingProvider !== undefined ? { embeddingProvider: config.embeddingProvider } : {}),
    ...(config.embeddingModel !== undefined ? { embeddingModel: config.embeddingModel } : {}),
    ...(config.embeddingDescriptor !== undefined ? { embeddingDescriptor: config.embeddingDescriptor } : {}),
    ...(config.embeddingDimensions !== undefined ? { embeddingDimensions: config.embeddingDimensions } : {}),
    ...(config.embeddingContext !== undefined ? { embeddingContext: config.embeddingContext } : {}),
    ...(config.embeddingContextLength !== undefined ? { embeddingContextLength: config.embeddingContextLength } : {}),
    ...(config.embeddingContextTokens !== undefined ? { embeddingContextTokens: config.embeddingContextTokens } : {}),
    ...(config.embeddingMrlDim !== undefined ? { embeddingMrlDim: config.embeddingMrlDim } : {}),
    ...(config.embeddingNormalization !== undefined ? { embeddingNormalization: config.embeddingNormalization } : {}),
    ...(config.embeddingPrefixScheme !== undefined ? { embeddingPrefixScheme: config.embeddingPrefixScheme } : {}),
  } as const;
  // Production seam is the default. The legacy tracer remains available for
  // explicit callers and its direct API retains fail-loud embedding behavior.
  const assembledArms = productionSeam
    ? {
        // Keep arm policy in the production dispatcher dependency graph. An
        // rrfK-only difference is not a policy: with one lexical list it would
        // execute the same boost behavior for every arm.
        "boost-k-scale": assembleCoreSemanticEngine({
          ...assemblyConfig,
          rrfK: 60,
          policy: "boost-k-scale",
        }),
        "boost-per-list": assembleCoreSemanticEngine({
          ...assemblyConfig,
          rrfK: 60,
          policy: "boost-per-list",
        }),
        "boost-zero": assembleCoreSemanticEngine({
          ...assemblyConfig,
          rrfK: 60,
          policy: "boost-zero",
        }),
      }
    : undefined;
  if (assembledArms !== undefined && provenanceMap !== undefined) {
    for (const engine of Object.values(assembledArms)) {
      // DispatcherDeps is intentionally mutable so a generation swap can
      // rebind the store; attach caller-supplied provenance evidence at the
      // same seam without changing production assembly defaults.
      engine.deps.provenanceMap = provenanceMap;
    }
  }
  const assembled = assembledArms?.["boost-k-scale"];
  const reports: QueryReport[] = [];
  let armMeasurements: Record<BoostArmId, ArmMeasurement> | undefined;

  try {
    if (assembledArms !== undefined) {
      for (const engine of Object.values(assembledArms)) {
        const syncResult = await syncEngineStore({
          vault: assemblyConfig.vault,
          store: engine.store,
          files: selectedFiles,
          embed: false,
          persist: false,
        });
        if (!syncResult.available) {
          throw new Error(syncResult.reason ?? "assembled production lexical sync unavailable");
        }
      }
    }
    for (const q of queries) {
      if (q.curated !== true) {
        console.warn(
          `[golden-harness] SKIP uncurated query ${q.id} ("${q.query.slice(0, 60)}") ` +
          "— labels are vault-owner evidence and were not fabricated",
        );
        reports.push({
          id: q.id,
          type: q.type,
          queryClass: q.queryClass,
          query: q.query,
          expected: q.expectedNotes,
          engineTop10: [],
          engineRecall: 0,
          engineNdcg: 0,
          ndcgAt10: 0,
          engineNdcgAt10: 0,
          mrrAt10: 0,
          latencyMs: 0,
          durationMs: 0,
          pass: false,
          skipped: true,
        });
        continue;
      }
      const startedAt = performance.now();
      const execution = productionSeam
        ? await runAssembledQuery(q, assembled!, selectedFiles)
        : {
            hits: (await runEngine(q, config, selectedFiles)).map((docPath) => ({
              docPath,
              chunkOrdinal: 0,
              score: 0,
            })),
          };
      const latencyMs = Math.max(0, performance.now() - startedAt);
      const engineTop10 = execution.hits.map((hit) => hit.docPath);
      const engineRecall = recall(engineTop10, q.expectedNotes);
      const engineNdcg = ndcgAt10(execution.hits, qrels[q.id]!);
      // Computed from the same ranked hits and qrels as nDCG, so the two metrics
      // can never disagree about which document occupies which rank.
      const engineMrr = mrrAt10(execution.hits, qrels[q.id]!);
      reports.push({
        id: q.id,
        type: q.type,
        queryClass: q.queryClass,
        query: q.query,
        expected: q.expectedNotes,
        engineTop10,
        engineRecall,
        engineNdcg,
        ndcgAt10: engineNdcg,
        engineNdcgAt10: engineNdcg,
        mrrAt10: engineMrr,
        latencyMs,
        durationMs: latencyMs,
        pass: engineRecall >= floor,
        skipped: false,
        ...(execution.error === undefined ? {} : { error: execution.error }),
      });
    }
    armMeasurements = {} as Record<BoostArmId, ArmMeasurement>;
    for (const armId of BOOST_ARM_IDS) {
      armMeasurements[armId] = productionSeam
        ? await measureAssembledArm(
            armId,
            queries,
            qrels,
            assembledArms![armId],
            selectedFiles,
            opts.bootstrap,
          )
        : {
            armId,
            policy: armId,
            ndcgByClass: Object.fromEntries(
              GOLDEN_QUERY_CLASSES.map((queryClass) => {
                const rows = reports.filter((row) => row.queryClass === queryClass && !row.skipped);
                return [queryClass, rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.engineNdcg, 0) / rows.length];
              }),
            ) as Record<GoldenQueryClass, number>,
            p50: metricsPlaceholder(reports).p50,
            p95: metricsPlaceholder(reports).p95,
            bootstrap: bootstrapPlaceholder(reports, opts.bootstrap),
            scoredRows: reports.filter((row) => !row.skipped).length,
            ndcgByQuery: Object.fromEntries(
              reports.filter((row) => !row.skipped).map((row) => [row.id, row.engineNdcg]),
            ),
            outputDigest: createHash("sha256")
              .update(JSON.stringify(
                reports
                  .filter((row) => !row.skipped)
                  .map((row) => ({ queryId: row.id, hits: row.engineTop10 })),
              ))
              .digest("hex"),
          };
    }
  } finally {
    if (assembledArms) {
      await Promise.all(Object.values(assembledArms).map((engine) => engine.dispose()));
    }
    if (useTempDb && tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── Per-type aggregation (curated / non-skipped rows only) ──────────────
  const types: QueryType[] = ["lex", "vec", "hyde", "graph"];
  const byType = {} as Record<QueryType, { engineAvg: number; ndcgAvg: number; mrrAvg: number; pass: boolean }>;

  for (const t of types) {
    // Exclude skipped (uncurated) queries from all averages and gates
    const rows = reports.filter((r) => r.type === t && !r.skipped && r.error === undefined);
    const unavailable = reports.some((r) => r.type === t && !r.skipped && r.error !== undefined);
    // 0 scored => inconclusive => fail: an unmeasured type is never a pass.
    if (rows.length === 0) {
      byType[t] = { engineAvg: 0, ndcgAvg: 0, mrrAvg: 0, pass: false };
      continue;
    }
    const engineAvg = rows.reduce((s, r) => s + r.engineRecall, 0) / rows.length;
    const ndcgAvg = rows.reduce((s, r) => s + r.engineNdcg, 0) / rows.length;
    const mrrAvg = rows.reduce((s, r) => s + r.mrrAt10, 0) / rows.length;
    // Any unavailable row is a failed capability gate even when another row
    // of the same modality happened to produce a score.
    //
    // `pass` deliberately stays the R2 recall-floor gate. The frozen parity floors
    // for all three metrics are enforced in `parity-gate.ts`, which is the single
    // place those numbers live; duplicating them into this reporter would create a
    // second copy that could disagree with the preregistered ones.
    byType[t] = { engineAvg, ndcgAvg, mrrAvg, pass: !unavailable && engineAvg >= floor };
  }

  // 0 scored => inconclusive => fail: zero total scored rows can never be green.
  // Unavailable capability rows are excluded from this total; byType and
  // overallPass carry the explicit capability gate failure.
  const scoredTotal = reports.filter((r) => !r.skipped && r.error === undefined).length;
  const scoredRows = validateScoredRows(reports, qrels);
  const overallPass =
    productionSeam &&
    scoredTotal > 0 &&
    scoredRows.valid &&
    types.every((t) => byType[t]!.pass);
  const scoredNdcg = reports
    .filter((row) => !row.skipped && row.error === undefined)
    .map((row) => row.engineNdcg);
  const scoredMrr = reports
    .filter((row) => !row.skipped && row.error === undefined)
    .map((row) => row.mrrAt10);
  const scoredLatency = reports
    .filter((row) => !row.skipped && row.error === undefined)
    .map((row) => row.latencyMs);
  const metrics: HarnessMetrics = scoredTotal > 0
    ? {
        ndcgAt10: {
          mean: scoredNdcg.reduce((sum, value) => sum + value, 0) / scoredNdcg.length,
          ci: bootstrapMeanCI(scoredNdcg, opts.bootstrap),
        },
        mrrAt10: {
          mean: scoredMrr.reduce((sum, value) => sum + value, 0) / scoredMrr.length,
          ci: bootstrapMeanCI(scoredMrr, opts.bootstrap),
        },
        latencyMs: latencyPercentiles(scoredLatency),
      }
    : {
        ndcgAt10: {
          mean: 0,
          ci: {
            estimate: 0,
            ciLow: 0,
            ciHigh: 0,
            lower: 0,
            upper: 0,
            seed: opts.bootstrap?.seed ?? 0x9e3779b9,
            samples: opts.bootstrap?.samples ?? 2_000,
          },
        },
        mrrAt10: {
          mean: 0,
          ci: {
            estimate: 0,
            ciLow: 0,
            ciHigh: 0,
            lower: 0,
            upper: 0,
            seed: opts.bootstrap?.seed ?? 0x9e3779b9,
            samples: opts.bootstrap?.samples ?? 2_000,
          },
        },
        latencyMs: { p50: 0, p95: 0 },
      };

  const measuredArms = armMeasurements ?? ({} as Record<BoostArmId, ArmMeasurement>);
  const baselineArm = measuredArms["boost-zero"];
  const winnerArmId = opts.winnerArmId ?? selectWinnerArm(measuredArms);
  if (winnerArmId === "boost-zero" || !BOOST_ARM_IDS.includes(winnerArmId)) {
    throw new Error(`winnerArmId must be a measured candidate arm: ${winnerArmId}`);
  }
  const candidateArm = measuredArms[winnerArmId];
  if (candidateArm === undefined || baselineArm === undefined) {
    throw new Error("winner selection requires boost-zero and selected candidate measurements");
  }
  const ndcgByClass = Object.fromEntries(
    GOLDEN_QUERY_CLASSES.map((queryClass) => {
      const baseline = baselineArm?.ndcgByClass[queryClass] ?? 0;
      const current = candidateArm?.ndcgByClass[queryClass] ?? 0;
      return [queryClass, { baseline, current, delta: current - baseline }];
    }),
  ) as Record<GoldenQueryClass, MetricPair>;
  const bootstrap: BootstrapCI = baselineArm !== undefined && candidateArm !== undefined &&
    hasMatchingBootstrapRows(candidateArm, baselineArm)
    ? pairedBootstrapMeanCI(candidateArm, baselineArm, opts.bootstrap)
    : metrics.ndcgAt10.ci;
  const c040 = calculateC040(measuredArms, CANONICAL_PRIMARY_CLASSES, bootstrap, winnerArmId);
  const report: HarnessReport = {
    queries: reports,
    byType,
    qrelsHash: actualQrelsHash,
    scoredRows,
    metrics,
    ndcgByClass,
    armIds: BOOST_ARM_IDS,
    arms: measuredArms,
    c040,
    winnerArmId,
    download: false,
    productionSeam,
    p50: metrics.latencyMs.p50,
    p95: {
      baseline: baselineArm?.p95 ?? metrics.latencyMs.p95,
      current: candidateArm?.p95 ?? metrics.latencyMs.p95,
      delta: (candidateArm?.p95 ?? metrics.latencyMs.p95) - (baselineArm?.p95 ?? metrics.latencyMs.p95),
    },
    bootstrap,
    pairedBootstrap: bootstrap,
    overallPass: overallPass && c040.pass,
  };
  const reportPath = envValue("OMS_GOLDEN_REPORT");
  if (reportPath) {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch (e) {
      console.warn("[golden-harness] could not write OMS_GOLDEN_REPORT: " + String(e));
    }
  }
  emitMeasurementManifest(report, opts);
  return report;
}

/**
 * Emit a human-readable summary of the harness report to stdout.
 */
export function printHarnessReport(report: HarnessReport): void {
  console.log("\n=== OMS M1 Retrieval Engine — Golden-Set Recall Report ===\n");

  for (const t of ["lex", "vec", "hyde", "graph"] as QueryType[]) {
    const s = report.byType[t];
    const status = s.pass ? "PASS" : "FAIL";
    // All three metrics are printed per modality. Recall alone hides the failure
    // mode MRR exists to expose: an engine can retrieve the right document
    // somewhere on the page while burying it far enough down that no reader finds it.
    console.log(
      `[${status}] type=${t}  recall=${(s.engineAvg * 100).toFixed(1)}%  ` +
      `nDCG@10=${(s.ndcgAvg * 100).toFixed(1)}%  MRR@10=${(s.mrrAvg * 100).toFixed(1)}%`,
    );
  }

  console.log(`\nOverall: ${report.overallPass ? "PASS" : "FAIL"}`);
  console.log(
    `nDCG@10: ${(report.metrics.ndcgAt10.mean * 100).toFixed(1)}% ` +
    `(bootstrap ${(report.metrics.ndcgAt10.ci.ciLow * 100).toFixed(1)}–${(report.metrics.ndcgAt10.ci.ciHigh * 100).toFixed(1)}%)`,
  );
  console.log(
    `MRR@10: ${(report.metrics.mrrAt10.mean * 100).toFixed(1)}% ` +
    `(bootstrap ${(report.metrics.mrrAt10.ci.ciLow * 100).toFixed(1)}–${(report.metrics.mrrAt10.ci.ciHigh * 100).toFixed(1)}%)`,
  );
  console.log(
    `Latency: p50=${report.metrics.latencyMs.p50.toFixed(2)}ms p95=${report.metrics.latencyMs.p95.toFixed(2)}ms`,
  );

  const scored = report.queries.filter((r) => !r.skipped);
  const skipped = report.queries.filter((r) => r.skipped);
  console.log(
    `Queries: ${report.queries.length}  scored: ${scored.length}  skipped(uncurated): ${skipped.length}  passed: ${scored.filter((r) => r.pass).length}`,
  );
  if (!report.scoredRows.valid) {
    console.log(`Scored-row validation: FAIL (${report.scoredRows.errors.join("; ")})`);
  }

  const failing = scored.filter((r) => !r.pass);
  if (failing.length > 0) {
    console.log("\nFailing queries:");
    for (const r of failing) {
      console.log(`  [${r.id}] engine=${(r.engineRecall * 100).toFixed(0)}%  query="${r.query.slice(0, 60)}"`);
    }
  }
  const unavailable = scored.filter((r) => r.error !== undefined);
  if (unavailable.length > 0) {
    console.log("\nUnavailable modalities:");
    for (const row of unavailable) console.log(`  [${row.id}] ${row.error}`);
  }
  console.log();
}
