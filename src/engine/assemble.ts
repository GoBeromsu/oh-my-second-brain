/**
 * Assemble — production wiring for the OMS engine.
 *
 * Constructs a ready McpEngineAdapter from a minimal config object, wiring:
 *   - EmbeddingProvider via the STRICT factory (requireRealEmbeddingProvider)
 *     so missing model → loud throw, never silent hash-projection fallback.
 *   - EngineStore via openEngineStore(dbPath, provider.dimensions) — dimensions
 *     come from the provider itself, never hardcoded, so native-dim-in == stored-dim-out.
 *   - DispatcherDeps assembled from store + embed + optional tuning knobs.
 *   - McpEngineAdapter constructed with those deps.
 *
 * All 10 MCP ops are live on the adapter (retrieve_by_axis / retrieve_context
 * are wired to the engine C2 graph + node index as of the task #5 swap).
 *
 * R18: NO runtime import from src/search.
 */

import { requireRealEmbeddingProvider } from "./embed/provider.js";
import { openEngineStore } from "./embed/store.js";
import { syncEngineStore } from "./embed/sync.js";
import { McpEngineAdapter } from "./mcp/facade.js";
import { makeDeferredProvider, makeDeferredStore } from "./embed/deferred.js";
import type { DispatcherDeps } from "./retrieval/dispatcher.js";
import type { EngineStore } from "./embed/store.js";
import type { EmbeddingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

/** Configuration for assembleEngine(). */
export interface AssembleConfig {
  /**
   * Absolute path to the Obsidian vault root.
   * Used as the default dbPath parent and as vault root for syncEngineStore().
   */
  vault: string;

  /**
   * Absolute path to the GGUF model file.
   * When absent AND UPSTAGE_API_KEY is unset, assembleEngine() throws.
   */
  modelPath?: string;

  /**
   * Absolute path to the SQLite engine store database file.
   * Default: <vault>/.oms/engine-store.sqlite
   */
  dbPath?: string;

  /** RRF smoothing constant passed to DispatcherDeps (default 60). */
  rrfK?: number;

  /** Default BFS hop depth for graph sub-queries (default 2). */
  graphDepth?: number;
}

// ---------------------------------------------------------------------------
// Assembled engine handle
// ---------------------------------------------------------------------------

/**
 * The assembled engine: the MCP adapter plus the underlying primitives
 * exposed for testing (smoke tests, task #8 wiring) and for syncVault().
 */
export interface AssembledEngine {
  /** The ready McpEngineAdapter wired to real store + embed. */
  adapter: McpEngineAdapter;
  /** The underlying DispatcherDeps (store + embed + tuning). */
  deps: DispatcherDeps;
  /** Direct reference to the EngineStore (EngineStore ⊃ VectorStore). */
  store: EngineStore;
  /** Direct reference to the EmbeddingProvider. */
  provider: EmbeddingProvider;
  /**
   * Sync the vault (or a sub-path) into the store using the assembled provider.
   * Delegates to syncEngineStore() with the same modelPath / dbPath / vault.
   * Returns sync counters.
   */
  syncVault(opts?: SyncVaultOptions): Promise<SyncVaultResult>;
  /**
   * Release resources: disposes the embedding provider and closes the store.
   * Call this when the engine is no longer needed (e.g. after a sync script).
   */
  dispose(): Promise<void>;
}

/** Options for AssembledEngine.syncVault(). */
export interface SyncVaultOptions {
  /** Vault-relative sub-path to sync (default: entire vault). */
  collectionPath?: string;
  /** When false, stores chunks without embedding (scan-only mode). Default true. */
  embed?: boolean;
}

/** Counters returned by AssembledEngine.syncVault(). */
export interface SyncVaultResult {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Assemble a production-ready McpEngineAdapter from config.
 *
 * Resolution order for the embedding provider (strict — no hash-projection):
 *   1. UPSTAGE_API_KEY env var → Upstage Solar (4096d).
 *   2. config.modelPath → GGUF / node-llama-cpp (768d EmbeddingGemma-300M).
 *   3. Neither → throws (OMS_MODEL_PATH / missing GGUF model mentioned in message).
 *
 * The store is opened with provider.dimensions so the vec0 DDL bakes in the
 * correct dimension count (768 for GGUF, 4096 for Upstage) — native-dim-in == stored-dim-out.
 *
 * @param config - Vault path, optional modelPath, optional dbPath and tuning knobs.
 * @returns An AssembledEngine with adapter, deps, store, provider, syncVault, dispose.
 * @throws {Error} When no real embedding provider is available (strict guard).
 */
export function assembleEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;

  // Strict: throws if no real provider is available (Step 0 guard)
  const provider = requireRealEmbeddingProvider({ modelPath: config.modelPath });

  // Open store with provider.dimensions — never a hardcoded number
  // This is the critical invariant: native-dim-in == stored-dim-out
  const store = openEngineStore(dbPath, provider.dimensions);

  // Build DispatcherDeps per dispatcher.ts:111
  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
    // graphTraverse, hydeGenerator, provenanceMap: not wired here (C2 / M2+)
  };

  // Thread the resolved model path so adapter.syncEmbeddings (MCP sync, no
  // per-call modelPath) reaches the real provider — see McpEngineAdapter ctor.
  const adapter = new McpEngineAdapter(deps, vault, config.modelPath);

  return {
    adapter,
    deps,
    store,
    provider,

    async syncVault(opts: SyncVaultOptions = {}): Promise<SyncVaultResult> {
      // syncEngineStore opens its own provider+store internally, but we already
      // have a live provider. To avoid double-loading the model we call
      // syncEngineStore with modelPath so it can short-circuit via its own lazy
      // load — the GGUF pool deduplicates via loadPromise within the same process.
      const result = await syncEngineStore({
        vault,
        dbPath,
        modelPath: config.modelPath,
        embed: opts.embed,
        collectionPath: opts.collectionPath,
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

// ---------------------------------------------------------------------------
// Graph-only factory (Option-1 swap)
// ---------------------------------------------------------------------------

/**
 * Assemble a GRAPH-ONLY engine: a McpEngineAdapter whose graph ops (build,
 * status, axis-first retrieval) run model-free off the filesystem, with
 * deferred (throw-on-use) embedding provider + store standing in for the
 * semantic layer.
 *
 * Used by the MCP server's Option-1 swap: the engine owns axis-first retrieval
 * immediately (no model required), while semantic retrieval stays on the
 * src/search layer until the engine reaches output parity. Unlike
 * assembleEngine(), this NEVER opens a SQLite store and NEVER loads a model, so
 * it is side-effect-free and safe to call on every server boot (R2 stateless).
 * The deferred primitives are LOUD GUARDS (ADR-007): any accidental semantic
 * call throws rather than fabricating vectors.
 *
 * @param config - Vault path (+ optional rrfK/graphDepth; modelPath/dbPath ignored).
 * @returns An AssembledEngine whose adapter serves graph ops; semantic ops throw.
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

  const adapter = new McpEngineAdapter(deps, vault);

  return {
    adapter,
    deps,
    store,
    provider,

    async syncVault(): Promise<SyncVaultResult> {
      // Graph-only: vault embedding-sync requires a real provider. Report
      // unavailable rather than throwing so callers can degrade gracefully.
      return {
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        available: false,
        reason:
          "graph-only engine: vault sync requires a real embedding provider " +
          "(set OMS_MODEL_PATH or UPSTAGE_API_KEY).",
      };
    },

    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      store.close();
    },
  };
}
