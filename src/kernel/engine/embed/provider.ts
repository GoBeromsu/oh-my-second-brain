/**
 * EmbeddingProvider implementations for the OMS engine.
 *
 * The sole production provider is GGUF / node-llama-cpp
 * (EmbeddingGemma-300M, 768d, NO fold).
 *
 * The hash-projection stub is TEST-ONLY and lives in hash-stub.test-helper.ts.
 * It MUST NOT be imported by any production module.
 *
 * Patterns ported idea-only from qmd (tobi, MIT) — see ACKNOWLEDGMENTS.md M1 section:
 *   - Lazy-load + 5-minute idle unload guard (plan.md:83 sanctioned timer)
 *   - Hardware-adaptive parallel pool (P-01): pool = min(4, cpuCount-1), ≥1
 *   - Round-robin context selection across the pool
 *
 * R18 constraint: this file MUST NOT import anything from src/search at runtime.
 * The GGUF embedding logic is re-implemented independently here.
 */

import { cpus } from "node:os";
import { UNTITLED_DOCUMENT_TITLE } from "../types.js";
import type { EmbeddingProvider } from "../types.js";
import { capabilityGuidance } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default embedding dimension for the GGUF provider (EmbeddingGemma-300M). */
export const GGUF_EMBEDDING_DIMENSIONS = 768;

/** Default context length for the GGUF provider (EmbeddingGemma-300M). */
export const GGUF_EMBEDDING_CONTEXT_LENGTH = 2048;

/** Milliseconds of inactivity before the GGUF pool is unloaded (plan.md:83). */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

/**
 * Hard input-token ceiling enforced before every embed() call.
 *
 * Sits a margin below the descriptor context length to leave room for any special /
 * task-prefix tokens getEmbeddingFor() injects. Inputs above this are
 * token-exactly truncated via the model's own tokenizer rather than thrown —
 * the engine MUST never choke on one oversized chunk the way the whole-doc
 * floor (src/search) does. This bounds INPUT LENGTH only; it is NOT a dimension
 * fold (ADR-007) — the emitted vector remains the provider width.
 */
const EMBED_INPUT_TOKEN_MARGIN = 148;

// ---------------------------------------------------------------------------
// node-llama-cpp type aliases (dynamic import; avoids hard dep at module load)
// ---------------------------------------------------------------------------

type NodeLlamaCppModule = typeof import("node-llama-cpp");
type LlamaInstance = Awaited<ReturnType<NodeLlamaCppModule["getLlama"]>>;
type LlamaModelInstance = Awaited<ReturnType<LlamaInstance["loadModel"]>>;
type LlamaEmbeddingContextInstance = Awaited<
  ReturnType<LlamaModelInstance["createEmbeddingContext"]>
>;
type GGUFModelLoader = (modelPath: string) => Promise<LlamaModelInstance>;

// ---------------------------------------------------------------------------
// L2-normalise helper (GGUF provider — full vector, NO dimension folding)
// ---------------------------------------------------------------------------

/**
 * L2-normalise a raw embedding vector and return as Float32Array.
 *
 * There is NO modulo fold or projection here: the full provider vector is
 * preserved.  A malformed model response is a hard error.  Replacing NaN or
 * Infinity with zero would make a corrupted index look valid and, worse,
 * produce vectors that cannot be reproduced on a later sync.
 */
