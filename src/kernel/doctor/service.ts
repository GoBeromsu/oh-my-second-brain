import { stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { repairEngineStore, type EngineStoreRepairPlan } from "../engine/embed/repair.js";
import { openEngineStoreCoreReadOnly } from "../engine/embed/store.js";
import { walkMarkdown } from "../engine/embed/sync.js";
import { engineStorePath } from "../engine/paths.js";
import { handleSemanticTool } from "../semantic/semantic-retrieve.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";

export type DoctorRepairOperation = "build-graph" | "repair-index" | "semantic-cleanup" | "sync-embeddings";

type SemanticIndexPostcondition = {
  readonly kind: "semantic-index";
  readonly databasePath: string;
  readonly documentPaths: readonly string[];
  readonly chunks: number;
  readonly orphanDocumentPaths: readonly string[];
};

export type DoctorRepairReceipt =
  | {
      readonly operation: "build-graph";
      readonly resolvedVault: string;
      readonly resolutionSource: WriteTargetSource;
      readonly written: { readonly paths: readonly string[]; readonly summary: { readonly notes: number; readonly edges: number } };
      readonly postcondition: { readonly kind: "template-graph-cache"; readonly cachePaths: readonly string[]; readonly generatedAt: string; readonly notes: number; readonly edges: number };
    }
  | {
      readonly operation: "semantic-cleanup" | "sync-embeddings";
      readonly resolvedVault: string;
      readonly resolutionSource: WriteTargetSource;
      readonly written: { readonly paths: readonly string[]; readonly summary: Record<string, unknown> };
      readonly postcondition: SemanticIndexPostcondition;
    }
  | {
      readonly operation: "repair-index";
      readonly resolvedVault: string;
      readonly resolutionSource: WriteTargetSource;
      readonly written: { readonly paths: readonly string[]; readonly summary: EngineStoreRepairPlan };
      readonly postcondition?: {
        readonly kind: "engine-store";
        readonly mode: "rebuild";
        readonly databasePath: string;
        readonly integrity: "ok";
        readonly tables: readonly string[];
        readonly backupPaths: readonly string[];
      } | {
        readonly kind: "engine-store-absent";
        readonly mode: "drop";
        readonly absentPaths: readonly string[];
        readonly backupPaths: readonly string[];
      };
    };

export type DoctorRepairResult =
  | { readonly kind: "rejected"; readonly value: { readonly status: "rejected"; readonly rejection: unknown; readonly resolvedVault: string; readonly resolutionSource: WriteTargetSource } }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "completed"; readonly value: Record<string, unknown> };

