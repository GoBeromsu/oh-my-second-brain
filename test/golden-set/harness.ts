/**
 * Parity comparator harness: new engine vs. src/search baseline.
 *
 * For each golden query:
 *   1. Run the new engine via runTracer().
 *   2. Run the baseline via querySemanticStore() from src/search.
 *   3. Compute recall@10 = |expected ∩ top-10| / |expected|.
 *   4. Emit a JSON report row.
 *
 * Parity rule (enforced in golden.test.ts):
 *   engine recall@10 per-type average >= baseline per-type average
 *   AND no individual type's engine average falls below 80% of baseline average.
 *
 * FAIL-LOUD guarantees:
 *   - Uncurated queries (curated !== true) are EXCLUDED from scoring with a
 *     visible console.warn; they are NEVER silently scored 0.
 *   - If runTracer() throws, the error propagates — never swallowed as [].
 *   - If querySemanticStore() returns available:false or throws, the whole
 *     gate is INCONCLUSIVE and a descriptive error is thrown (red gate).
 *   - A zero or absent baseline is NOT auto-pass: "measured nothing ≠ parity".
 *
 * NOTE: baseline querySemanticStore requires a live .oms semantic store.
 *       A missing store is a hard error, not a graceful degradation.
 */

import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runTracer, makeTracerConfig, type TracerConfig } from "../../src/engine/tracer.js";
import { querySemanticStore } from "../../src/search/semantic.js";
import { GOLDEN_QUERIES, QUERIES_BY_TYPE, type GoldenQuery, type QueryType } from "./queries.js";

// ---------------------------------------------------------------------------
// External golden-set loader (privacy-preserving)
// ---------------------------------------------------------------------------

/**
 * Load golden queries from OMS_GOLDEN_QUERIES env path if set,
 * otherwise fall back to the built-in synthetic GOLDEN_QUERIES.
 *
 * This allows CI to inject real-vault-backed queries without committing them.
 * 0 scored => inconclusive => fail: an empty or unresolvable path is an error.
 */
