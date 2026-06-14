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

/** Milliseconds of inactivity before the GGUF pool is unloaded (plan.md:83). */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

/**
 * Embedding context window for EmbeddingGemma-300M (its trained n_ctx).
 *
 * Each pooled context is sized to this EXPLICITLY rather than left to
 * node-llama-cpp's "auto": a pool of N auto-sized contexts divides available
 * memory N ways and each can silently shrink below the largest chunk, making
 * getEmbeddingFor() throw "Input is longer than the context size". Pinning the
 * window makes embedding deterministic across pool sizes and keeps inputs
 * in-distribution (2048 = trained context → no overflow degradation).
 */
const EMBED_CONTEXT_TOKENS = 2048;

/**
 * Hard input-token ceiling enforced before every embed() call.
 *
 * Sits a margin below EMBED_CONTEXT_TOKENS to leave room for any special /
 * task-prefix tokens getEmbeddingFor() injects. Inputs above this are
 * token-exactly truncated via the model's own tokenizer rather than thrown —
 * the engine MUST never choke on one oversized chunk the way the whole-doc
 * floor (src/search) does. This bounds INPUT LENGTH only; it is NOT a dimension
 * fold (ADR-007) — the emitted vector is still the full 768d.
 */
const EMBED_MAX_INPUT_TOKENS = 1900;

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
 * Unlike src/search/semantic-embedding-provider.ts::projectEmbeddingVector(),
 * there is NO modulo fold here: the full 768-element vector is preserved.
 * For EmbeddingGemma-300M this means float[768], no lossy fold to 64d.
 */
function normalizeVector(values: readonly number[]): Float32Array {
  const vec = new Float32Array(values.length);
  let mag = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    vec[i] = Number.isFinite(v) ? v : 0;
    mag += vec[i]! * vec[i]!;
  }
  if (mag === 0) return vec;
  const norm = Math.sqrt(mag);
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

// ---------------------------------------------------------------------------
// GGUF / node-llama-cpp provider  (768d, no fold, lazy-load, pool)
// ---------------------------------------------------------------------------

interface GGUFPool {
  model: LlamaModelInstance;
  contexts: LlamaEmbeddingContextInstance[];
  nextIdx: number;
}

/**
 * Create a production EmbeddingProvider backed by a local GGUF model via
 * node-llama-cpp.  Target model: EmbeddingGemma-300M (768d).
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
 * @param dimensions - Expected embedding dimension (default 768 for Gemma-300M).
 */
export function createGGUFEmbeddingProvider(
  modelPath: string,
  dimensions = GGUF_EMBEDDING_DIMENSIONS,
): EmbeddingProvider {
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
            contextSize: EMBED_CONTEXT_TOKENS,
            batchSize: EMBED_CONTEXT_TOKENS,
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

  return {
    model: `node-llama-cpp:${modelPath}`,
    dimensions,

    async embed(text: string): Promise<Float32Array> {
      resetIdleTimer();
      const p = await ensurePool();
      // Token-exact truncation: never feed more than the context can hold, so a
      // single oversized chunk can never throw "Input is longer than the context
      // size". Bounds INPUT LENGTH only via the model's own tokenizer — NOT a
      // dimension fold (ADR-007); the output stays full 768d.
      let input = text;
      const tokens = p.model.tokenize(text);
      if (tokens.length > EMBED_MAX_INPUT_TOKENS) {
        input = p.model.detokenize(tokens.slice(0, EMBED_MAX_INPUT_TOKENS));
      }
      // Round-robin context selection across the pool
      const idx = p.nextIdx % p.contexts.length;
      p.nextIdx = idx + 1;
      const ctx = p.contexts[idx]!;
      const result = await ctx.getEmbeddingFor(input);
      // No fold — return full 768d, L2-normalised
      return normalizeVector(result.vector);
    },

    async dispose(): Promise<void> {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Upstage Solar provider  (4096d, REST API, opt-in commercial, ADR-002)
// ---------------------------------------------------------------------------

const UPSTAGE_DIMENSIONS = 4096;
const UPSTAGE_API_URL = "https://api.upstage.ai/v1/embeddings";
const UPSTAGE_MODEL = "solar-embedding-1-passage";

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
export function createUpstageProvider(apiKey: string): EmbeddingProvider {
  return {
    model: "upstage-solar-embedding-1-passage:4096d",
    dimensions: UPSTAGE_DIMENSIONS,

    async embed(text: string): Promise<Float32Array> {
      const response = await fetch(UPSTAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: text, model: UPSTAGE_MODEL }),
      });
      if (!response.ok) {
        throw new Error(
          `Upstage Solar API error: ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as UpstageEmbeddingResponse;
      const embedding = json.data[0]?.embedding;
      if (!embedding) throw new Error("Upstage Solar API returned no embedding");
      return normalizeVector(embedding);
    },

    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Production factory — strict, fails loud when no real model is available
// ---------------------------------------------------------------------------

/** Options for the production embedding factory. */
export interface EmbeddingProviderOptions {
  /** Absolute path to a GGUF model file (enables real 768d embeddings). */
  modelPath?: string;
}

/** Alias kept for callers that import StrictEmbeddingProviderOptions by name. */
export type StrictEmbeddingProviderOptions = EmbeddingProviderOptions;

/**
 * Resolve a REAL embedding provider or throw.
 *
 * This is the ONE production factory for the OMS engine.  It NEVER falls back
 * to a fake/stub embedder — missing configuration is a loud error, not a
 * silent corruption.
 *
 * Resolution order:
 *   1. UPSTAGE_API_KEY env var set → Upstage Solar (4096d).
 *   2. opts.modelPath provided → GGUF / node-llama-cpp (768d, EmbeddingGemma-300M).
 *   3. Neither available → throws with a clear message mentioning OMS_MODEL_PATH.
 *
 * @throws {Error} When neither UPSTAGE_API_KEY nor modelPath is available.
 */
export function requireRealEmbeddingProvider(
  opts: StrictEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const upstageKey = process.env["UPSTAGE_API_KEY"];
  if (upstageKey) {
    return createUpstageProvider(upstageKey);
  }
  if (opts.modelPath) {
    return createGGUFEmbeddingProvider(opts.modelPath);
  }
  throw new Error(
    "OMS production path requires a real embedding model but none is configured. " +
    "Set OMS_MODEL_PATH to the absolute path of the GGUF model file " +
    "(e.g. /path/to/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf) " +
    "or set UPSTAGE_API_KEY for the Upstage Solar API. " +
    "The hash-projection fallback (model id 'hash-projection:dim=64') is NOT " +
    "permitted on the production assemble path — it would silently produce " +
    "fake embeddings and corrupt the vault index.",
  );
}