function normalizeVector(values: readonly number[]): Float32Array {
  const vec = new Float32Array(values.length);
  let mag = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Embedding vector contains a non-finite value at index ${i}.`);
    }
    vec[i] = v;
    mag += vec[i]! * vec[i]!;
  }
  if (!Number.isFinite(mag)) {
    throw new Error("Embedding vector norm is non-finite.");
  }
  if (mag === 0) return vec;
  const norm = Math.sqrt(mag);
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

interface EmbeddingPromptFormatter {
  readonly query: (text: string) => string;
  readonly document: (text: string, title?: string) => string;
}

/** Embedding provider seam for callers that need query-side embeddings. */
export interface QueryEmbeddingProvider extends EmbeddingProvider {
  readonly embedQuery: (text: string) => Promise<Float32Array>;
}

/**
 * Resolve the descriptor's closed, versioned embedding prompt scheme.
 *
 * Blank runtime values retain the explicitly unprefixed default. Every other
 * value must name one of these formatters; arbitrary prefixes are not prompts.
 */
function promptFormatter(value: string | undefined): EmbeddingPromptFormatter {
  const scheme = typeof value === "string" ? value.trim() : "none";
  switch (scheme) {
    case "":
    case "none":
      return {
        query: (text) => text,
        document: (text) => text,
      };
    case "embeddinggemma-v1":
      return {
        query: (text) => `task: search result | query: ${text}`,
        document: (text, title) => {
          const resolvedTitle = title?.trim() || UNTITLED_DOCUMENT_TITLE;
          return `title: ${resolvedTitle} | text: ${text}`;
        },
      };
    case "qwen3-embedding-v1":
      return {
        query: (text) => `Instruct: Retrieve relevant documents for the given query\nQuery: ${text}`,
        document: (text, title) => {
          const resolvedTitle = title?.trim();
          return resolvedTitle === undefined || resolvedTitle === "" ? text : `${resolvedTitle}\n${text}`;
        },
      };
    default:
      throw new Error(
        `Unsupported embedding prefixScheme "${scheme}". Use "none", "embeddinggemma-v1", or "qwen3-embedding-v1".`,
      );
  }
}

// ---------------------------------------------------------------------------
// GGUF / node-llama-cpp provider  (descriptor width, no fold, lazy-load, pool)
// ---------------------------------------------------------------------------

interface GGUFPool {
  model: LlamaModelInstance;
  contexts: LlamaEmbeddingContextInstance[];
  /** Context indexes not currently evaluating an embedding. */
  available: number[];
  /** FIFO callers waiting for a context; prevents concurrent use of one context. */
  waiters: Array<{
    readonly resolve: (index: number) => void;
    readonly reject: (reason: Error) => void;
  }>;
}

/** Per-model runtime dimensions/context supplied by the model descriptor. */
export interface EmbeddingRuntimeOptions {
  readonly dimensions?: number;
  /** Canonical model context window in tokens. */
  readonly context?: number;
  /** Canonical context length field. */
  readonly contextLength?: number;
  /** Descriptor alias used by setup adapters. */
  readonly contextTokens?: number;
  readonly mrlDim?: number;
  readonly normalization?: string;
  readonly prefixScheme?: string;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Embedding ${label} must be a positive integer.`);
  }
  return resolved;
}

function runtimeOptions(
  value: number | EmbeddingRuntimeOptions | undefined,
  contextLength: number | undefined,
): { dimensions: number; contextLength: number } {
  const dimensionsInput = typeof value === "number" ? value : value?.dimensions;
  const contextInput = typeof value === "number"
    ? contextLength
    : value?.context ?? value?.contextLength ?? value?.contextTokens ?? contextLength;
  return {
    dimensions: positiveInteger(dimensionsInput, GGUF_EMBEDDING_DIMENSIONS, "dimensions"),
    contextLength: positiveInteger(contextInput, GGUF_EMBEDDING_CONTEXT_LENGTH, "context length"),
  };
}

async function loadGGUFModel(modelPath: string): Promise<LlamaModelInstance> {
  const { getLlama } = await import("node-llama-cpp");
  const llama = await getLlama();
  return llama.loadModel({ modelPath });
}

/**
 * Create a production EmbeddingProvider backed by a local GGUF model via
 * node-llama-cpp.  Target model: EmbeddingGemma-300M (descriptor width).
 *
 * Design (ported idea-only from qmd, MIT — ACKNOWLEDGMENTS.md M1):
 *   - Lazy-load: model/contexts are not initialised until the first embed() call.
 *   - 5-minute idle unload guard (plan.md:83, the ONLY permitted timer):
 *       each embed() call resets a setTimeout; if no calls arrive within
 *       IDLE_UNLOAD_MS the pool is fully disposed; next embed() reloads lazily.
 *   - Hardware-adaptive parallel pool: pool size = min(4, cpuCount-1), ≥ 1.
 *       Contexts are selected round-robin; embed calls do not queue.
 *
 * @param modelPath  - Absolute path to the GGUF model file.
 * @param dimensionsOrOptions - Expected width or descriptor runtime options.
 * @param contextLength - Legacy positional context-length override.
 * @param loadModel - Test seam; production callers use the node-llama-cpp loader.
 */
