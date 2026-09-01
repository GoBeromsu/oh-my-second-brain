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

import path from "node:path";
import { requireRealEmbeddingProvider } from "./embed/provider.js";
import {
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  parseEmbeddingModelDescriptor,
  readInstalledModelsReceiptSync,
  resolveEmbeddingModel,
} from "./embed/model.js";
import type { EmbeddingModelDescriptor, InstalledModelsReceipt } from "./embed/model.js";
import {
  capabilityGuidance,
  MODEL_CAPABILITY_ENV_PAIRS,
  readModelsConfigSync,
  resolveModelCapability,
} from "./embed/config.js";
import type {
  ModelCapability,
  ModelsConfigV1,
  PortableModelSelection,
} from "./embed/config.js";
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
import type { McpSemanticModelCapabilityStatus } from "./mcp/types.js";
import { makeDeferredProvider, makeDeferredStore } from "./embed/deferred.js";
import { engineStorePath } from "./paths.js";
import type { DispatcherDeps, DispatcherPolicy } from "./retrieval/dispatcher.js";
import type { EngineStore } from "./embed/store.js";
import type { EmbeddingProvider } from "./types.js";
import {
  createLazyOwnedReranker,
  createLlamaReranker,
} from "./retrieval/reranker.js";
import type { DisposableReranker, Reranker } from "./retrieval/reranker.js";
import { createLlamaHydeGenerator } from "./retrieval/generator.js";
import type { HydeGenerator, QueryExpander } from "./retrieval/dispatcher.js";

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

  /** Explicit immutable embedding revision for scalar test/benchmark seams. */
  embeddingRevision?: string;
  /** Explicit immutable embedding checksum for scalar test/benchmark seams. */
  embeddingSha256?: string;

  /** Test/setup override for the user-level model cache root. */
  embeddingCacheDir?: string;

  /** Explicit descriptor-shape overrides for callers without a descriptor. */
  embeddingDimensions?: number;
  embeddingContext?: number;
  embeddingMrlDim?: number;
  embeddingNormalization?: string;
  embeddingPrefixScheme?: string;

  /** Deterministic model-resolution seams. */
  modelsConfig?: ModelsConfigV1 | null;
  installedModelsReceipt?: InstalledModelsReceipt;
  modelRequests?: Readonly<Partial<Record<ModelCapability, PortableModelSelection>>>;
  modelEnv?: Readonly<Record<string, string | undefined>>;

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

  /** Test seam for an assembly-owned reranker; mutually exclusive with reranker. */
  rerankerFactory?: () => Reranker | Promise<Reranker>;

  /**
   * Optional caller-owned HyDE generator. When absent, assembly owns a lazy one
   * that resolves the generate capability on first use; an explicit `hyde` request
   * fails loudly when no generation model is configured.
   */
  hydeGenerator?: HydeGenerator;
  /** Optional caller-owned explicit query expander. */
  queryExpander?: QueryExpander;
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
  /**
   * Explicit vault-relative Markdown files to sync instead of walking the whole
   * collection. This is the assembly-level counterpart of `SyncOptions.files`.
   *
   * The kernel already supported this selection, but the public engine handle did
   * not expose or forward it. A caller asking to refresh 60 changed notes therefore
   * started embedding all 21,045 notes in the vault — exactly what happened during
   * the first real-vault throughput benchmark.
   */
  files?: readonly string[];
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
  /** Portable, persisted model identifier. */
  readonly model?: string;
  /** Absolute artifact path passed to the runtime provider. */
  readonly runtimeModelPath?: string;
  readonly revision?: string;
  readonly sha256?: string;
  readonly descriptor?: EmbeddingModelDescriptor;
  readonly dimensions?: number;
  readonly context?: number;
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
    stored.revision === configured.revision &&
    stored.sha256 === configured.sha256 &&
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
    | "embeddingMrlDim"
    | "embeddingNormalization"
    | "embeddingPrefixScheme"
  > = {},
): void {
  const dimensions = overrides.embeddingDimensions ?? descriptor.dimensions;
  const context = overrides.embeddingContext ?? descriptor.context;
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

function assertDescriptorMatchesConfig(
  descriptor: EmbeddingModelDescriptor,
  config: AssembleConfig,
): void {
  const conflicts: Array<[string, string | number | undefined, string | number]> = [
    ["provider", config.embeddingProvider, descriptor.provider],
    ["model", config.embeddingModel, descriptor.model],
    ["revision", config.embeddingRevision, descriptor.revision],
    ["sha256", config.embeddingSha256, descriptor.sha256],
    ["dimensions", config.embeddingDimensions, descriptor.dimensions],
    ["context", config.embeddingContext, descriptor.context],
    ["mrlDim", config.embeddingMrlDim, descriptor.mrlDim],
    ["normalization", config.embeddingNormalization, descriptor.normalization],
    ["prefixScheme", config.embeddingPrefixScheme, descriptor.prefixScheme],
  ];
  for (const [field, supplied, expected] of conflicts) {
    if (supplied !== undefined && supplied !== expected) {
      throw new Error(`Embedding descriptor does not match the configured ${field}.`);
    }
  }
}

function resolvedEmbeddingConfig(config: AssembleConfig): ResolvedEmbeddingConfig {
  if (config.embeddingDescriptor !== null && config.embeddingDescriptor !== undefined) {
    const descriptor = parseEmbeddingModelDescriptor(config.embeddingDescriptor, { requirePath: true });
    if (descriptor.path === undefined || !path.isAbsolute(descriptor.path)) {
      throw new Error("Embedding descriptor path must be absolute.");
    }
    validateEmbeddingDescriptor(descriptor, config);
    assertDescriptorMatchesConfig(descriptor, config);
    return {
      provider: descriptor.provider, model: descriptor.model,
      runtimeModelPath: descriptor.path, revision: descriptor.revision,
      sha256: descriptor.sha256, descriptor, dimensions: descriptor.dimensions,
      context: descriptor.context, mrlDim: descriptor.mrlDim,
      normalization: descriptor.normalization, prefixScheme: descriptor.prefixScheme,
    };
  }
  const env = {
    ...(config.modelEnv ?? process.env),
    ...(config.embeddingProvider === undefined ? {} : { [EMBEDDING_PROVIDER_ENV]: config.embeddingProvider }),
    ...(config.embeddingModel === undefined ? {} : { [EMBEDDING_MODEL_ENV]: config.embeddingModel }),
  };
  const resolution = resolveEmbeddingModel({
    env,
    request: config.modelRequests?.embed,
    vaultConfig: config.modelsConfig ?? readModelsConfigSync(config.vault),
    installedReceipt: config.installedModelsReceipt ??
      readInstalledModelsReceiptSync({ cacheDir: config.embeddingCacheDir }),
    ...(config.embeddingCacheDir !== undefined ? { cacheDir: config.embeddingCacheDir } : {}),
  });
  if (!resolution.available) return {};
  const descriptor = resolution.descriptor;
  if (descriptor === undefined || descriptor.path === undefined || !path.isAbsolute(descriptor.path)) {
    throw new Error("Resolved embedding model is missing an absolute verified artifact path.");
  }
  validateEmbeddingDescriptor(descriptor, config);
  assertDescriptorMatchesConfig(descriptor, config);
  return {
    provider: descriptor.provider, model: descriptor.model, runtimeModelPath: descriptor.path,
    revision: descriptor.revision, sha256: descriptor.sha256, descriptor,
    dimensions: descriptor.dimensions, context: descriptor.context, mrlDim: descriptor.mrlDim,
    normalization: descriptor.normalization, prefixScheme: descriptor.prefixScheme,
  };
}

function ownedReranker(config: AssembleConfig): DisposableReranker | undefined {
  if (config.reranker !== undefined && config.rerankerFactory !== undefined) {
    throw new Error("Specify either reranker or rerankerFactory, not both.");
  }
  if (config.reranker !== undefined) return undefined;
  return createLazyOwnedReranker(() => {
    if (config.rerankerFactory !== undefined) return config.rerankerFactory();
    const receipt = config.installedModelsReceipt ??
      readInstalledModelsReceiptSync({ cacheDir: config.embeddingCacheDir });
    const resolution = resolveModelCapability({
      capability: "rerank",
      request: config.modelRequests?.rerank,
      env: config.modelEnv ?? process.env,
      vaultConfig: config.modelsConfig ?? readModelsConfigSync(config.vault),
      installedArtifacts: receipt.artifacts,
      setupDefaults: receipt.defaults,
    });
    if (!resolution.available || resolution.artifact === undefined) {
      // The resolver always attaches guidance to an unavailable result, so the
      // fallback covers only the internally inconsistent case of an available
      // resolution with no artifact. It uses the shared guidance rather than a
      // hand-written copy, which named the env pair and a bare `oms setup` while
      // omitting `.oms/models.json` and the descriptor flag that actually installs
      // a reranker.
      throw new Error(resolution.guidance ?? capabilityGuidance("rerank"));
    }
    return createLlamaReranker({ modelPath: resolution.artifact.path });
  });
}

/** One assembly-owned model serving HyDE and explicit expansion. */
interface OwnedGenerator {
  readonly generate: HydeGenerator;
  readonly expand: QueryExpander;
  readonly dispose: () => Promise<void>;
}

/**
 * Own a lazy HyDE generator resolved from the generate capability.
 *
 * Resolution happens on the first generation, not at assembly, for the same reason
 * the reranker does: a vault with no generation model must still assemble and serve
 * lexical and vector retrieval. Only an explicit `hyde` request pays the cost, and
 * only it sees the failure.
 *
 * Concurrent first requests share one construction promise so the 1.7B model is not
 * loaded twice.
 */
function createOwnedGenerator(config: AssembleConfig): OwnedGenerator | undefined {
  if (config.hydeGenerator !== undefined && config.queryExpander !== undefined) return undefined;

  let inner: OwnedGenerator | null = null;
  let loading: Promise<OwnedGenerator> | null = null;
  let disposed = false;

  const ensure = async (): Promise<OwnedGenerator> => {
    if (inner !== null) return inner;
    loading ??= (async () => {
      const receipt = config.installedModelsReceipt ??
        readInstalledModelsReceiptSync({ cacheDir: config.embeddingCacheDir });
      const resolution = resolveModelCapability({
        capability: "generate",
        request: config.modelRequests?.generate,
        env: config.modelEnv ?? process.env,
        vaultConfig: config.modelsConfig ?? readModelsConfigSync(config.vault),
        installedArtifacts: receipt.artifacts,
        setupDefaults: receipt.defaults,
      });
      if (!resolution.available || resolution.artifact === undefined) {
        throw new Error(resolution.guidance ?? capabilityGuidance("generate"));
      }
      const created = createLlamaHydeGenerator({ modelPath: resolution.artifact.path });
      inner = created;
      return created;
    })().finally(() => {
      loading = null;
    });
    return loading;
  };

  return {
    generate: async (query: string): Promise<string> => {
      if (disposed) throw new Error("HyDE generator has been disposed.");
      return (await ensure()).generate(query);
    },
    expand: async (request) => {
      if (disposed) throw new Error("Generator has been disposed.");
      return (await ensure()).expand(request);
    },
    dispose: async (): Promise<void> => {
      disposed = true;
      if (loading !== null) await loading.catch(() => undefined);
      await inner?.dispose().catch(() => undefined);
      inner = null;
    },
  };
}

/**
 * Core assemblies stay model-free unless their caller supplied an explicit
 * model-resolution boundary. This prevents library and test callers from
 * accidentally loading a host-wide setup default.
 */
function createCoreOwnedGenerator(config: AssembleConfig): OwnedGenerator | undefined {
  const env = config.modelEnv;
  const hasGenerateEnv = env !== undefined &&
    typeof env["OMS_GENERATE_PROVIDER"] === "string" &&
    env["OMS_GENERATE_PROVIDER"]!.trim() !== "" &&
    typeof env["OMS_GENERATE_MODEL"] === "string" &&
    env["OMS_GENERATE_MODEL"]!.trim() !== "";
  const hasResolutionBoundary =
    config.modelRequests?.generate !== undefined ||
    config.modelsConfig?.generate !== undefined ||
    config.installedModelsReceipt !== undefined ||
    hasGenerateEnv;
  return hasResolutionBoundary ? createOwnedGenerator(config) : undefined;
}

function unavailableCapabilityStatus(capability: ModelCapability): McpSemanticModelCapabilityStatus {
  const [provider, model] = MODEL_CAPABILITY_ENV_PAIRS[capability];
  return {
    capability,
    available: false,
    source: "unavailable",
    guidance: `Configure ${provider} and ${model}, add ${capability} to .oms/models.json, or install a matching model with oms setup.`,
  };
}

function capabilityStatusFromResolution(
  capability: ModelCapability,
  resolution: ReturnType<typeof resolveModelCapability>,
): McpSemanticModelCapabilityStatus {
  if (!resolution.available || resolution.selection === undefined) {
    return {
      ...unavailableCapabilityStatus(capability),
      ...(resolution.guidance === undefined ? {} : { guidance: resolution.guidance }),
    };
  }
  const selection = resolution.selection;
  return {
    capability,
    available: true,
    source: resolution.source,
    provider: selection.provider,
    model: selection.model,
    revision: selection.revision,
    sha256: selection.sha256,
    ...(selection.promptScheme === undefined ? {} : { promptScheme: selection.promptScheme }),
    guidance: "",
  };
}

function modelCapabilityStatus(
  config: AssembleConfig,
): () => Readonly<Record<ModelCapability, McpSemanticModelCapabilityStatus>> {
  return () => {
    try {
      const receipt = config.installedModelsReceipt ??
        readInstalledModelsReceiptSync({ cacheDir: config.embeddingCacheDir });
      const vaultConfig = config.modelsConfig ?? readModelsConfigSync(config.vault);
      const env = {
        ...(config.modelEnv ?? process.env),
        ...(config.embeddingProvider === undefined ? {} : { [EMBEDDING_PROVIDER_ENV]: config.embeddingProvider }),
        ...(config.embeddingModel === undefined ? {} : { [EMBEDDING_MODEL_ENV]: config.embeddingModel }),
      };
      const resolve = (capability: ModelCapability) => capabilityStatusFromResolution(
        capability,
        resolveModelCapability({
          capability,
          request: config.modelRequests?.[capability],
          env,
          vaultConfig,
          installedArtifacts: receipt.artifacts,
          setupDefaults: receipt.defaults,
        }),
      );

      let embed: McpSemanticModelCapabilityStatus;
      if (config.embeddingDescriptor === undefined || config.embeddingDescriptor === null) {
        embed = resolve("embed");
      } else {
        const descriptor = parseEmbeddingModelDescriptor(config.embeddingDescriptor, { requirePath: true });
        validateEmbeddingDescriptor(descriptor, config);
        embed = {
          capability: "embed",
          available: true,
          source: "request",
          provider: descriptor.provider,
          model: descriptor.model,
          revision: descriptor.revision,
          sha256: descriptor.sha256,
          promptScheme: descriptor.prefixScheme,
          guidance: "",
        };
      }
      return { embed, rerank: resolve("rerank"), generate: resolve("generate") };
    } catch {
      return {
        embed: unavailableCapabilityStatus("embed"),
        rerank: unavailableCapabilityStatus("rerank"),
        generate: unavailableCapabilityStatus("generate"),
      };
    }
  };
}

function disposal(
  owned: DisposableReranker | undefined,
  provider: EmbeddingProvider,
  currentStore: () => EngineStore,
  ownedGenerator?: OwnedGenerator | undefined,
): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return (): Promise<void> => {
    promise ??= (async () => {
      // Generator first: it holds a native context that should be released before
      // the embedding provider it feeds.
      await ownedGenerator?.dispose().catch(() => undefined);
      await owned?.dispose().catch(() => undefined);
      await provider.dispose().catch(() => undefined);
      try { currentStore().close(); } catch { /* cleanup is best-effort */ }
    })();
    return promise;
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
  const dbPath = config.dbPath ?? engineStorePath(vault);
  const embedding = resolvedEmbeddingConfig(config);
  const owned = ownedReranker(config);
  const reranker = config.reranker ?? owned;

  const provider = requireRealEmbeddingProvider({
    provider: embedding.provider,
    model: embedding.runtimeModelPath,
    dimensions: embedding.dimensions,
    context: embedding.context,
    mrlDim: embedding.mrlDim,
    normalization: embedding.normalization,
    prefixScheme: embedding.prefixScheme,
  });

  let activeStore = openEngineStore(dbPath, provider.dimensions);

  // HyDE needs both a generator and an embedder, so it is wired only in the
  // vec-capable factories. A deferred-provider engine has nothing to embed the
  // hypothetical document with, and offering a generator there would trade one
  // loud failure for a more confusing one.
  const ownedGenerator = createOwnedGenerator(config);
  const hydeGenerator = config.hydeGenerator ?? ownedGenerator?.generate;
  const queryExpander = config.queryExpander ?? ownedGenerator?.expand;

  const deps: DispatcherDeps = {
    store: activeStore,
    embed: provider,
    ...(hydeGenerator === undefined ? {} : { hydeGenerator }),
    ...(queryExpander === undefined ? {} : { queryExpander }),
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingRevision: embedding.revision,
    embeddingSha256: embedding.sha256,
    embeddingDescriptor: embedding.descriptor,
    embeddingDimensions: embedding.dimensions,
    embeddingContext: embedding.context,
    embeddingMrlDim: embedding.mrlDim,
    embeddingNormalization: embedding.normalization,
    embeddingPrefixScheme: embedding.prefixScheme,
    modelCapabilityStatus: modelCapabilityStatus(config),
    dbPath,
    onStoreRebind: (store) => {
      activeStore = store;
    },
  }, reranker, true);

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
        files: opts.files,
        embed: opts.embed,
        force: opts.force,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        embeddingRevision: embedding.revision,
        embeddingSha256: embedding.sha256,
        embeddingDescriptor: embedding.descriptor,
        embeddingProviderInstance: provider,
        embeddingDimensions: embedding.dimensions,
        embeddingContext: embedding.context,
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

    dispose: disposal(owned, provider, () => activeStore, ownedGenerator),
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
  const dbPath = config.dbPath ?? engineStorePath(vault);

  const provider = makeDeferredProvider();
  const store = openEngineStoreCore(dbPath);
  const owned = ownedReranker(config);
  const reranker = config.reranker ?? owned;
  const ownedGenerator = createCoreOwnedGenerator(config);
  const hydeGenerator = config.hydeGenerator ?? ownedGenerator?.generate;
  const queryExpander = config.queryExpander ?? ownedGenerator?.expand;

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(hydeGenerator === undefined ? {} : { hydeGenerator }),
    ...(queryExpander === undefined ? {} : { queryExpander }),
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };

  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    embeddingRevision: config.embeddingRevision,
    embeddingSha256: config.embeddingSha256,
    embeddingDescriptor: config.embeddingDescriptor ?? undefined,
    embeddingDimensions: config.embeddingDimensions,
    embeddingContext: config.embeddingContext,
    embeddingMrlDim: config.embeddingMrlDim,
    embeddingNormalization: config.embeddingNormalization,
    embeddingPrefixScheme: config.embeddingPrefixScheme,
    modelCapabilityStatus: modelCapabilityStatus(config),
  }, reranker, true);

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
        files: opts.files,
        embed: opts.embed,
        force: opts.force,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        embeddingRevision: config.embeddingRevision,
        embeddingSha256: config.embeddingSha256,
        embeddingDescriptor: config.embeddingDescriptor ?? undefined,
        embeddingDimensions: config.embeddingDimensions,
        embeddingContext: config.embeddingContext,
        embeddingMrlDim: config.embeddingMrlDim,
        embeddingNormalization: config.embeddingNormalization,
        embeddingPrefixScheme: config.embeddingPrefixScheme,
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

    dispose: disposal(owned, provider, () => store, ownedGenerator),
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
  const owned = ownedReranker(config);
  const reranker = config.reranker ?? owned;
  const ownedGenerator = createCoreOwnedGenerator(config);
  const hydeGenerator = config.hydeGenerator ?? ownedGenerator?.generate;
  const queryExpander = config.queryExpander ?? ownedGenerator?.expand;
  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(hydeGenerator === undefined ? {} : { hydeGenerator }),
    ...(queryExpander === undefined ? {} : { queryExpander }),
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    embeddingRevision: config.embeddingRevision,
    embeddingSha256: config.embeddingSha256,
    embeddingDescriptor: config.embeddingDescriptor ?? undefined,
    embeddingDimensions: config.embeddingDimensions,
    embeddingContext: config.embeddingContext,
    embeddingMrlDim: config.embeddingMrlDim,
    embeddingNormalization: config.embeddingNormalization,
    embeddingPrefixScheme: config.embeddingPrefixScheme,
    modelCapabilityStatus: modelCapabilityStatus(config),
  }, reranker, true, false);

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
        files: opts.files,
        embed: false,
        force: opts.force,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        embeddingRevision: config.embeddingRevision,
        embeddingSha256: config.embeddingSha256,
        embeddingDescriptor: config.embeddingDescriptor ?? undefined,
        embeddingDimensions: config.embeddingDimensions,
        embeddingContext: config.embeddingContext,
        embeddingMrlDim: config.embeddingMrlDim,
        embeddingNormalization: config.embeddingNormalization,
        embeddingPrefixScheme: config.embeddingPrefixScheme,
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
    dispose: disposal(owned, provider, () => store, ownedGenerator),
  };
}

