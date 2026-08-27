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
import {
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  resolveEmbeddingModel,
} from "./embed/model.js";
import type { EmbeddingModelDescriptor } from "./embed/model.js";
import {
  openEngineStore,
  openEngineStoreCore,
  openInMemoryEngineStoreCore,
  openEngineStoreCoreReadOnly,
  openEngineStoreReadOnly,
} from "./embed/store.js";
import { makeEmbeddingIdentity } from "./embed/identity.js";
import { syncEngineStore } from "./embed/sync.js";
import { McpEngineAdapter } from "./mcp/facade.js";
import { makeDeferredProvider, makeDeferredStore } from "./embed/deferred.js";
import type { DispatcherDeps, DispatcherPolicy } from "./retrieval/dispatcher.js";
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

  /**
   * Optional canonical descriptor supplied by setup. When omitted, assembly
   * discovers the setup-written installed default. `null` explicitly waives
   * default discovery.
   */
  embeddingDescriptor?: EmbeddingModelDescriptor | null;

  /** Test/setup override for the user-level model cache root. */
  embeddingCacheDir?: string;

  /** Explicit descriptor-shape overrides for callers without a descriptor. */
  embeddingDimensions?: number;
  embeddingContext?: number;
  embeddingContextLength?: number;
  embeddingContextTokens?: number;
  embeddingMrlDim?: number;
  embeddingNormalization?: string;
  embeddingPrefixScheme?: string;

  /** Absolute path to the SQLite engine store database file. Default: <vault>/.oms/engine-store.sqlite */
  dbPath?: string;

  /** RRF smoothing constant passed to DispatcherDeps (default 60). */
  rrfK?: number;

  /** Explicit retrieval policy used by the production dispatcher. */
  policy?: DispatcherPolicy;

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
  /** Whether lex-only queries refresh this engine's selected lexical store. */
  implicitLexicalSync: boolean;
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
  /** True when this sync replaced the active on-disk generation. */
  generationSwapped?: boolean;
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

interface ResolvedEmbeddingConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly descriptor?: EmbeddingModelDescriptor;
  readonly dimensions?: number;
  readonly context?: number;
  readonly contextLength?: number;
  readonly contextTokens?: number;
  readonly mrlDim?: number;
  readonly normalization?: string;
  readonly prefixScheme?: string;
}

function embeddingIdentitiesMatch(
  stored: ReturnType<typeof makeEmbeddingIdentity>,
  configured: ReturnType<typeof makeEmbeddingIdentity>,
): boolean {
  return stored.provider === configured.provider &&
    stored.model === configured.model &&
    stored.dimensions === configured.dimensions &&
    stored.contextLength === configured.contextLength &&
    stored.mrlDim === configured.mrlDim &&
    stored.normalization === configured.normalization &&
    stored.prefixScheme === configured.prefixScheme &&
    stored.fingerprint === configured.fingerprint;
}

function validateEmbeddingDescriptor(
  descriptor: EmbeddingModelDescriptor,
  overrides: Pick<
    AssembleConfig,
    | "embeddingDimensions"
    | "embeddingContext"
    | "embeddingContextLength"
    | "embeddingContextTokens"
    | "embeddingMrlDim"
    | "embeddingNormalization"
    | "embeddingPrefixScheme"
  > = {},
): void {
  const dimensions = overrides.embeddingDimensions ?? descriptor.dimensions;
  const context =
    overrides.embeddingContext ??
    overrides.embeddingContextLength ??
    overrides.embeddingContextTokens ??
    descriptor.context ??
    descriptor.contextLength ??
    descriptor.contextTokens;
  const mrlDim = overrides.embeddingMrlDim ?? descriptor.mrlDim;
  const normalization = overrides.embeddingNormalization ?? descriptor.normalization;
  const prefixScheme = overrides.embeddingPrefixScheme ?? descriptor.prefixScheme;
  if (
    dimensions === undefined ||
    context === undefined ||
    mrlDim === undefined ||
    !normalization?.trim() ||
    !prefixScheme?.trim()
  ) {
    throw new Error(
      "Embedding descriptor is incomplete. dimensions/context/mrlDim/normalization/prefixScheme are required.",
    );
  }
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("Embedding descriptor dimensions must be a positive integer.");
  }
  if (!Number.isInteger(context) || context <= 0) {
    throw new Error("Embedding descriptor context must be a positive integer.");
  }
  if (!Number.isInteger(mrlDim) || mrlDim < 0) {
    throw new Error("Embedding descriptor mrlDim must be a non-negative integer.");
  }
}