export function createGGUFEmbeddingProvider(
  modelPath: string,
  dimensionsOrOptions: number | EmbeddingRuntimeOptions = GGUF_EMBEDDING_DIMENSIONS,
  contextLength?: number,
  loadModel: GGUFModelLoader = loadGGUFModel,
): QueryEmbeddingProvider {
  const runtime = runtimeOptions(dimensionsOrOptions, contextLength);
  const formatter = promptFormatter(
    typeof dimensionsOrOptions === "object" ? dimensionsOrOptions.prefixScheme : undefined,
  );
  const maxInputTokens = Math.max(1, runtime.contextLength - EMBED_INPUT_TOKEN_MARGIN);
  // Four contexts are the measured optimum for OMS's document-worker scheduler on
  // the supported M1 Pro baseline. Raising this to qmd's eight-context ceiling made
  // the exact 19-document fixture slower (23.68s → 24.85s) and raised RSS
  // (691 MiB → 778 MiB), because context initialization outweighed the extra lanes.
  const poolSize = Math.min(4, Math.max(1, cpus().length - 1));

  let pool: GGUFPool | null = null;
  let loadPromise: Promise<GGUFPool> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let activeCalls = 0;
  let activeCallsIdle = Promise.resolve();
  let resolveActiveCallsIdle: (() => void) | null = null;
  const pendingPoolDisposals = new Set<Promise<void>>();

  function scheduleIdleUnload(): void {
    if (disposed || activeCalls !== 0 || pool === null) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (disposed || activeCalls !== 0 || pool === null) return;
      const p = pool;
      pool = null;
      trackPoolDisposal(p);
    }, IDLE_UNLOAD_MS);
  }

  async function disposePool(p: GGUFPool): Promise<void> {
    await Promise.all(p.contexts.map((ctx) => ctx.dispose().catch(() => undefined)));
    await p.model.dispose().catch(() => undefined);
  }

  function trackPoolDisposal(p: GGUFPool): void {
    let disposal: Promise<void>;
    disposal = disposePool(p).finally(() => {
      pendingPoolDisposals.delete(disposal);
    });
    pendingPoolDisposals.add(disposal);
  }

  function beginCall(): void {
    if (disposed) throw new Error("GGUF embedding provider has been disposed.");
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (activeCalls === 0) {
      activeCallsIdle = new Promise<void>((resolve) => {
        resolveActiveCallsIdle = resolve;
      });
    }
    activeCalls += 1;
  }

  function endCall(): void {
    activeCalls -= 1;
    if (activeCalls === 0) {
      resolveActiveCallsIdle?.();
      resolveActiveCallsIdle = null;
      scheduleIdleUnload();
    }
  }

  /** Ensure the pool is initialised. Returns the live pool. */
  async function ensurePool(): Promise<GGUFPool> {
    if (disposed) throw new Error("GGUF embedding provider has been disposed.");
    if (pool !== null) return pool;
    // Deduplicate concurrent init calls via a shared promise
    if (loadPromise !== null) return loadPromise;

    loadPromise = (async (): Promise<GGUFPool> => {
      const model = await loadModel(modelPath);
      const contexts = await Promise.all(
        Array.from({ length: poolSize }, () =>
          model.createEmbeddingContext({
            contextSize: runtime.contextLength,
          }),
        ),
      );
      const loadedPool: GGUFPool = {
        model,
        contexts,
        available: contexts.map((_, index) => index),
        waiters: [],
      };
      if (disposed) {
        await disposePool(loadedPool);
        throw new Error("GGUF embedding provider has been disposed.");
      }
      pool = loadedPool;
      return loadedPool;
    })().finally(() => {
      loadPromise = null;
    });

    return loadPromise;
  }

  const provider = {
    model: `node-llama-cpp:${modelPath}`,
    dimensions: runtime.dimensions,
    // One independent native context per lane. The sync kernel uses this bound to
    // parallelize documents; without exposing it, three of the four contexts stayed
    // idle while a 21k-note vault projected to roughly 75 hours.
    maxConcurrency: poolSize,
    // Expose the descriptor-derived context to identity/sync without widening
    // the shared EmbeddingProvider contract.
    context: runtime.contextLength,
    contextLength: runtime.contextLength,
    ...(typeof dimensionsOrOptions === "object" && dimensionsOrOptions.mrlDim !== undefined
      ? { mrlDim: dimensionsOrOptions.mrlDim }
      : {}),
    ...(typeof dimensionsOrOptions === "object" && dimensionsOrOptions.normalization !== undefined
      ? { normalization: dimensionsOrOptions.normalization }
      : {}),
    ...(typeof dimensionsOrOptions === "object" && dimensionsOrOptions.prefixScheme !== undefined
      ? { prefixScheme: dimensionsOrOptions.prefixScheme }
      : {}),

    async embed(text: string, title?: string): Promise<Float32Array> {
      return embedPassage(text, title);
    },

    async embedQuery(text: string): Promise<Float32Array> {
      return embedText(formatter.query(text));
    },
    dispose: disposeProvider,
  } as QueryEmbeddingProvider & {
    readonly contextLength: number;
    readonly embedQuery: (text: string) => Promise<Float32Array>;
  };

  async function embedText(text: string): Promise<Float32Array> {
    beginCall();
    try {
      const p = await ensurePool();
      // Token-exact truncation: never feed more than the context can hold, so a
      // single oversized chunk can never throw "Input is longer than the context
      // size". Bounds INPUT LENGTH only via the model's own tokenizer — NOT a
      // dimension fold (ADR-007); the output stays at the provider width.
      let input = text;
      const tokens = p.model.tokenize(text);
      if (tokens.length > maxInputTokens) {
        input = p.model.detokenize(tokens.slice(0, maxInputTokens));
      }
      // Acquire an actually idle context. Round-robin assignment alone is unsafe:
      // whichever request finishes first may ask for its next chunk while the
      // round-robin cursor points at a different, still-busy context.
      const idx = p.available.shift() ?? await new Promise<number>((resolve, reject) => {
        if (disposed) {
          reject(new Error("GGUF embedding provider has been disposed."));
          return;
        }
        p.waiters.push({ resolve, reject });
      });
      const ctx = p.contexts[idx]!;
      try {
        const result = await ctx.getEmbeddingFor(input);
        // No fold — return the full provider vector, L2-normalised
        const vector = normalizeVector(result.vector);
        if (vector.length !== runtime.dimensions) {
          throw new Error(
            `GGUF embedding returned ${vector.length} dimensions; expected ${runtime.dimensions}.`,
          );
        }
        return vector;
      } finally {
        const waiter = p.waiters.shift();
        if (waiter === undefined) p.available.push(idx);
        else waiter.resolve(idx);
      }
    } finally {
      endCall();
    }
  }

  async function embedPassage(text: string, title?: string): Promise<Float32Array> {
    return embedText(formatter.document(text, title));
  }

  async function disposeProvider(): Promise<void> {
    if (disposePromise !== null) return disposePromise;
    disposed = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    for (const waiter of pool?.waiters.splice(0) ?? []) {
      waiter.reject(new Error("GGUF embedding provider has been disposed."));
    }
    disposePromise = (async () => {
      if (loadPromise !== null) {
        try { await loadPromise; } catch { /* failed loads own no native pool */ }
      }
      await activeCallsIdle;
      if (pool !== null) {
        const p = pool;
        pool = null;
        trackPoolDisposal(p);
      }
      await Promise.all([...pendingPoolDisposals]);
    })();
    return disposePromise;
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Production factory — strict, explicit, no auto-detect
// ---------------------------------------------------------------------------

export type EmbeddingProviderKind = "gguf";

/** Options for the production embedding factory (explicit provider + model). */
export interface EmbeddingProviderOptions {
  /** Provider id selected by OMS_EMBEDDING_PROVIDER. */
  provider?: EmbeddingProviderKind | string;
  /** Provider-specific model identifier selected by OMS_EMBEDDING_MODEL. */
  model?: string;
  /** Descriptor-derived vector width. */
  dimensions?: number;
  /** Canonical model context window in tokens. */
  context?: number;
  /** Descriptor-derived context length (no model-specific default here). */
  contextLength?: number;
  /** Setup descriptor alias for contextLength. */
  contextTokens?: number;
  mrlDim?: number;
  normalization?: string;
  prefixScheme?: string;
}

/**
 * Resolve a REAL embedding provider or throw.
 *
 * This is the ONE production factory for the OMS engine. It NEVER falls back to
 * a fake/stub embedder. Provider selection is explicit.
 *
 * @throws {Error} When provider/model are missing or unsupported.
 */
export function requireRealEmbeddingProvider(
  opts: EmbeddingProviderOptions = {},
): QueryEmbeddingProvider {
  const providerRaw = (opts.provider ?? "").toString().trim();
  const model = (opts.model ?? "").toString().trim();

  // Both branches below mean the embed capability is unconfigured, so both emit the
  // shared capability guidance instead of a locally worded variant. These messages
  // reach the MCP surface verbatim, and they previously named the environment pair
  // alone — telling an agent one of the three ways to configure a model while
  // omitting `.oms/models.json` and the one-step install entirely.
  //
  // The supported-provider hint is kept: the shared guidance says where to set a
  // provider but not which values are valid, and that is the first thing someone
  // hitting this error needs to know.
  if (!providerRaw) {
    throw new Error(
      `OMS embedding provider is not configured. ${capabilityGuidance("embed")} ` +
        "Supported provider: gguf.",
    );
  }
  if (!model) {
    throw new Error(
      `OMS embedding model is not configured for provider "${providerRaw}". ` +
        capabilityGuidance("embed"),
    );
  }

  if (providerRaw === "gguf") {
    return createGGUFEmbeddingProvider(model, {
      dimensions: opts.dimensions,
      context: opts.context,
      contextLength: opts.contextLength,
      contextTokens: opts.contextTokens,
      mrlDim: opts.mrlDim,
      normalization: opts.normalization,
      prefixScheme: opts.prefixScheme,
    });
  }

  throw new Error(
    `OMS embedding provider "${providerRaw}" is unsupported. ` +
      "Supported provider: gguf.",
  );
}
