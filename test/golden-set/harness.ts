/**
 * Golden-set recall harness for the native retrieval engine.
 *
 * After the src/search teardown there is no second backend to compare against,
 * so this is an ENGINE-ONLY recall gate (previously a parity comparator vs the
 * retired src/search baseline). For each curated golden query:
 *   1. Run the engine via runTracer().
 *   2. Compute recall@10 = |expected ∩ top-10| / |expected|.
 *   3. Emit a JSON report row.
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
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runTracer, makeTracerConfig, type TracerConfig } from "../../src/kernel/engine/tracer.js";
import { GOLDEN_QUERIES, type GoldenQuery, type QueryType } from "./queries.js";

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

/** Minimum per-type engine recall@10 average required to pass (default 0.5). */
function recallFloor(): number {
  const raw = process.env["OMS_GOLDEN_MIN_RECALL"];
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
  readonly query: string;
  readonly expected: string[];
  readonly engineTop10: string[];
  readonly engineRecall: number;
  /** true when engineRecall >= floor (curated queries only). */
  readonly pass: boolean;
  /**
   * true when the query was uncurated and excluded from scoring.
   * Skipped rows are included in queries[] for count-consistency but are
   * excluded from all recall averages and gates.
   */
  readonly skipped: boolean;
}

export interface HarnessReport {
  readonly queries: QueryReport[];
  readonly byType: Record<QueryType, { engineAvg: number; pass: boolean }>;
  readonly overallPass: boolean;
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
 * Run the full golden-set recall comparison and return a structured report.
 *
 * Uncurated queries (curated !== true) are excluded from scoring with a
 * console.warn and appear in report.queries with skipped:true.
 *
 * Uses a temporary SQLite DB (cleaned up after the run) unless opts.dbPath
 * or OMS_GOLDEN_DB is set.
 */
export async function runHarness(opts: HarnessOptions = {}): Promise<HarnessReport> {
  const vaultPath = opts.vaultPath ?? process.env["OMS_VAULT"] ?? process.cwd();
  const floor = recallFloor();

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
          engineRecall: 0,
          pass: false, // explicitly false; excluded from gate by skipped:true
          skipped: true,
        });
        continue;
      }

      // ── Curated query: run the engine (fail-loud) ──────────────────────────
      const engineTop10 = await runEngine(q, config, opts.files);
      const engineRecall = recall(engineTop10, q.expectedNotes);
      const pass = engineRecall >= floor;

      reports.push({
        id: q.id,
        type: q.type,
        query: q.query,
        expected: q.expectedNotes,
        engineTop10,
        engineRecall,
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
  const byType = {} as Record<QueryType, { engineAvg: number; pass: boolean }>;

  for (const t of types) {
    // Exclude skipped (uncurated) queries from all averages and gates
    const rows = reports.filter((r) => r.type === t && !r.skipped);
    // 0 scored => inconclusive => fail: an unmeasured type is never a pass.
    if (rows.length === 0) {
      byType[t] = { engineAvg: 0, pass: false };
      continue;
    }
    const engineAvg = rows.reduce((s, r) => s + r.engineRecall, 0) / rows.length;
    byType[t] = { engineAvg, pass: engineAvg >= floor };
  }

  // 0 scored => inconclusive => fail: zero total scored rows can never be green.
  const scoredTotal = reports.filter((r) => !r.skipped).length;
  const overallPass = scoredTotal > 0 && types.every((t) => byType[t]!.pass);

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
  console.log("\n=== OMS M1 Retrieval Engine — Golden-Set Recall Report ===\n");

  for (const t of ["lex", "vec", "hyde", "graph"] as QueryType[]) {
    const s = report.byType[t];
    const status = s.pass ? "PASS" : "FAIL";
    console.log(`[${status}] type=${t}  engine=${(s.engineAvg * 100).toFixed(1)}%`);
  }

  console.log(`\nOverall: ${report.overallPass ? "PASS" : "FAIL"}`);

  const scored = report.queries.filter((r) => !r.skipped);
  const skipped = report.queries.filter((r) => r.skipped);
  console.log(
    `Queries: ${report.queries.length}  scored: ${scored.length}  skipped(uncurated): ${skipped.length}  passed: ${scored.filter((r) => r.pass).length}`,
  );

  const failing = scored.filter((r) => !r.pass);
  if (failing.length > 0) {
    console.log("\nFailing queries:");
    for (const r of failing) {
      console.log(`  [${r.id}] engine=${(r.engineRecall * 100).toFixed(0)}%  query="${r.query.slice(0, 60)}"`);
    }
  }
  console.log();
}
