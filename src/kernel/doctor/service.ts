import { realpath, stat } from "node:fs/promises";
import { engineGraphCachePath, engineNodeCachePath, engineStorePath } from "../engine/paths.js";
import Database from "better-sqlite3";
import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { repairEngineStore, type EngineStoreRepairPlan } from "../engine/embed/repair.js";
import { openEngineStoreCoreReadOnly } from "../engine/embed/store.js";
import { walkMarkdown } from "../engine/embed/sync.js";
import { completeDirtyDrain, prepareDirtyDrain } from "../engine/index-update.js";
import { handleSemanticTool } from "../semantic/semantic-retrieve.js";
import { lineageHealth, type LineageFindingKind } from "../contract/lineage-health.js";
import { StateDirUnsafe } from "../contract/state-dir.js";
import { readSnapshot } from "../contract/generation-snapshot.js";
import { readStore, recoverLineage, storeRoot } from "../contract/store.js";
import { resolveSealState } from "../contract/vault-id.js";
import { appendEvolutionEvent } from "../evolution/events.js";
import { withEvolutionLock } from "../evolution/evolution-lock.js";
import { lineageTail } from "../evolution/request-state.js";
import { isEvolutionOperation, runEvolutionOp, type DoctorHuman, type EvolutionOperation } from "./evolution-ops.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";

export type DoctorRepairOperation = "build-graph" | "lineage-reanchor" | "lineage-recover" | "repair-index" | "semantic-cleanup" | "sync-embeddings" | EvolutionOperation;
export type { DoctorHuman } from "./evolution-ops.js";

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
      readonly operation: "lineage-recover" | "lineage-reanchor";
      readonly resolvedVault: string;
      readonly resolutionSource: WriteTargetSource;
      /** Store-relative names only: the store path carries the vault id. */
      readonly written: { readonly paths: readonly string[]; readonly summary: { readonly snapshots: number; readonly anchors: number } };
      readonly postcondition: { readonly kind: "contract-lineage"; readonly events: number; readonly snapshots: number };
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

/** What a lineage repair must leave behind: the lineage ends at the linked generation. */
const LINEAGE_UNRECORDED: ReadonlySet<LineageFindingKind> = new Set(["before-bootstrap", "lineage-unrecorded-seal", "lineage-seq-restart", "lineage-gap", "lineage-unreadable"]);

/** Errors the contract store authors carry a fixed code and no path; anything else is rethrown. */
function contractErrorMessage(error: unknown): string | null {
  if (error instanceof StateDirUnsafe) return `STATE_DIR_UNSAFE: the contract store holds an unsafe entry (${error.kind}); it was left untouched`;
  if (error instanceof Error && /^(CONTRACT|EVOLUTION)_[A-Z_]+:/.test(error.message)) return error.message;
  return null;
}

/**
 * Rows lineage recovery accepts. A first seal whose lineage append failed stops before
 * `writeIndexEntry` and reads back as `store-without-index` (or `vault-moved` when an old
 * index path also names the id); recovery records its index entry, so the documented
 * `oms doctor lineage-recover` finishes that seal instead of refusing it.
 */
const LINEAGE_RECOVERABLE: ReadonlySet<string> = new Set(["sealed", "store-without-index", "vault-moved"]);