/**
 * Assemble an existing CORE-ONLY semantic engine without creating a store.
 * Returns null when the semantic index is absent or cannot be read safely.
 */
export function assembleCoreSemanticEngineReadOnly(config: AssembleConfig): AssembledEngine | null {
  const vault = config.vault;
  const dbPath = config.dbPath ?? engineStorePath(vault);
  const provider = makeDeferredProvider();
  const owned = ownedReranker(config);
  const reranker = config.reranker ?? owned;
  const ownedGenerator = createCoreOwnedGenerator(config);
  const hydeGenerator = config.hydeGenerator ?? ownedGenerator?.generate;
  const queryExpander = config.queryExpander ?? ownedGenerator?.expand;
  const store = openEngineStoreCoreReadOnly(dbPath);
  if (store === null) {
    void owned?.dispose().catch(() => undefined);
    void ownedGenerator?.dispose().catch(() => undefined);
    void provider.dispose().catch(() => undefined);
    return null;
  }

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(hydeGenerator === undefined ? {} : { hydeGenerator }),
    ...(queryExpander === undefined ? {} : { queryExpander }),
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    embeddingRevision: config.embeddingRevision,
    embeddingSha256: config.embeddingSha256,
    embeddingDescriptor: config.embeddingDescriptor ?? undefined,
    embeddingDimensions: config.embeddingDimensions,
    embeddingContext: config.embeddingContext,
    embeddingMrlDim: config.embeddingMrlDim,
    embeddingNormalization: config.embeddingNormalization,
    embeddingPrefixScheme: config.embeddingPrefixScheme,
    modelCapabilityStatus: modelCapabilityStatus(config),
  }, reranker, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: false,
    async syncVault(): Promise<SyncVaultResult> {
      throw new Error("AssembledEngine: syncVault is unavailable because the store is open read-only.");
    },
    dispose: disposal(owned, provider, () => store, ownedGenerator),
  };
}

