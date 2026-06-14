/**
 * Per-op request/response mappers for the six non-query MCP ops:
 *   oms_sync_embeddings, oms_semantic_status, oms_semantic_collections,
 *   oms_semantic_contexts, oms_semantic_cleanup, oms_graph_build / oms_graph_status.
 *
 * Each mapper pair:
 *   - requestMapper: mcpInput → EngineXxxArgs (engine-typed seam)
 *   - responseMapper: EngineXxxResult → McpXxxResult (MCP-typed output)
 *
 * Pure transformations only — no I/O, no instantiation.
 * R18: NO import from src/search.
 */

import type { EmbeddingProvider, VectorStore } from "../types.js";
import type {
  McpSemanticEmbeddingSyncOptions,
  McpSemanticEmbeddingSyncResult,
  McpSemanticProviderStatus,
  McpSemanticCollectionResult,
  McpSemanticContextResult,
  McpSemanticCleanupResult,
  McpGraphBuildOptions,
  McpGraphBuildResult,
  McpGraphStatusResult,
  McpStatusOptions,
  EngineSyncArgs,
  EngineSyncResult,
  EngineStatusArgs,
  EngineStatusResult,
  EngineGraphBuildArgs,
  EngineGraphBuildResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// oms_sync_embeddings
// ---------------------------------------------------------------------------

/** Map McpSemanticEmbeddingSyncOptions → EngineSyncArgs. */
export function syncOptionsToEngineArgs(opts: McpSemanticEmbeddingSyncOptions): EngineSyncArgs {
  return {
    paths: [],              // empty = full vault scan; caller populates for incremental
    collection: opts.collection,
    collectionPath: opts.collectionPath,
    pattern: opts.pattern,
    ignore: opts.ignore,
    includeByDefault: opts.includeByDefault,
    updateCommand: opts.updateCommand,
    context: opts.context,
    force: opts.force ?? false,
  };
}

/**
 * Map EngineSyncResult → McpSemanticEmbeddingSyncResult (success path).
 *
 * @param result         - Engine-internal counts from the sync run.
 * @param opts           - Original MCP sync options (carries storage / collection / index).
 * @param statusSnapshot - Provider status captured at sync time, synthesized from
 *                         deps.embed by the facade. Mirrors the mandatory
 *                         `status: Extract<SemanticProviderStatus, { available: true }>`
 *                         field on the real SemanticEmbeddingSyncResult success branch
 *                         (src/search/semantic-sync-types.ts:41).
 */
export function engineSyncResultToMcp(
  result: EngineSyncResult,
  opts: McpSemanticEmbeddingSyncOptions,
  statusSnapshot: McpSemanticProviderStatus & { readonly available: true },
): McpSemanticEmbeddingSyncResult {
  return {
    available: true,
    storage: opts.storage ?? "oms-native-json",
    collection: opts.collection,
    index: opts.index,
    status: statusSnapshot,
    steps: [
      {
        name: "write-index",
        status: 0,
        message: `upserted=${result.upserted} skipped=${result.skipped} errors=${result.errors}`,
        documents: result.upserted,
      },
    ],
  };
}

/** Build an unavailable sync result (error path). */
export function syncResultUnavailable(
  reason: string,
  opts: McpSemanticEmbeddingSyncOptions,
): McpSemanticEmbeddingSyncResult {
  return {
    available: false,
    reason,
    storage: opts.storage ?? "oms-native-json",
    collection: opts.collection,
    index: opts.index,
    steps: [],
  };
}

// ---------------------------------------------------------------------------
// oms_semantic_status
// ---------------------------------------------------------------------------

/** Map McpStatusOptions → EngineStatusArgs. */
export function statusOptionsToEngineArgs(_opts: McpStatusOptions): EngineStatusArgs {
  return { includeModels: true };
}

/**
 * Derive EngineStatusResult from live DispatcherDeps capabilities.
 * Called by the facade after confirming deps are non-null.
 */
export function capsToEngineStatusResult(
  embed: EmbeddingProvider,
  _store: VectorStore,
): EngineStatusResult {
  return {
    storeAvailable: true,
    model: embed.model,
    dimensions: embed.dimensions,
  };
}

/** Map EngineStatusResult → McpSemanticProviderStatus. */
export function engineStatusResultToMcp(result: EngineStatusResult): McpSemanticProviderStatus {
  if (!result.storeAvailable) {
    return { available: false, reason: "VectorStore not available" };
  }
  return {
    available: true,
    storage: "oms-native-json",
    models: { embedding: result.model },
  };
}

/** Build an unavailable status result (error path). */
export function statusResultUnavailable(reason: string): McpSemanticProviderStatus {
  return { available: false, reason };
}

// ---------------------------------------------------------------------------
// oms_semantic_collections
// ---------------------------------------------------------------------------

/**
 * Map EngineStatusResult → McpSemanticCollectionResult.
 *
 * The engine has no collection concept yet; exposes a synthetic "default"
 * collection until the assemble step wires up real collection metadata.
 */
export function engineStatusToCollectionResult(
  result: EngineStatusResult,
): McpSemanticCollectionResult {
  if (!result.storeAvailable) {
    return { available: false, reason: "VectorStore not available", collections: [] };
  }
  return {
    available: true,
    collections: [
      {
        name: "default",
        path: "",
        pattern: "**/*.md",
        ignore: [],
        includeByDefault: true,
        documents: 0,
        activeDocuments: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// oms_semantic_contexts
// ---------------------------------------------------------------------------

/**
 * Map EngineStatusResult → McpSemanticContextResult.
 *
 * Engine has no context store yet; returns empty list as the typed seam.
 */
export function engineStatusToContextResult(
  result: EngineStatusResult,
): McpSemanticContextResult {
  if (!result.storeAvailable) {
    return { available: false, reason: "VectorStore not available", contexts: [] };
  }
  return { available: true, contexts: [] };
}

// ---------------------------------------------------------------------------
// oms_semantic_cleanup
// ---------------------------------------------------------------------------

/** Map EngineSyncResult → McpSemanticCleanupResult. */
export function engineSyncResultToCleanupResult(
  result: EngineSyncResult,
): McpSemanticCleanupResult {
  return {
    available: true,
    storage: "oms-native-json",
    removedDocuments: result.errors,
    remainingDocuments: result.upserted,
    collections: 1,
  };
}

/** Build an unavailable cleanup result (error path). */
export function cleanupResultUnavailable(reason: string): McpSemanticCleanupResult {
  return { available: false, storage: "oms-native-json", reason };
}

// ---------------------------------------------------------------------------
// oms_graph_build
// ---------------------------------------------------------------------------

/** Map McpGraphBuildOptions → EngineGraphBuildArgs. */
export function graphBuildOptionsToEngineArgs(
  opts: McpGraphBuildOptions,
  vaultPath: string,
): EngineGraphBuildArgs {
  return { vaultPath, dryRun: opts.dryRun ?? false };
}

/** Map EngineGraphBuildResult → McpGraphBuildResult. */
export function engineGraphBuildResultToMcp(result: EngineGraphBuildResult): McpGraphBuildResult {
  return {
    available: true,
    notes: result.notes,
    edges: result.edges,
    generatedAt: result.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// oms_graph_status
// ---------------------------------------------------------------------------

/**
 * Map optional EngineGraphBuildResult → McpGraphStatusResult.
 * Pass null when the cache has not been built yet.
 */
export function engineGraphBuildToStatusResult(
  result: EngineGraphBuildResult | null,
): McpGraphStatusResult {
  if (result === null) {
    return { available: false, reason: "Graph cache not built" };
  }
  return {
    available: true,
    notes: result.notes,
    edges: result.edges,
    generatedAt: result.generatedAt,
  };
}
