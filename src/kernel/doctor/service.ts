import { readFile, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { walkMarkdown } from "../engine/embed/sync.js";
import { engineStorePath } from "../engine/paths.js";
import { buildGraphCache, graphCachePath } from "../graph/cache.js";
import { resolveActiveOntology } from "../ontology/active.js";
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
      readonly written: { readonly paths: readonly string[]; readonly summary: { readonly notes: number; readonly edges: number; readonly searchDocuments: number } };
      readonly postcondition: { readonly kind: "graph-cache"; readonly cachePath: string; readonly generatedAt: string; readonly notes: number; readonly edges: number; readonly searchDocuments: number };
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
    const { ontology, source: ontologySource } = await resolveActiveOntology(vault);
    const cache = await buildGraphCache({ vault, ontology, write: true });
    const cachePath = graphCachePath(vault);
    const persistedCache: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
    if (!isRecord(persistedCache) || persistedCache["generatedAt"] !== cache.generatedAt || !Array.isArray(persistedCache["notes"]) || !Array.isArray(persistedCache["edges"]) || !Array.isArray(persistedCache["search"])) {
      throw new Error("Graph cache postcondition failed: persisted cache does not match the completed build.");
    }
    const receipt: DoctorRepairReceipt = {
      operation, resolvedVault: vault, resolutionSource: source,
      written: { paths: [cachePath], summary: { notes: persistedCache["notes"].length, edges: persistedCache["edges"].length, searchDocuments: persistedCache["search"].length } },
      postcondition: { kind: "graph-cache", cachePath, generatedAt: persistedCache["generatedAt"] as string, notes: persistedCache["notes"].length, edges: persistedCache["edges"].length, searchDocuments: persistedCache["search"].length },
    };
    return { kind: "completed", value: { vault, ontologySource, cachePath, generatedAt: cache.generatedAt, notes: cache.notes.length, edges: cache.edges.length, searchDocuments: cache.search.length, sourceOfTruth: cache.sourceOfTruth, resolvedVault: vault, resolutionSource: source, receipt } };
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