/**
 * Assemble an existing vector-capable semantic engine without creating a store.
 * Returns null when the semantic index is absent or cannot be read safely.
 */
export function assembleEngineReadOnly(config: AssembleConfig): AssembledEngine | null {
  const vault = config.vault;
  const dbPath = config.dbPath ?? engineStorePath(vault);
  const embedding = resolvedEmbeddingConfig(config);
  const owned = ownedReranker(config);
  const reranker = config.reranker ?? owned;
  // The readonly store opener does not use dimensions. Open it before loading
  // the configured provider so an absent index is always an unavailable result.
  const store = openEngineStoreReadOnly(dbPath, 0);
  if (store === null) {
    void owned?.dispose().catch(() => undefined);
    return null;
  }

  let configuredIdentity;
  try {
    configuredIdentity = makeEmbeddingIdentity({
      provider: embedding.provider ?? "",
      model: embedding.model ?? "",
      revision: embedding.revision ?? "",
      sha256: embedding.sha256 ?? "",
      dimensions: embedding.dimensions ?? 0,
      contextLength: embedding.context ?? 0,
      mrlDim: embedding.mrlDim ?? -1,
      normalization: embedding.normalization ?? "",
      prefixScheme: embedding.prefixScheme ?? "",
    });
    const storedIdentity = store.readEmbeddingIdentity();
    if (storedIdentity !== null && !embeddingIdentitiesMatch(storedIdentity, configuredIdentity)) {
      throw new Error(
        `Embedding identity mismatch for read-only store: stored ${storedIdentity.provider}/${storedIdentity.model}@${storedIdentity.revision}/${storedIdentity.sha256} does not match configured ${configuredIdentity.provider}/${configuredIdentity.model}@${configuredIdentity.revision}/${configuredIdentity.sha256}.`,
      );
    }
  } catch (error) {
    store.close();
    void owned?.dispose().catch(() => undefined);
    throw error;
  }

  let provider: EmbeddingProvider;
  try {
    provider = requireRealEmbeddingProvider({
      provider: embedding.provider,
      model: embedding.runtimeModelPath,
      dimensions: embedding.dimensions,
      context: embedding.context,
      mrlDim: embedding.mrlDim,
      normalization: embedding.normalization,
      prefixScheme: embedding.prefixScheme,
    });
  } catch (error) {
    store.close();
    void owned?.dispose().catch(() => undefined);
    throw error;
  }

  // Read-only engines serve queries, and HyDE is a query strategy, so this factory
  // needs the generator too. The lazy wrapper allocates nothing until an explicit
  // `hyde` request arrives, so a read-only status check still loads no model.
  const ownedGenerator = createOwnedGenerator(config);
  const hydeGenerator = config.hydeGenerator ?? ownedGenerator?.generate;
  const queryExpander = config.queryExpander ?? ownedGenerator?.expand;

  const deps: DispatcherDeps = {
    store,
    embed: provider,
    ...(hydeGenerator === undefined ? {} : { hydeGenerator }),
    ...(queryExpander === undefined ? {} : { queryExpander }),
    ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
    ...(config.policy !== undefined ? { policy: config.policy } : {}),
    ...(config.graphDepth !== undefined ? { graphDepth: config.graphDepth } : {}),
  };
  const adapter = new McpEngineAdapter(deps, vault, {
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingRevision: embedding.revision,
    embeddingSha256: embedding.sha256,
    embeddingDescriptor: embedding.descriptor,
    embeddingDimensions: embedding.dimensions,
    embeddingContext: embedding.context,
    embeddingMrlDim: embedding.mrlDim,
    embeddingNormalization: embedding.normalization,
    embeddingPrefixScheme: embedding.prefixScheme,
    modelCapabilityStatus: modelCapabilityStatus(config),
    dbPath,
  }, reranker, false);

  return {
    adapter,
    deps,
    store,
    provider,
    implicitLexicalSync: false,
    async syncVault(): Promise<SyncVaultResult> {
      throw new Error("AssembledEngine: syncVault is unavailable because the store is open read-only.");
    },
    dispose: disposal(owned, provider, () => store, ownedGenerator),
  };
}

/**
 * Assemble a GRAPH-ONLY engine: graph ops run model-free; semantic store/embed
 * are throw-on-use guards.
 */
export function assembleGraphOnlyEngine(config: AssembleConfig): AssembledEngine {
  if (config.reranker !== undefined && config.rerankerFactory !== undefined) {
    throw new Error("Specify either reranker or rerankerFactory, not both.");
  }
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

  const adapter = new McpEngineAdapter(deps, vault, undefined, undefined, false);

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

    dispose: disposal(undefined, provider, () => store),
  };
}