async function repairLineage(operation: "lineage-recover" | "lineage-reanchor", vault: string, source: WriteTargetSource): Promise<DoctorRepairResult> {
  const root = storeRoot();
  const state = await resolveSealState(vault, root);
  const vaultId = state.vaultId;
  const unindexed = state.row !== "sealed";
  if (!LINEAGE_RECOVERABLE.has(state.row) || vaultId === null || (unindexed && state.view.state !== "sealed")) {
    return { kind: "error", message: "CONTRACT_NOT_SEALED: the vault has no readable sealed contract here; run oms doctor contract" };
  }
  // A copy whose original still exists must not claim the shared id's index entry (interview.ts refuses the same row).
  if (unindexed && state.shared) {
    return { kind: "error", message: "CONTRACT_VAULT_ID_SHARED: another existing vault uses this vault id (a copied vault); remove .oms/settings.json in the copy, then run `oms setup` again" };
  }
  let recovered;
  let health: Awaited<ReturnType<typeof lineageHealth>> | undefined;
  try {
    recovered = await recoverLineage(root, vaultId, {
      policy: operation === "lineage-reanchor" ? "reanchor" : "refuse",
      reindex: unindexed ? await realpath(vault) : undefined,
      // The postcondition is read under the seal lock, so no concurrent seal lands between
      // the repair and the check that it holds.
      verify: async () => {
        health = await lineageHealth(vaultId, root);
        const left = health.findings.filter(finding => LINEAGE_UNRECORDED.has(finding.kind)).map(finding => finding.kind);
        if (left.length > 0) throw new Error(`Contract lineage postcondition failed: ${left.join(", ")} remains.`);
        const row = (await resolveSealState(vault, root)).row;
        if (row !== "sealed") throw new Error(`Contract lineage postcondition failed: the vault reads as ${row}, not sealed.`);
      },
    });
  } catch (error: unknown) {
    const message = contractErrorMessage(error);
    if (message === null) throw error;
    return { kind: "error", message };
  }
  const verified = health!;
  const receipt: DoctorRepairReceipt = {
    operation, resolvedVault: vault, resolutionSource: source,
    written: {
      paths: [...(unindexed ? ["index.json"] : []), ...(recovered.anchors.length > 0 ? ["lineage/events.jsonl"] : []), ...(recovered.snapshots > 0 ? ["generations/"] : [])],
      summary: { snapshots: recovered.snapshots, anchors: recovered.anchors.length },
    },
    postcondition: { kind: "contract-lineage", events: verified.events, snapshots: verified.snapshots },
  };
  return { kind: "completed", value: { snapshots: recovered.snapshots, anchors: recovered.anchors.map(anchor => ({ eventSeq: anchor.eventSeq, reason: anchor.reason ?? null, digest: anchor.digest })), resolvedVault: vault, resolutionSource: source, receipt } };
}

async function reanchorView(root: string, vaultId: string): Promise<{ readonly tail: { readonly eventSeq: number; readonly digest: string }; readonly events: number; readonly linked: string | null }> {
  const { tail, events } = await lineageTail(root, vaultId);
  const store = await readStore(vaultId, root);
  return { tail, events: events.length, linked: store.state === "ok" ? store.digest : null };
}

/**
 * `lineage-reanchor` is owner-only: a terminal must pass `human` (MCP never does, so it
 * gets LINEAGE_REANCHOR_REQUIRES_TTY). The owner is asked with no lock held; then, under
 * the evolution lock and the seal lock, the lineage is re-read and anchored only when it
 * is still what the owner saw. A tail already at the linked generation writes nothing.
 */
async function reanchorLineage(vault: string, source: WriteTargetSource, human: DoctorHuman | undefined): Promise<DoctorRepairResult> {
  if (human?.interactive !== true) {
    return { kind: "error", message: "LINEAGE_REANCHOR_REQUIRES_TTY: anchoring the contract lineage needs the owner at a terminal; run `oms doctor lineage-reanchor` or `oms setup` in one" };
  }
  const root = storeRoot();
  const state = await resolveSealState(vault, root);
  const vaultId = state.vaultId;
  if (!LINEAGE_RECOVERABLE.has(state.row) || vaultId === null) return repairLineage("lineage-reanchor", vault, source);
  try {
    const before = await reanchorView(root, vaultId);
    if (state.row === "sealed" && before.linked !== null && before.tail.digest === before.linked) {
      return {
        kind: "completed",
        value: { op: "lineage-reanchor", vaultId, anchorEventSeq: before.tail.eventSeq, digest: before.linked, gapFrom: before.tail.digest, reason: "gap-anchor", decision: "approve", anchors: [], resolvedVault: vault, resolutionSource: source },
      };
    }
    const decision = await human.confirm({ op: "lineage-reanchor", gapFrom: before.tail.digest, digest: before.linked });
    if (decision !== "approve") return { kind: "error", message: "EVOLUTION_REANCHOR_DECLINED: the owner did not approve; the lineage was left as it is" };
    return await withEvolutionLock(root, vaultId, async () => {
      const current = await reanchorView(root, vaultId);
      if (current.tail.eventSeq !== before.tail.eventSeq || current.tail.digest !== before.tail.digest || current.linked !== before.linked) {
        return { kind: "error", message: "EVOLUTION_REANCHOR_CHANGED: the lineage or the linked contract changed while you were asked; nothing was written, run the command again" } as const;
      }
      const repaired = await repairLineage("lineage-reanchor", vault, source);
      if (repaired.kind !== "completed") return repaired;
      const anchors = repaired.value["anchors"] as readonly { readonly eventSeq: number; readonly reason: string | null; readonly digest: string }[];
      const after = await reanchorView(root, vaultId);
      if (after.linked === null || after.tail.digest !== after.linked || after.events !== before.events + anchors.length || anchors.length === 0) {
        throw new Error("Contract lineage postcondition failed: the lineage tail is not the linked generation.");
      }
      if ((await readSnapshot(root, vaultId, after.linked as Parameters<typeof readSnapshot>[2])).state !== "ok") {
        throw new Error("Contract lineage postcondition failed: the linked generation has no verified snapshot.");
      }
      const anchor = anchors.at(-1)!;
      await appendEvolutionEvent(root, vaultId, { kind: "lineage.reanchored", at: Date.now(), detail: { via: "doctor", anchors: anchors.length } });
      return {
        kind: "completed",
        value: { ...repaired.value, op: "lineage-reanchor", vaultId, anchorEventSeq: anchor.eventSeq, digest: anchor.digest, gapFrom: before.tail.digest, reason: anchor.reason, decision: "approve" },
      } as const;
    });
  } catch (error: unknown) {
    const message = contractErrorMessage(error);
    if (message === null) throw error;
    return { kind: "error", message };
  }
}

