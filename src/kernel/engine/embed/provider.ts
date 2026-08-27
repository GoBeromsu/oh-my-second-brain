/**
 * EmbeddingProvider implementations for the OMS engine.
 *
 * Two production providers:
 *   1. GGUF / node-llama-cpp (EmbeddingGemma-300M, 768d, NO fold) — default production.
 *   2. Upstage Solar (4096d, REST API, env-keyed) — opt-in commercial path (ADR-002).
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
import type { EmbeddingProvider } from "../types.js";

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

interface EmbeddingPrefixes {
  readonly query: string;
  readonly passage: string;
}

/** Embedding provider seam for callers that need the query-side prefix. */
export interface QueryEmbeddingProvider extends EmbeddingProvider {
  readonly embedQuery: (text: string) => Promise<Float32Array>;
}

/**
 * Parse the descriptor's compact prefix declaration.  Setup descriptors use
 * either `none`, a JSON object (`{"query":"...","passage":"..."}`), or a
 * delimited pair such as `query=search_query:,passage=search_document:`.
 * Keeping parsing here makes the actual embedding calls deterministic and
 * prevents silently ignoring a non-`none` declaration.
 */
function parsePrefixScheme(value: string | undefined): EmbeddingPrefixes {
  const scheme = typeof value === "string" ? value.trim() : "none";
  if (scheme === "" || scheme.toLowerCase() === "none" || scheme.toLowerCase() === "symmetric") {
    return { query: "", passage: "" };
  }

  if (scheme.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scheme) as unknown;
    } catch {
      throw new Error(`Invalid embedding prefixScheme JSON: ${scheme}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Embedding prefixScheme JSON must be an object.");
    }
    const record = parsed as Record<string, unknown>;
    const query = record["query"] ?? record["queryPrefix"];
    const passage = record["passage"] ?? record["document"] ?? record["passagePrefix"] ?? record["documentPrefix"];
    if (
      (query !== undefined && typeof query !== "string") ||
      (passage !== undefined && typeof passage !== "string") ||
      (query === undefined && passage === undefined)
    ) {
      throw new Error("Embedding prefixScheme JSON requires a string query or passage value.");
    }
    return {
      query: typeof query === "string" ? query : "",
      passage: typeof passage === "string" ? passage : "",
    };
  }

  const fields: Partial<Record<"query" | "passage", string>> = {};
  const keyPattern = /(?:^|[;,|])\s*(query|queryPrefix|passage|passagePrefix|document|documentPrefix)\s*[:=]\s*/giu;
  const matches = [...scheme.matchAll(keyPattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const key = match[1]!.toLowerCase().startsWith("document")
      ? "passage"
      : match[1]!.toLowerCase().startsWith("passage")
        ? "passage"
        : "query";
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? scheme.length) : scheme.length;
    fields[key] = scheme.slice(start, end).trim();
  }
  if (fields.query !== undefined || fields.passage !== undefined) {
    return { query: fields.query ?? "", passage: fields.passage ?? "" };
  }
  throw new Error(
    `Unsupported embedding prefixScheme "${scheme}". Use "none", JSON, or query/passage declarations.`,
  );
}

// ---------------------------------------------------------------------------
// GGUF / node-llama-cpp provider  (descriptor width, no fold, lazy-load, pool)
// ---------------------------------------------------------------------------

interface GGUFPool {
  model: LlamaModelInstance;
  contexts: LlamaEmbeddingContextInstance[];
  nextIdx: number;
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
 */
export function createGGUFEmbeddingProvider(
  modelPath: string,
  dimensionsOrOptions: number | EmbeddingRuntimeOptions = GGUF_EMBEDDING_DIMENSIONS,
  contextLength?: number,
): QueryEmbeddingProvider {
  const runtime = runtimeOptions(dimensionsOrOptions, contextLength);
  const prefixes = parsePrefixScheme(
    typeof dimensionsOrOptions === "object" ? dimensionsOrOptions.prefixScheme : undefined,
  );
  const maxInputTokens = Math.max(1, runtime.contextLength - EMBED_INPUT_TOKEN_MARGIN);
  // Hardware-adaptive pool size (P-01 pattern, qmd MIT)
  const poolSize = Math.min(4, Math.max(1, cpus().length - 1));

  let pool: GGUFPool | null = null;
  let loadPromise: Promise<GGUFPool> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reset the 5-minute idle unload timer. Called on every embed(). */
  function resetIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pool === null) return;
      const p = pool;
      pool = null;
      void Promise.all(p.contexts.map((ctx) => ctx.dispose().catch(() => undefined)))
        .then(() => p.model.dispose().catch(() => undefined));
    }, IDLE_UNLOAD_MS);
  }

  /** Ensure the pool is initialised. Returns the live pool. */
  async function ensurePool(): Promise<GGUFPool> {
    if (pool !== null) return pool;
    // Deduplicate concurrent init calls via a shared promise
    if (loadPromise !== null) return loadPromise;

    loadPromise = (async (): Promise<GGUFPool> => {
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const contexts = await Promise.all(
        Array.from({ length: poolSize }, () =>
          model.createEmbeddingContext({
            contextSize: runtime.contextLength,
            batchSize: runtime.contextLength,
          }),
        ),
      );
      pool = { model, contexts, nextIdx: 0 };
      return pool;
    })().finally(() => {
      loadPromise = null;
    });

    return loadPromise;
  }

  const provider = {
    model: `node-llama-cpp:${modelPath}`,
    dimensions: runtime.dimensions,
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

    async embed(text: string): Promise<Float32Array> {
      return embedPassage(text);
    },

    async embedQuery(text: string): Promise<Float32Array> {
      return embedText(`${prefixes.query}${text}`);
    },
    dispose: disposeProvider,
  } as QueryEmbeddingProvider & {
    readonly contextLength: number;
    readonly embedQuery: (text: string) => Promise<Float32Array>;
  };

  async function embedText(text: string): Promise<Float32Array> {
    resetIdleTimer();
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
    // Round-robin context selection across the pool
    const idx = p.nextIdx % p.contexts.length;
    p.nextIdx = idx + 1;
    const ctx = p.contexts[idx]!;
    const result = await ctx.getEmbeddingFor(input);
    // No fold — return the full provider vector, L2-normalised
    const vector = normalizeVector(result.vector);
    if (vector.length !== runtime.dimensions) {
      throw new Error(
        `GGUF embedding returned ${vector.length} dimensions; expected ${runtime.dimensions}.`,
      );
    }
    return vector;
  }

  async function embedPassage(text: string): Promise<Float32Array> {
    return embedText(`${prefixes.passage}${text}`);
  }

  async function disposeProvider(): Promise<void> {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // Wait for any in-flight load to complete before disposing
    if (loadPromise !== null) {
      try { await loadPromise; } catch { /* load failed, nothing to dispose */ }
    }
    if (pool !== null) {
      const p = pool;
      pool = null;
      await Promise.all(p.contexts.map((ctx) => ctx.dispose().catch(() => undefined)));
      await p.model.dispose().catch(() => undefined);
    }
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Upstage Solar provider  (4096d, REST API, opt-in commercial, ADR-002)
// ---------------------------------------------------------------------------

const UPSTAGE_DIMENSIONS = 4096;
const UPSTAGE_API_URL = "https://api.upstage.ai/v1/embeddings";
// No default model: OMS config must supply OMS_EMBEDDING_MODEL explicitly.

interface UpstageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

/**
 * Create an Upstage Solar embedding provider (4096d).
 *
 * This is the opt-in commercial path (ADR-002 tier model).  Only activate
 * when UPSTAGE_API_KEY is set in the environment; never use by default.
 * The API key MUST come from env — never hardcoded (R4 secrets-via-env).
 */
export function createUpstageProvider(
  apiKey: string,
  model: string,
  dimensions = UPSTAGE_DIMENSIONS,
  metadata: Pick<EmbeddingRuntimeOptions, "context" | "contextLength" | "contextTokens" | "mrlDim" | "normalization" | "prefixScheme"> = {},
): QueryEmbeddingProvider {
  const resolvedDimensions = positiveInteger(dimensions, UPSTAGE_DIMENSIONS, "dimensions");
  const contextLength = metadata.context ?? metadata.contextLength ?? metadata.contextTokens;
  const prefixes = parsePrefixScheme(metadata.prefixScheme);
  const provider = {
    model: `upstage:${model}`,
    dimensions: resolvedDimensions,
    ...(contextLength === undefined ? {} : { context: contextLength }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(metadata.mrlDim === undefined ? {} : { mrlDim: metadata.mrlDim }),
    ...(metadata.normalization === undefined ? {} : { normalization: metadata.normalization }),
    ...(metadata.prefixScheme === undefined ? {} : { prefixScheme: metadata.prefixScheme }),

    async embed(text: string): Promise<Float32Array> {
      return embedPassage(text);
    },

    async embedQuery(text: string): Promise<Float32Array> {
      return embedText(`${prefixes.query}${text}`);
    },
    dispose: () => Promise.resolve(),
  } as QueryEmbeddingProvider & Partial<{
    readonly context: number;
    readonly contextLength: number;
    readonly mrlDim: number;
    readonly normalization: string;
    readonly prefixScheme: string;
    readonly embedQuery: (text: string) => Promise<Float32Array>;
  }>;

  async function embedPassage(text: string): Promise<Float32Array> {
    return embedText(`${prefixes.passage}${text}`);
  }

  async function embedText(text: string): Promise<Float32Array> {
    let input = (text ?? "").trim();
    // Upstage rejects empty input with HTTP 400. Empty/whitespace chunks
    // carry no semantic signal — return a zero vector so sync proceeds.
    if (input.length === 0) return new Float32Array(resolvedDimensions);

    // Solar caps input at 4000 tokens. Rather than fail the whole sync on a
    // single oversized chunk, shrink the input and retry until it fits.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(UPSTAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input, model }),
      });
      if (response.ok) {
        const json = (await response.json()) as UpstageEmbeddingResponse;
        const embedding = json.data[0]?.embedding;
        if (!embedding) {
          throw new Error("Upstage Solar API returned no embedding");
        }
        const vector = normalizeVector(embedding);
        if (vector.length !== resolvedDimensions) {
          throw new Error(
            `Upstage Solar API returned ${vector.length} dimensions; expected ${resolvedDimensions}.`,
          );
        }
        return vector;
      }
      const body = await response.text().catch(() => "");
      if (
        response.status === 400 &&
        /maximum context length/i.test(body) &&
        input.length > 200
      ) {
        input = input.slice(0, Math.floor(input.length * 0.6));
        continue;
      }
      throw new Error(
        `Upstage Solar API error: ${response.status} ${response.statusText} ${body.slice(0, 160)}`,
      );
    }
    throw new Error(
      "Upstage Solar API error: input could not be reduced under the 4000-token limit",
    );
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Production factory — strict, explicit, no auto-detect
// ---------------------------------------------------------------------------

export type EmbeddingProviderKind = "gguf" | "upstage";

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

/** Alias kept for callers that import StrictEmbeddingProviderOptions by name. */
export type StrictEmbeddingProviderOptions = EmbeddingProviderOptions;

/**
 * Resolve a REAL embedding provider or throw.
 *
 * This is the ONE production factory for the OMS engine. It NEVER falls back to
 * a fake/stub embedder and it NEVER auto-selects a provider based on env key
 * presence (UPSTAGE_API_KEY, etc.). Provider selection is explicit.
 *
 * @throws {Error} When provider/model are missing or unsupported, or when
 *                 provider-specific auth is missing.
 */
export function requireRealEmbeddingProvider(
  opts: StrictEmbeddingProviderOptions = {},
): QueryEmbeddingProvider {
  const providerRaw = (opts.provider ?? "").toString().trim();
  const model = (opts.model ?? "").toString().trim();

  if (!providerRaw) {
    throw new Error(
      "OMS embedding provider is not configured. Set OMS_EMBEDDING_PROVIDER " +
        "(e.g. gguf or upstage) and OMS_EMBEDDING_MODEL, then rerun sync.",
    );
  }
  if (!model) {
    throw new Error(
      `OMS embedding model is not configured for provider "${providerRaw}". ` +
        "Set OMS_EMBEDDING_MODEL and rerun sync.",
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

  if (providerRaw === "upstage") {
    const upstageKey = process.env["UPSTAGE_API_KEY"];
    if (!upstageKey) {
      throw new Error(
        "OMS embedding provider is configured as upstage but UPSTAGE_API_KEY is missing.",
      );
    }
    return createUpstageProvider(upstageKey, model, opts.dimensions, {
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
      "Supported providers: gguf, upstage.",
  );
}