async function semanticIndexPostcondition(vault: string): Promise<SemanticIndexPostcondition> {
  const databasePath = engineStorePath(vault);
  await stat(databasePath);
  const database = new Database(databasePath, { readonly: true });
  try {
    const documentPaths = (database.prepare("SELECT DISTINCT doc_path FROM engine_chunk_meta ORDER BY doc_path").all() as { doc_path: string }[]).map((row) => row.doc_path);
    const chunks = (database.prepare("SELECT COUNT(*) AS count FROM engine_chunk_meta").get() as { count: number }).count;
    const livePaths = new Set<string>();
    for await (const notePath of walkMarkdown(vault, vault)) livePaths.add(notePath);
    return { kind: "semantic-index", databasePath, documentPaths, chunks, orphanDocumentPaths: documentPaths.filter((notePath) => !livePaths.has(notePath)) };
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairIndexArgs(args: Record<string, unknown> | undefined): { readonly repairMode: "rebuild" | "drop"; readonly dryRun?: boolean } {
  if (!args || (args["repairMode"] !== "rebuild" && args["repairMode"] !== "drop")) {
    throw new TypeError('Doctor repair "repair-index" requires repairMode "rebuild" or "drop".');
  }
  if (args["dryRun"] !== undefined && typeof args["dryRun"] !== "boolean") {
    throw new TypeError('Doctor repair "repair-index" dryRun must be a boolean.');
  }
  const unsupported = Object.keys(args).filter((key) => key !== "repairMode" && key !== "dryRun");
  if (unsupported.length > 0) {
    throw new TypeError(`Doctor repair "repair-index" received unsupported arguments: ${unsupported.join(", ")}.`);
  }
  return { repairMode: args["repairMode"], ...(args["dryRun"] === undefined ? {} : { dryRun: args["dryRun"] }) };
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(paths.map(async (candidate) => {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") return null;
      throw error;
    }
  }));
  return found.filter((candidate): candidate is string => candidate !== null);
}

async function repairIndexReceipt(
  plan: EngineStoreRepairPlan,
  sourceFiles: readonly string[],
  resolvedVault: string,
  resolutionSource: WriteTargetSource,
): Promise<DoctorRepairReceipt> {
  const sourcePaths = [plan.storePath, `${plan.storePath}-wal`, `${plan.storePath}-shm`];
  const backupPaths = plan.backupPath === null
    ? []
    : sourceFiles.map((sourceFile) => `${plan.backupPath}${sourceFile.slice(plan.storePath.length)}`);

  if (plan.dryRun) {
    return {
      operation: "repair-index",
      resolvedVault,
      resolutionSource,
      written: { paths: [], summary: plan },
    };
  }

  const existingBackups = await existingPaths(backupPaths);
  if (existingBackups.length !== backupPaths.length) {
    throw new Error("Engine store repair postcondition failed: a preserved backup is missing.");
  }

  if (plan.mode === "drop") {
    const remaining = await existingPaths(sourcePaths);
    if (remaining.length > 0) {
      throw new Error(`Engine store repair postcondition failed: drop left source files: ${remaining.join(", ")}.`);
    }
    return {
      operation: "repair-index",
      resolvedVault,
      resolutionSource,
      written: { paths: backupPaths, summary: plan },
      postcondition: { kind: "engine-store-absent", mode: "drop", absentPaths: sourcePaths, backupPaths },
    };
  }

  let database: Database.Database;
  try {
    database = new Database(plan.storePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error("Engine store repair postcondition failed: rebuilt store could not be read.", { cause: error });
  }
  let tables: string[];
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Engine store repair postcondition failed: SQLite integrity check returned ${String(integrity)}.`);
    tables = (database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const missing = ["engine_meta", "engine_chunk_meta", "engine_chunk_fts"].filter((table) => !tables.includes(table));
    if (missing.length > 0) throw new Error(`Engine store repair postcondition failed: rebuilt schema is missing ${missing.join(", ")}.`);
  } finally {
    database.close();
  }
  try {
    const store = openEngineStoreCoreReadOnly(plan.storePath);
    if (store === null) throw new Error("rebuilt store is absent");
    store.close();
  } catch (error) {
    throw new Error("Engine store repair postcondition failed: rebuilt schema is incompatible.", { cause: error });
  }
  return {
    operation: "repair-index",
    resolvedVault,
    resolutionSource,
    written: { paths: [plan.storePath, ...backupPaths], summary: plan },
    postcondition: { kind: "engine-store", mode: "rebuild", databasePath: plan.storePath, integrity: "ok", tables, backupPaths },
  };
}

export async function repairDoctor(
  { operation, vault, source, args, resolveAdapter }: {
    readonly operation: DoctorRepairOperation;
    readonly vault: string;
    readonly source: WriteTargetSource;
    readonly args: Record<string, unknown> | undefined;
    /**
     * Deferred on purpose. Constructing a semantic adapter opens - and
     * therefore creates - `<vault>/.oms/engine-store.sqlite`, so accepting an
     * already-built adapter would let that mutation happen in the caller's
     * argument list, before this function ever runs admission. Taking a factory
     * keeps admission the first effectful step even though the caller decides
     * WHICH adapter is appropriate.
     */
    readonly resolveAdapter?: () => McpEngineAdapter;
  },
): Promise<DoctorRepairResult> {
  const indexArgs = operation === "repair-index" ? repairIndexArgs(args) : undefined;
  const rejection = await admitWriteTarget({ vault, source });
  if (rejection) return { kind: "rejected", value: { status: "rejected", rejection, resolvedVault: vault, resolutionSource: source } };

  if (operation === "repair-index") {
    const { repairMode, dryRun } = indexArgs!;
    const storePath = engineStorePath(vault);
    const sourceFiles = await existingPaths([storePath, `${storePath}-wal`, `${storePath}-shm`]);
    const plan = repairEngineStore({ vault, mode: repairMode, dryRun });
    const receipt = await repairIndexReceipt(plan, sourceFiles, vault, source);
    return { kind: "completed", value: { ...plan, resolvedVault: vault, resolutionSource: source, receipt } };
  }

  if (operation === "build-graph") {
    if (!resolveAdapter) throw new Error('Doctor repair "build-graph" requires a graph adapter.');
    const adapter = resolveAdapter();
    const built = await adapter.graphBuild({}, vault);
    const status = await adapter.graphStatus(vault);
    if (!status.available || typeof status.generatedAt !== "string" || status.notes !== built.notes || status.edges !== built.edges) {
      throw new Error("Template graph postcondition failed: persisted caches do not match the completed build.");
    }
    const cachePaths = [path.join(vault, ".oms", "cache", "engine", "graph.json"), path.join(vault, ".oms", "cache", "engine", "node-index.json")];
    const receipt: DoctorRepairReceipt = {
      operation, resolvedVault: vault, resolutionSource: source,
      written: { paths: cachePaths, summary: { notes: status.notes, edges: status.edges } },
      postcondition: { kind: "template-graph-cache", cachePaths, generatedAt: status.generatedAt, notes: status.notes, edges: status.edges },
    };
    return { kind: "completed", value: { vault, ...built, cachePaths, resolvedVault: vault, resolutionSource: source, receipt } };
  }

  if (!resolveAdapter) throw new Error(`Doctor repair "${operation}" requires a semantic adapter.`);
  // Admission has passed; only now is it safe to let adapter construction touch
  // the vault.
  const adapter = resolveAdapter();
  const name = operation === "semantic-cleanup" ? "oms_semantic_cleanup" : "oms_sync_embeddings";
  const semanticResult = await handleSemanticTool(name, args, vault, adapter);
  if (!semanticResult) throw new Error(`Doctor repair "${operation}" was not handled.`);
  if (!semanticResult.ok) return { kind: "error", message: semanticResult.message };
  if (!isRecord(semanticResult.value) || semanticResult.value["available"] !== true) return { kind: "completed", value: semanticResult.value as Record<string, unknown> };
  const postcondition = await semanticIndexPostcondition(vault);
  if (postcondition.orphanDocumentPaths.length > 0) throw new Error("Semantic index postcondition failed: stored documents include paths outside the live vault.");
  const receipt: DoctorRepairReceipt = {
    operation, resolvedVault: vault, resolutionSource: source,
    written: { paths: [postcondition.databasePath], summary: semanticResult.value },
    postcondition,
  };
  return { kind: "completed", value: { ...semanticResult.value, resolvedVault: vault, resolutionSource: source, receipt } };
}