export async function repairDoctor(
  { operation, vault, source, args, resolveAdapter, human }: {
    readonly operation: DoctorRepairOperation;
    readonly vault: string;
    readonly source: WriteTargetSource;
    readonly args: Record<string, unknown> | undefined;
    /**
     * Deferred on purpose. Constructing a semantic adapter opens - and
     * therefore creates - the external engine store, so accepting an
     * already-built adapter would let that mutation happen in the caller's
     * argument list, before this function ever runs admission. Taking a factory
     * keeps admission the first effectful step even though the caller decides
     * WHICH adapter is appropriate.
     */
    readonly resolveAdapter?: () => McpEngineAdapter;
    /** The owner at a terminal; only the CLI passes it, so owner-only ops refuse over MCP. */
    readonly human?: DoctorHuman;
  },
): Promise<DoctorRepairResult> {
  const indexArgs = operation === "repair-index" ? repairIndexArgs(args) : undefined;
  const rejection = await admitWriteTarget({ vault, source });
  if (rejection) return { kind: "rejected", value: { status: "rejected", rejection, resolvedVault: vault, resolutionSource: source } };

  if (operation === "lineage-recover") return repairLineage(operation, vault, source);
  if (operation === "lineage-reanchor") return reanchorLineage(vault, source, human);
  if (isEvolutionOperation(operation)) {
    const evolved = await runEvolutionOp({ operation, vault, root: storeRoot(), args, ...(human === undefined ? {} : { human }) });
    return evolved.kind === "error" ? evolved : { kind: "completed", value: { ...evolved.value, resolvedVault: vault, resolutionSource: source } };
  }

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
    const cachePaths = [engineGraphCachePath(vault), engineNodeCachePath(vault)];
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
  // An embedding sync drains the vector queue the write pipeline fills: queued notes are
  // re-marked first so this sync re-embeds them, and only the ones it did are dequeued.
  const drains = operation === "sync-embeddings" && args?.["embed"] !== false;
  if (drains) prepareDirtyDrain(engineStorePath(vault));
  const semanticResult = await handleSemanticTool(name, args, vault, adapter);
  if (!semanticResult) throw new Error(`Doctor repair "${operation}" was not handled.`);
  if (!semanticResult.ok) return { kind: "error", message: semanticResult.message };
  if (!isRecord(semanticResult.value) || semanticResult.value["available"] !== true) return { kind: "completed", value: semanticResult.value as Record<string, unknown> };
  const drained = drains ? completeDirtyDrain(engineStorePath(vault)) : undefined;
  const summary = drained === undefined
    ? semanticResult.value
    : { ...semanticResult.value, queue: { drained: drained.drained.length, pending: drained.pending.length } };
  const postcondition = await semanticIndexPostcondition(vault);
  if (postcondition.orphanDocumentPaths.length > 0) throw new Error("Semantic index postcondition failed: stored documents include paths outside the live vault.");
  const receipt: DoctorRepairReceipt = {
    operation, resolvedVault: vault, resolutionSource: source,
    written: { paths: [postcondition.databasePath], summary },
    postcondition,
  };
  return { kind: "completed", value: { ...summary, resolvedVault: vault, resolutionSource: source, receipt } };
}
