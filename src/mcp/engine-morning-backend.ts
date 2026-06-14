/**
 * Engine-backed MorningSemanticBackend — adapts the native McpEngineAdapter to
 * the five semantic leaf operations the morning retrieval flow expects.
 *
 * Injected by the MCP server's oms_retrieve_context handler so the context op's
 * semantic leg runs on the EmbeddingGemma engine while its graph leg stays on
 * the src/graph warm cache. Every adapter op already wraps its body in
 * try/catch, so a model-less host degrades to "unavailable" (graph-only
 * context) rather than throwing — no separate guard needed here.
 *
 * The Mcp* contract types are structurally identical to their src/search
 * counterparts (the R18 mirror in engine/mcp/types.ts). These mappers only
 * bridge the small shape differences: McpSemanticDocumentResult's flat
 * {available, reason?} vs the discriminated SemanticDocumentResult, and the
 * status sub-fields (collections / qmdCompatibility) the engine does not emit.
 *
 * R18: this file lives in src/mcp (NOT src/engine), so importing the engine
 * facade here is allowed — the engine layer never imports back.
 */

import type { McpEngineAdapter } from "../engine/mcp/facade.js";
import type {
  McpSemanticQueryOptions,
  McpSemanticQueryResult,
  McpSemanticProviderStatus,
  McpSemanticDocumentResult,
  McpSemanticEmbeddingSyncResult,
} from "../engine/mcp/types.js";
import type { MorningRetrieveOptions, MorningSemanticBackend } from "../retrieve/morning.js";
import type {
  SemanticDocumentResult,
  SemanticEmbeddingSyncResult,
  SemanticGetOptions,
  SemanticMultiGetOptions,
  SemanticProviderStatus,
  SemanticQueryOptions,
  SemanticQueryResult,
  SemanticStatusOptions,
} from "../search/semantic.js";

// ---------------------------------------------------------------------------
// Result mappers: Mcp* (engine) → src/search contract
// ---------------------------------------------------------------------------

function toProviderStatus(status: McpSemanticProviderStatus): SemanticProviderStatus {
  if (!status.available) return { available: false, reason: status.reason };
  return {
    available: true,
    storage: status.storage,
    models: status.models,
    index: status.index,
  };
}

function toQueryResult(result: McpSemanticQueryResult): SemanticQueryResult {
  if (result.available) return { available: true, hits: result.hits };
  return { available: false, reason: result.reason, hits: result.hits };
}

function toDocumentResult(result: McpSemanticDocumentResult): SemanticDocumentResult {
  if (result.available) return { available: true, documents: result.documents };
  return { available: false, reason: result.reason ?? "unavailable", documents: result.documents };
}

function toSyncResult(result: McpSemanticEmbeddingSyncResult): SemanticEmbeddingSyncResult {
  if (result.available) {
    return {
      available: true,
      storage: result.storage,
      collection: result.collection,
      index: result.index,
      // Engine sync always carries an available:true snapshot; rebuild it in the
      // discriminated shape so no cast is needed.
      status: {
        available: true,
        storage: result.status.storage,
        models: result.status.models,
        index: result.status.index,
      },
      steps: result.steps,
    };
  }
  return {
    available: false,
    reason: result.reason,
    storage: result.storage,
    collection: result.collection,
    index: result.index,
    steps: result.steps,
  };
}

// ---------------------------------------------------------------------------
// Option mapper: src/search query options → Mcp query options
// ---------------------------------------------------------------------------

function toMcpQueryOptions(opts: SemanticQueryOptions): McpSemanticQueryOptions {
  return {
    query: opts.query,
    collection: opts.collection,
    limit: opts.limit,
    mode: opts.mode,
    intent: opts.intent,
    searches: opts.searches,
    lex: opts.lex,
    vec: opts.vec,
    hyde: opts.hyde,
    minScore: opts.minScore,
    all: opts.all,
    format: opts.format,
    full: opts.full,
    lineNumbers: opts.lineNumbers,
    fullPath: opts.fullPath,
    vault: opts.vault,
    index: opts.index,
    storage: opts.storage,
    modelPath: opts.modelPath,
    chunkStrategy: opts.chunkStrategy,
    candidateLimit: opts.candidateLimit,
    noRerank: opts.noRerank,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a MorningSemanticBackend that routes the five semantic leaf operations
 * through the native engine adapter.
 *
 * @param adapter - The engine adapter (real model when assembleEngine
 *                  succeeded; the graph-only adapter as a model-less fallback —
 *                  its query/status degrade to unavailable while file-based
 *                  getDocument/multiGet keep working).
 * @param vault   - Absolute vault root, used as the default when a leaf op omits
 *                  its own vault (the adapter is vault-scoped).
 */
export function makeEngineMorningBackend(adapter: McpEngineAdapter, vault: string): MorningSemanticBackend {
  return {
    async sync(opts: MorningRetrieveOptions): Promise<SemanticEmbeddingSyncResult | undefined> {
      // Same R2 gate as src/search: never auto-sync unless the caller explicitly
      // asked (embeddingSyncBeforeSearch). Engine sync is incremental (SHA-256
      // diff), so even a forced re-sync skips unchanged chunks.
      if (opts.semantic?.syncBeforeSearch !== true) return undefined;
      const raw = await adapter.syncEmbeddings({
        vault: opts.vault ?? vault,
        collection: opts.semantic.collection,
        index: opts.semantic.index,
        storage: opts.semantic.syncStorage ?? opts.semantic.storage,
        modelPath: opts.semantic.syncModelPath ?? opts.semantic.modelPath,
        embed: opts.semantic.syncEmbed,
        force: opts.semantic.syncForce,
        chunkStrategy: opts.semantic.chunkStrategy,
        maxDocsPerBatch: opts.semantic.syncMaxDocsPerBatch,
        maxBatchMb: opts.semantic.syncMaxBatchMb,
      });
      return toSyncResult(raw);
    },

    status(opts: SemanticStatusOptions): Promise<SemanticProviderStatus> {
      // semanticStatus is synchronous on the adapter; lift it into the async
      // backend contract.
      return Promise.resolve(toProviderStatus(adapter.semanticStatus(opts)));
    },

    async query(opts: SemanticQueryOptions): Promise<SemanticQueryResult> {
      return toQueryResult(await adapter.semanticQuery(toMcpQueryOptions(opts)));
    },

    async getDocument(opts: SemanticGetOptions): Promise<SemanticDocumentResult> {
      return toDocumentResult(
        await adapter.getDocument({
          target: opts.target,
          vault: opts.vault ?? vault,
          fromLine: opts.fromLine,
          lineCount: opts.lineCount,
          lineNumbers: opts.lineNumbers,
          fullPath: opts.fullPath,
          collection: opts.collection,
        }),
      );
    },

    async multiGet(opts: SemanticMultiGetOptions): Promise<SemanticDocumentResult> {
      return toDocumentResult(
        await adapter.multiGetDocuments({
          targets: [...opts.targets],
          vault: opts.vault ?? vault,
          lineLimit: opts.lineLimit,
          maxBytes: opts.maxBytes,
          lineNumbers: opts.lineNumbers,
          fullPath: opts.fullPath,
          collection: opts.collection,
        }),
      );
    },
  };
}
