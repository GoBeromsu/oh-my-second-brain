/**
 * Assemble — production wiring for the OMS engine.
 *
 * This module owns the construction of the engine's McpEngineAdapter and its
 * injected backend dependencies.
 *
 * RALPLAN constraints (approved):
 * - No silent fallback for vec/HyDE.
 * - Explicit embedding configuration: OMS_EMBEDDING_PROVIDER + OMS_EMBEDDING_MODEL.
 * - Lex-only semantic queries must remain usable without embedding configuration.
 */

import { requireRealEmbeddingProvider } from "./embed/provider.js";
import { openEngineStore, openEngineStoreCore } from "./embed/store.js";
import { syncEngineStore } from "./embed/sync.js";
import { McpEngineAdapter } from "./mcp/facade.js";
import { makeDeferredProvider, makeDeferredStore } from "./embed/deferred.js";
import type { DispatcherDeps } from "./retrieval/dispatcher.js";
import type { EngineStore } from "./embed/store.js";
import type { EmbeddingProvider } from "./types.js";
import type { Reranker } from "./retrieval/reranker.js";

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

/** Configuration for assembleEngine() / assembleCoreSemanticEngine(). */
export interface AssembleConfig {
  /** Absolute path to the vault root. */
  vault: string;

  /** Optional explicit embedding provider id (OMS_EMBEDDING_PROVIDER). */
  embeddingProvider?: string;

  /** Optional explicit embedding model/id/path (OMS_EMBEDDING_MODEL). */
  embeddingModel?: string;

  /** Absolute path to the SQLite engine store database file. Default: <vault>/.oms/engine-store.sqlite */
  dbPath?: string;

  /** RRF smoothing constant passed to DispatcherDeps (default 60). */
  rrfK?: number;

  /** Default BFS hop depth for graph sub-queries (default 2). */
  graphDepth?: number;

  /**
   * Optional real cross-encoder reranker. Reranking is disabled unless a
   * request explicitly sets `rerank: true`; such a request fails loudly when
   * this is absent.
   */
  reranker?: Reranker;
}

// ---------------------------------------------------------------------------
// Assembled engine handle
// ---------------------------------------------------------------------------

export interface AssembledEngine {
  adapter: McpEngineAdapter;
  deps: DispatcherDeps;
  store: EngineStore;
  provider: EmbeddingProvider;
  syncVault(opts?: SyncVaultOptions): Promise<SyncVaultResult>;
  dispose(): Promise<void>;
}

export interface SyncVaultOptions {
  collectionPath?: string;
  /** Default true. */
  embed?: boolean;
  /** When true, allows destructive vector rebuild on mismatch. Default false. */
  force?: boolean;
}

export interface SyncVaultResult {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/**
 * Assemble a semantic-capable engine with a REAL embedding provider.
 *
 * This is the production semantic engine. It requires explicit embedding
 * configuration and never fabricates vectors.
 */
export function assembleEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;

  const provider = requireRealEmbeddingProvider({
    provider: config.embeddingProvider,
    model: config.embeddingModel,
  });

  const store = openEngineStore(dbPath, provider.dimensions);

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
  }, config.reranker);

  return {
    adapter,
    deps,
    store,
    provider,

    async syncVault(opts: SyncVaultOptions = {}): Promise<SyncVaultResult> {
      const result = await syncEngineStore({
        vault,
        dbPath,
        collectionPath: opts.collectionPath,
        embed: opts.embed,
        force: opts.force,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
      });
      return {
        scanned: result.scanned,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        available: result.available,
        reason: result.reason,
      };
    },

    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      store.close();
    },
  };
}

/**
 * Assemble a CORE-ONLY semantic engine.
 *
 * This engine opens the sqlite store in core-only mode and wires a deferred
 * embedder. It enables lex-only semantic operations without embedding config.
 * vec/HyDE operations will fail (embed() throws; vecAvailable is false).
 */
export function assembleCoreSemanticEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;

  const provider = makeDeferredProvider();
  const store = openEngineStoreCore(dbPath);

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
  }, config.reranker);

  return {
    adapter,
    deps,
    store,
    provider,

    async syncVault(opts: SyncVaultOptions = {}): Promise<SyncVaultResult> {
      const result = await syncEngineStore({
        vault,
        dbPath,
        collectionPath: opts.collectionPath,
        embed: opts.embed,
        force: opts.force,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
      });
      return {
        scanned: result.scanned,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        available: result.available,
        reason: result.reason,
      };
    },

    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      store.close();
    },
  };
}

/**
 * Assemble a GRAPH-ONLY engine: graph ops run model-free; semantic store/embed
 * are throw-on-use guards.
 */
export function assembleGraphOnlyEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const provider = makeDeferredProvider();
  const store = makeDeferredStore();

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, undefined, config.reranker);

  return {
    adapter,
    deps,
    store,
    provider,

    async syncVault(): Promise<SyncVaultResult> {
      return {
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        available: false,
        reason:
          "graph-only engine: embedding sync requires an explicit embedding provider/model.",
      };
    },

    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      store.close();
    },
  };
}