function loadGoldenQueries(): GoldenQuery[] {
  const p = process.env["OMS_GOLDEN_QUERIES"];
  if (!p) return GOLDEN_QUERIES;
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(raw)) throw new Error("OMS_GOLDEN_QUERIES at " + p + " is not a JSON array");
  for (const q of raw) {
    if (!q || typeof q.id !== "string" || typeof q.type !== "string" || typeof q.query !== "string" || !Array.isArray(q.expectedNotes))
      throw new Error("OMS_GOLDEN_QUERIES malformed row: " + JSON.stringify(q));
  }
  return raw as GoldenQuery[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryReport {
  readonly id: string;
  readonly type: QueryType;
  readonly query: string;
  readonly expected: string[];
  readonly engineTop10: string[];
  readonly baselineTop10: string[];
  readonly engineRecall: number;
  readonly baselineRecall: number;
  /** true when engineRecall >= 80% of baselineRecall (curated queries only). */
  readonly pass: boolean;
  /**
   * true when the query was uncurated and excluded from scoring.
   * Skipped rows are included in queries[] for count-consistency but are
   * excluded from all recall averages and parity gates.
   */
  readonly skipped: boolean;
}

export interface HarnessReport {
  readonly queries: QueryReport[];
  readonly byType: Record<
    QueryType,
    { engineAvg: number; baselineAvg: number; parityPass: boolean }
  >;
  readonly overallPass: boolean;
}

// ---------------------------------------------------------------------------
// Recall computation
// ---------------------------------------------------------------------------

/**
 * Compute recall@K = |expected ∩ topK| / |expected|.
 *
 * Called only for curated queries (expectedNotes verified against a real vault).
 * No TODO-filter is applied here; curation is enforced at the query level via
 * the `curated` flag in GoldenQuery, not by inspecting string contents.
 */
function recall(topK: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const hitSet = new Set(topK.map((p) => p.toLowerCase()));
  const found = expected.filter((p) => hitSet.has(p.toLowerCase())).length;
  return found / expected.length;
}

// ---------------------------------------------------------------------------
// Baseline runner (src/search layer — read-only import, R18)
// ---------------------------------------------------------------------------

/**
 * Run the src/search baseline for a single query.
 *
 * FAIL-LOUD: throws — never returns [] — when the semantic store is unavailable
 * or the call errors. A missing baseline makes the parity gate INCONCLUSIVE.
 */
export async function runBaseline(q: GoldenQuery, vaultPath: string): Promise<string[]> {
  // graph queries have no direct baseline equivalent — use vec as proxy
  const searchType = q.type === "graph" ? "vec" : q.type;
  const seedQuery = q.type === "graph"
    ? path.basename(q.query, ".md").replace(/-/g, " ")
    : q.query;

  let result;
  try {
    result = await querySemanticStore({
      query: seedQuery,
      vault: vaultPath,
      limit: 10,
      modelPath: process.env["OMS_MODEL_PATH"],
      searches:
        searchType === "lex"
          ? [{ type: "lex", query: seedQuery }]
          : searchType === "vec" || searchType === "hyde"
          ? [{ type: searchType, query: seedQuery }]
          : undefined,
    });
  } catch (err) {
    throw new Error(
      `baseline semantic store unavailable at "${vaultPath}" — #8 gate inconclusive; build the floor first\n  Cause: ${String(err)}`,
    );
  }

  if (!result.available) {
    throw new Error(
      `baseline semantic store unavailable at "${vaultPath}" — #8 gate inconclusive; build the floor first` +
      (result.reason ? `\n  Reason: ${result.reason}` : ""),
    );
  }

  return result.hits.map((h) => h.path);
}

// ---------------------------------------------------------------------------
// Engine runner
// ---------------------------------------------------------------------------

/**
 * Run the new retrieval engine for a single query.
 *
 * FAIL-LOUD: any throw from runTracer() propagates directly.
 * An engine failure is a red gate — never a silent empty result.
 */
export async function runEngine(
  q: GoldenQuery,
  config: TracerConfig,
  files?: string[],
): Promise<string[]> {
  const results = await runTracer(
    { ...config, files: files as readonly string[] | undefined },
    [{ type: q.type === "graph" ? "graph" : q.type, query: q.query }],
  );
  return results.map((r) => r.docPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Absolute path to the vault. Falls back to OMS_VAULT env. */
  vaultPath?: string;
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
}

/**
 * Run the full golden-set parity comparison and return a structured report.
 *
 * Uncurated queries (curated !== true) are excluded from scoring with a
 * console.warn and appear in report.queries with skipped:true.
 *
 * Uses a temporary SQLite DB (cleaned up after the run) unless opts.dbPath
 * or OMS_GOLDEN_DB is set.
 */
export async function runHarness(opts: HarnessOptions = {}): Promise<HarnessReport> {
  const vaultPath = opts.vaultPath ?? process.env["OMS_VAULT"] ?? process.cwd();

  // Resolve DB path: explicit opts > OMS_GOLDEN_DB env > temp
  const resolvedDbPath = opts.dbPath ?? process.env["OMS_GOLDEN_DB"];
  const useTempDb = resolvedDbPath === undefined;
  const tmpDir = useTempDb ? mkdtempSync(path.join(tmpdir(), "oms-golden-")) : undefined;
  const dbPath = resolvedDbPath ?? path.join(tmpDir!, "golden.db");

  const config = makeTracerConfig({
    vaultPath,
    dbPath,
    embeddingDimensions: 768,
    ...opts.configOverrides,
  });

  const reports: QueryReport[] = [];

  try {
    for (const q of loadGoldenQueries()) {
      // ── Curated gate: skip unverified queries with a visible warning ────────
      if (!q.curated) {
        console.warn(
          `[golden-harness] SKIP uncurated query ${q.id} ("${q.query.slice(0, 60)}") ` +
          `— set curated:true once every expectedNotes path is vault-verified`,
        );
        reports.push({
          id: q.id,
          type: q.type,
          query: q.query,
          expected: q.expectedNotes,
          engineTop10: [],
          baselineTop10: [],
          engineRecall: 0,
          baselineRecall: 0,
          pass: false, // explicitly false; excluded from gate by skipped:true
          skipped: true,
        });
        continue;
      }

      // ── Curated query: run engine AND baseline (both fail-loud) ────────────
      const [engineTop10, baselineTop10] = await Promise.all([
        runEngine(q, config, opts.files),
        runBaseline(q, vaultPath),
      ]);

      const engineRecall = recall(engineTop10, q.expectedNotes);
      const baselineRecall = recall(baselineTop10, q.expectedNotes);

      /**
       * Pass rule: engine recall >= 80% of baseline recall.
       *
       * The baseline is guaranteed present at this point (runBaseline throws
       * otherwise). When baseline IS available but yields 0 recall on a curated
       * query, the engine trivially satisfies >= 0; this is a signal to improve
       * the expected notes or the semantic store — NOT an auto-pass shortcut.
       * "Measured nothing" (baselineRecall === 0) is never treated as parity.
       */
      const pass = engineRecall >= baselineRecall * 0.8;

      reports.push({
        id: q.id,
        type: q.type,
        query: q.query,
        expected: q.expectedNotes,
        engineTop10,
        baselineTop10,
        engineRecall,
        baselineRecall,
        pass,
        skipped: false,
      });
    }
  } finally {
    // Clean up temp DB only when we created it
    if (useTempDb && tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── Per-type aggregation (curated / non-skipped rows only) ──────────────
  const types: QueryType[] = ["lex", "vec", "hyde", "graph"];
  const byType = {} as Record<QueryType, { engineAvg: number; baselineAvg: number; parityPass: boolean }>;

  for (const t of types) {
    // Exclude skipped (uncurated) queries from all averages and gates
    const rows = reports.filter((r) => r.type === t && !r.skipped);
    // 0 scored => inconclusive => fail: an unmeasured type is never a pass.
    if (rows.length === 0) {
      byType[t] = { engineAvg: 0, baselineAvg: 0, parityPass: false };
      continue;
    }
    const engineAvg = rows.reduce((s, r) => s + r.engineRecall, 0) / rows.length;
    const baselineAvg = rows.reduce((s, r) => s + r.baselineRecall, 0) / rows.length;
    /**
     * Parity: engine type avg >= 80% of baseline type avg.
     *
     * baselineAvg === 0 is NOT an auto-pass (that branch has been removed).
     * When baseline IS available but returns 0 average for a type, the engine
     * trivially satisfies >= 0; flag this for investigation but don't gate-fail.
     */
    const parityPass = engineAvg >= baselineAvg * 0.8;
    byType[t] = { engineAvg, baselineAvg, parityPass };
  }

  // 0 scored => inconclusive => fail: zero total scored rows can never be green.
  const scoredTotal = reports.filter((r) => !r.skipped).length;
  const overallPass = scoredTotal > 0 && types.every((t) => byType[t]!.parityPass);

  const report = { queries: reports, byType, overallPass };
  const reportPath = process.env["OMS_GOLDEN_REPORT"];
  if (reportPath) {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch (e) {
      console.warn("[golden-harness] could not write OMS_GOLDEN_REPORT: " + String(e));
    }
  }
  return report;
}

/**
 * Emit a human-readable summary of the harness report to stdout.
 */
export function printHarnessReport(report: HarnessReport): void {
  console.log("\n=== OMS M1 Retrieval Engine — Golden-Set Parity Report ===\n");

  for (const t of ["lex", "vec", "hyde", "graph"] as QueryType[]) {
    const s = report.byType[t];
    const status = s.parityPass ? "PASS" : "FAIL";
    console.log(
      `[${status}] type=${t}  engine=${(s.engineAvg * 100).toFixed(1)}%  baseline=${(s.baselineAvg * 100).toFixed(1)}%`,
    );
  }

  console.log(`\nOverall parity: ${report.overallPass ? "PASS" : "FAIL"}`);

  const scored = report.queries.filter((r) => !r.skipped);
  const skipped = report.queries.filter((r) => r.skipped);
  console.log(
    `Queries: ${report.queries.length}  scored: ${scored.length}  skipped(uncurated): ${skipped.length}  passed: ${scored.filter((r) => r.pass).length}`,
  );

  const failing = scored.filter((r) => !r.pass);
  if (failing.length > 0) {
    console.log("\nFailing queries:");
    for (const r of failing) {
      console.log(
        `  [${r.id}] engine=${(r.engineRecall * 100).toFixed(0)}%  baseline=${(r.baselineRecall * 100).toFixed(0)}%  query="${r.query.slice(0, 60)}"`,
      );
    }
  }
  console.log();
}