function resolvedEmbeddingConfig(config: AssembleConfig): ResolvedEmbeddingConfig {
  const hasExplicitConfig =
    config.embeddingProvider !== undefined || config.embeddingModel !== undefined;
  const resolution = resolveEmbeddingModel({
    env: hasExplicitConfig
      ? {
        [EMBEDDING_PROVIDER_ENV]: config.embeddingProvider,
        [EMBEDDING_MODEL_ENV]: config.embeddingModel,
      }
      : process.env,
    ...(config.embeddingDescriptor !== undefined
      ? { installedDefault: config.embeddingDescriptor }
      : {}),
    ...(config.embeddingCacheDir !== undefined ? { cacheDir: config.embeddingCacheDir } : {}),
  });
  if (!resolution.available) return {};
  const descriptor = config.embeddingDescriptor === null
    ? undefined
    : config.embeddingDescriptor ?? resolution.descriptor;
  if (descriptor !== undefined) {
    if (hasExplicitConfig) {
      const descriptorModel = descriptor.path || descriptor.modelPath || descriptor.model;
      const resolvedModel = resolution.modelPath ?? resolution.model;
      if (
        descriptor.provider.trim() !== resolution.provider?.trim() ||
        (descriptorModel.trim() !== resolvedModel?.trim() && descriptor.model.trim() !== resolvedModel?.trim())
      ) {
        throw new Error("Embedding descriptor does not match the configured provider/model.");
      }
    }
    validateEmbeddingDescriptor(descriptor, config);
  }
  return {
    provider: resolution.provider,
    model: resolution.modelPath ?? resolution.model,
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...((config.embeddingDimensions ?? descriptor?.dimensions) !== undefined
      ? { dimensions: config.embeddingDimensions ?? descriptor?.dimensions }
      : {}),
    ...((config.embeddingContext ?? descriptor?.context) !== undefined
      ? { context: config.embeddingContext ?? descriptor?.context }
      : {}),
    ...((config.embeddingContextLength ?? descriptor?.contextLength) !== undefined
      ? { contextLength: config.embeddingContextLength ?? descriptor?.contextLength }
      : {}),
    ...((config.embeddingContextTokens ?? descriptor?.contextTokens) !== undefined
      ? { contextTokens: config.embeddingContextTokens ?? descriptor?.contextTokens }
      : {}),
    ...((config.embeddingMrlDim ?? descriptor?.mrlDim) !== undefined
      ? { mrlDim: config.embeddingMrlDim ?? descriptor?.mrlDim }
      : {}),
    ...((config.embeddingNormalization ?? descriptor?.normalization) !== undefined
      ? { normalization: config.embeddingNormalization ?? descriptor?.normalization }
      : {}),
    ...((config.embeddingPrefixScheme ?? descriptor?.prefixScheme) !== undefined
      ? { prefixScheme: config.embeddingPrefixScheme ?? descriptor?.prefixScheme }
      : {}),
  };
}

/**
 * Assemble a semantic-capable engine with a REAL embedding provider.
 *
 * This is the production semantic engine. It requires explicit embedding
 * configuration and never fabricates vectors.
 */
export function assembleEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;
  const embedding = resolvedEmbeddingConfig(config);

  const provider = requireRealEmbeddingProvider({
    provider: embedding.provider,
    model: embedding.model,
    dimensions: embedding.dimensions,
    context: embedding.context,
    contextLength: embedding.contextLength,
    contextTokens: embedding.contextTokens,
    mrlDim: embedding.mrlDim,
    normalization: embedding.normalization,
    prefixScheme: embedding.prefixScheme,
  });

  let activeStore = openEngineStore(dbPath, provider.dimensions);

  const deps: DispatcherDeps = {
    store: activeStore,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDescriptor: embedding.descriptor,
    embeddingDimensions: embedding.dimensions,
    embeddingContext: embedding.context,
    embeddingContextLength: embedding.contextLength,
    embeddingContextTokens: embedding.contextTokens,
    embeddingMrlDim: embedding.mrlDim,
    embeddingNormalization: embedding.normalization,
    embeddingPrefixScheme: embedding.prefixScheme,
    dbPath,
    onStoreRebind: (store) => {
      activeStore = store;
    },
  }, config.reranker, true);

  const assembled: AssembledEngine = {
    adapter,
    deps,
    get store(): EngineStore {
      return activeStore;
    },
    provider,
    implicitLexicalSync: true,

    async syncVault(opts: SyncVaultOptions = {}): Promise<SyncVaultResult> {
      let swapHandleClosed = false;
      const result = await syncEngineStore({
        vault,
        dbPath,
        collectionPath: opts.collectionPath,
        embed: opts.embed,
        force: opts.force,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        embeddingDescriptor: embedding.descriptor,
        embeddingDimensions: embedding.dimensions,
        embeddingContext: embedding.context,
        embeddingContextLength: embedding.contextLength,
        embeddingContextTokens: embedding.contextTokens,
        embeddingMrlDim: embedding.mrlDim,
        embeddingNormalization: embedding.normalization,
        embeddingPrefixScheme: embedding.prefixScheme,
        onGenerationSwapPrepare: () => {
          // Close the long-lived assembly handle before the active
          // generation's WAL/SHM sidecars are removed.
          swapHandleClosed = true;
          activeStore.close();
        },
        onGenerationSwapComplete: () => {
          if (!swapHandleClosed) return;
          activeStore = openEngineStore(dbPath, provider.dimensions);
          deps.store = activeStore;
          swapHandleClosed = false;
        },
      });
      return {
        scanned: result.scanned,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        available: result.available,
        reason: result.reason,
        generationSwapped: result.generationSwapped,
      };
    },

    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      activeStore.close();
    },
  };
  return assembled;
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
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
  }, config.reranker, true);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: true,

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
 * Assemble a core-only semantic engine whose lexical index is process-local.
 * Lex-only queries populate this store on demand without touching the vault.
 */
