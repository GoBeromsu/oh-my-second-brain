import Database from "better-sqlite3";
import type { AssembledEngine } from "../../src/kernel/engine/assemble.js";
import type { QueryReport } from "./harness.js";
import type { OperabilityInput, ParityModality } from "./parity-gate.js";
import {
  measureOperation,
  p95,
  type OperabilityProbes,
} from "./parity-operability.js";
import {
  runOmsComparatorArm,
  type ParityArmRow,
} from "./parity-comparator.js";
import type { FrozenSettings } from "./parity-preregistration.js";

export interface OmsMeasuredParityArm {
  readonly rows: readonly ParityArmRow[];
  readonly operability: OperabilityInput;
  readonly sync: {
    readonly available: boolean;
    readonly scanned: number;
    readonly added: number;
    readonly updated: number;
    readonly skipped: number;
    readonly reason?: string;
  };
  readonly plainQueryErrors: readonly string[];
}

interface StoredCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly vectors: number;
}

export interface OmsMeasuredParityOptions {
  readonly engine: Pick<AssembledEngine, "adapter" | "syncVault">;
  readonly queries: readonly Pick<QueryReport, "id" | "type" | "queryClass" | "query">[];
  readonly settings: FrozenSettings;
  readonly dbPath: string;
  readonly files?: readonly string[];
  readonly sampleIntervalMs?: number;
  readonly probes?: Partial<OperabilityProbes>;
  /** Deterministic unit-test seam; production reads the real SQLite generation. */
  readonly inspectCounts?: () => StoredCounts;
}

function inspectStore(dbPath: string): StoredCounts {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const documents = (db.prepare(
      "SELECT COUNT(DISTINCT doc_path) AS count FROM engine_chunk_meta",
    ).get() as { count: number }).count;
    const chunks = (db.prepare(
      "SELECT COUNT(*) AS count FROM engine_chunk_meta",
    ).get() as { count: number }).count;
    const vectorTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='engine_chunk_vec'",
    ).get() as { present: 1 } | undefined;
    const vectors = vectorTable === undefined
      ? 0
      : (db.prepare("SELECT COUNT(*) AS count FROM engine_chunk_vec").get() as { count: number }).count;
    return { documents, chunks, vectors };
  } finally {
    db.close();
  }
}

function boundedP95(values: readonly number[]): number {
  return values.length === 0 ? Number.MAX_SAFE_INTEGER : p95(values);
}

function selectedModalities(settings: FrozenSettings): readonly ParityModality[] {
  return settings.expansion ? ["lex", "vec", "hyde"] : ["lex", "vec"];
}

/**
 * Build the OMS operability input from the same sync and queries that produce
 * relevance rows. No caller-supplied p95/count/vector values enter this path.
 */
export async function runOmsMeasuredParityArm(
  options: OmsMeasuredParityOptions,
): Promise<OmsMeasuredParityArm> {
  const intervalMs = options.sampleIntervalMs ?? 100;
  const measured = await measureOperation(async (tracker) => {
    const interval = intervalMs > 0
      ? setInterval(() => tracker.mark(), intervalMs)
      : undefined;
    interval?.unref();
    try {
      return await options.engine.syncVault({
        files: options.files,
        embed: true,
      });
    } finally {
      if (interval !== undefined) clearInterval(interval);
      tracker.mark();
    }
  }, options.probes);
  const sync = measured.result;

  const selected = options.queries.filter((query) =>
    selectedModalities(options.settings).includes(query.type as ParityModality));
  const plainLatencies: number[] = [];
  const plainQueryErrors: string[] = [];
  // B2 precision p95 must not replace the plain-query bound. Measure a lexical-
  // only request for the same frozen rows before the expanded arm.
  if (options.settings.expansion) {
    for (const query of selected) {
      const started = options.probes?.now?.() ?? performance.now();
      const result = await options.engine.adapter.semanticQuery({
        query: query.query,
        limit: options.settings.k,
      });
      const finished = options.probes?.now?.() ?? performance.now();
      plainLatencies.push(Math.max(0, finished - started));
      if (!result.available) plainQueryErrors.push(`${query.id}: ${result.reason}`);
    }
  }

  const rows = await runOmsComparatorArm(
    options.queries,
    options.settings,
    options.engine.adapter,
    options.probes?.now,
  );
  const counts = (options.inspectCounts ?? (() => inspectStore(options.dbPath)))();
  const successfulLatencies = rows
    .filter((row) => row.error === undefined)
    .map((row) => row.latencyMs);
  const syncAvailable = sync.available;
  const queryFailed = rows.some((row) => row.error !== undefined) || plainQueryErrors.length > 0;
  const operability: OperabilityInput = {
    exitCode: syncAvailable && !queryFailed ? 0 : 1,
    scanned: sync.scanned,
    // Fresh and incremental runs both retain vector parity. `indexed` here is
    // work performed in this run, while skipped captures unchanged documents.
    indexed: sync.added + sync.updated,
    skipped: sync.skipped,
    errors: syncAvailable ? 0 : 1,
    vectorCount: counts.vectors,
    expectedVectorCount: counts.chunks,
    peakRssBytes: measured.peakRssBytes,
    embedWallMs: measured.wallMs,
    plainQueryP95Ms: options.settings.expansion
      ? boundedP95(plainLatencies)
      : boundedP95(successfulLatencies),
    ...(options.settings.expansion
      ? { precisionQueryP95Ms: boundedP95(successfulLatencies) }
      : {}),
  };

  return {
    rows,
    operability,
    sync: {
      available: sync.available,
      scanned: sync.scanned,
      added: sync.added,
      updated: sync.updated,
      skipped: sync.skipped,
      ...(sync.reason === undefined ? {} : { reason: sync.reason }),
    },
    plainQueryErrors,
  };
}
