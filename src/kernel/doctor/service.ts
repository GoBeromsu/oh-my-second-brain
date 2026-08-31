import { stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { walkMarkdown } from "../engine/embed/sync.js";
import { handleSemanticTool } from "../semantic/semantic-retrieve.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";

export type DoctorRepairOperation = "build-graph" | "semantic-cleanup" | "sync-embeddings";

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
    };

export type DoctorRepairResult =
  | { readonly kind: "rejected"; readonly value: { readonly status: "rejected"; readonly rejection: unknown; readonly resolvedVault: string; readonly resolutionSource: WriteTargetSource } }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "completed"; readonly value: Record<string, unknown> };

async function semanticIndexPostcondition(vault: string): Promise<SemanticIndexPostcondition> {
  const databasePath = path.join(vault, ".oms", "engine-store.sqlite");
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
  const rejection = await admitWriteTarget({ vault, source });
  if (rejection) return { kind: "rejected", value: { status: "rejected", rejection, resolvedVault: vault, resolutionSource: source } };

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