export function assembleEphemeralCoreSemanticEngine(config: AssembleConfig): AssembledEngine {
  const vault = config.vault;
  const provider = makeDeferredProvider();
  const store = openInMemoryEngineStoreCore();
  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
  }, config.reranker, true, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: true,
    async syncVault(opts: SyncVaultOptions = {}): Promise<SyncVaultResult> {
      const result = await syncEngineStore({
        vault,
        collectionPath: opts.collectionPath,
        embed: false,
        force: opts.force,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        store,
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
 * Assemble an existing CORE-ONLY semantic engine without creating a store.
 * Returns null when the semantic index is absent or cannot be read safely.
 */
export function assembleCoreSemanticEngineReadOnly(config: AssembleConfig): AssembledEngine | null {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;
  const provider = makeDeferredProvider();
  const store = openEngineStoreCoreReadOnly(dbPath);
  if (store === null) {
    void provider.dispose().catch(() => undefined);
    return null;
  }

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
  }, config.reranker, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: false,
    async syncVault(): Promise<SyncVaultResult> {
      throw new Error("AssembledEngine: syncVault is unavailable because the store is open read-only.");
    },
    async dispose(): Promise<void> {
      await provider.dispose().catch(() => undefined);
      store.close();
    },
  };
}

/**
 * Assemble an existing vector-capable semantic engine without creating a store.
 * Returns null when the semantic index is absent or cannot be read safely.
 */
export function assembleEngineReadOnly(config: AssembleConfig): AssembledEngine | null {
  const vault = config.vault;
  const dbPath = config.dbPath ?? `${vault}/.oms/engine-store.sqlite`;
  const embedding = resolvedEmbeddingConfig(config);
  // The readonly store opener does not use dimensions. Open it before loading
  // the configured provider so an absent index is always an unavailable result.
  const store = openEngineStoreReadOnly(dbPath, 0);
  if (store === null) return null;

  let configuredIdentity;
  try {
    configuredIdentity = makeEmbeddingIdentity({
      provider: embedding.provider ?? "",
      model: embedding.model ?? "",
      dimensions: embedding.dimensions ?? 0,
      contextLength: embedding.contextLength ?? embedding.contextTokens ?? embedding.context ?? 0,
      mrlDim: embedding.mrlDim ?? -1,
      normalization: embedding.normalization ?? "",
      prefixScheme: embedding.prefixScheme ?? "",
    });
    const storedIdentity = store.readEmbeddingIdentity();
    if (storedIdentity !== null && !embeddingIdentitiesMatch(storedIdentity, configuredIdentity)) {
      throw new Error(
        `Embedding identity mismatch for read-only store: stored ${storedIdentity.provider}/${storedIdentity.model} does not match configured ${configuredIdentity.provider}/${configuredIdentity.model}.`,
      );
    }
  } catch (error) {
    store.close();
    throw error;
  }

  let provider: EmbeddingProvider;
  try {
    provider = requireRealEmbeddingProvider({
      provider: embedding.provider,
      model: embedding.model,
      dimensions: embedding.dimensions,
      context: embedding.context,
      contextLength: embedding.contextLength,
      contextTokens: embedding.contextTokens,
      mrlDim: embedding.mrlDim,
      normalization: embedding.normalization,
      prefixScheme: embedding.prefixScheme,
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingDescriptor: embedding.descriptor,
    embeddingDimensions: embedding.dimensions,
    embeddingContext: embedding.context,
    embeddingContextLength: embedding.contextLength,
    embeddingContextTokens: embedding.contextTokens,
    embeddingMrlDim: embedding.mrlDim,
    embeddingNormalization: embedding.normalization,
    embeddingPrefixScheme: embedding.prefixScheme,
    dbPath,
  }, config.reranker, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: false,
    async syncVault(): Promise<SyncVaultResult> {
      throw new Error("AssembledEngine: syncVault is unavailable because the store is open read-only.");
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
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, undefined, config.reranker, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: false,

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
