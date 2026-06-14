/**
 * Engine model-pull helper.
 *
 * Ports src/search/semantic-diagnostics.ts::pullSemanticModels() for the
 * engine embedding layer.  This is a documentation/utility function only —
 * it NEVER downloads files automatically.  All actual downloads are
 * one-time manual steps performed by the user.
 *
 * R18: no runtime import from src/search.
 * R4:  secrets (API keys) via env only — never hardcoded.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target GGUF model for the engine embedding layer (plan.md:83). */
const GGUF_MODEL_NAME = "EmbeddingGemma-300M";
const GGUF_EMBEDDING_DIMENSIONS = 768;

/**
 * Recommended Hugging Face repository and filename.
 * Q8_0 quantisation gives the best quality/size ratio for inference.
 */
const GGUF_HF_REPO = "lm-kit/embedding-gemma-300m-gguf";
const GGUF_HF_FILE = "EmbeddingGemma-300M-Q8_0.gguf";
const GGUF_DEFAULT_DEST = "~/.oms/models";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnginePullResult {
  available: boolean;
  models: {
    /** Human-readable model identifier for the primary path. */
    embedding: string;
    /** Embedding dimension produced by this model. */
    dimensions: number;
    /** Opt-in commercial alternative (Upstage Solar, env-keyed). */
    commercial?: string;
  };
  /** Currently configured model path (from opts or OMS_MODEL_PATH env). */
  modelPath?: string;
  /**
   * Shell commands to download the GGUF model and configure the engine.
   * Copy-paste into a terminal — no automatic execution.
   */
  pullCommand: string;
  /** Human-readable status message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Public helper
// ---------------------------------------------------------------------------

/**
 * Return engine model configuration and download instructions.
 *
 * Equivalent to src/search/semantic-diagnostics.ts::pullSemanticModels()
 * re-implemented for the engine (no import from src/search).
 *
 * To perform the actual download, run the returned `pullCommand` in a shell.
 * After downloading, set OMS_MODEL_PATH to point to the GGUF file so that
 * createEmbeddingProvider() picks it up automatically.
 *
 * @example
 * ```ts
 * import { pullEngineModels } from "./src/engine/embed/pull.js";
 * const info = pullEngineModels({ modelPath: process.env.OMS_MODEL_PATH });
 * console.log(info.pullCommand);
 * ```
 */
export function pullEngineModels(
  opts: { modelPath?: string } = {},
): EnginePullResult {
  const modelPath = opts.modelPath ?? process.env["OMS_MODEL_PATH"];
  const upstageConfigured = Boolean(process.env["UPSTAGE_API_KEY"]);

  const pullCommand = [
    `# ── Step 1: Install Hugging Face CLI (one-time) ───────────────────────────`,
    `pip install huggingface_hub   # or: brew install huggingface-cli`,
    ``,
    `# ── Step 2: Download EmbeddingGemma-300M (768d, Q8_0) ────────────────────`,
    `# Repository : https://huggingface.co/${GGUF_HF_REPO}`,
    `# File       : ${GGUF_HF_FILE}  (~300 MB)`,
    `huggingface-cli download ${GGUF_HF_REPO} ${GGUF_HF_FILE} \\`,
    `  --local-dir ${GGUF_DEFAULT_DEST}`,
    ``,
    `# ── Step 3: Configure the engine ─────────────────────────────────────────`,
    `export OMS_MODEL_PATH="${GGUF_DEFAULT_DEST}/${GGUF_HF_FILE}"`,
    ``,
    `# ── Optional: Upstage Solar (4096d, API-based, commercial opt-in) ─────────`,
    `# Overrides GGUF when set; do NOT set alongside OMS_MODEL_PATH for GGUF.`,
    `export UPSTAGE_API_KEY="<your-key>"`,
    ``,
    `# ── Step 4: Run the golden-set parity harness ────────────────────────────`,
    `RUN_GOLDEN=1 OMS_MODEL_PATH="${GGUF_DEFAULT_DEST}/${GGUF_HF_FILE}" npx vitest run test/golden-set`,
  ].join("\n");

  const configured = upstageConfigured
    ? "Upstage Solar (UPSTAGE_API_KEY set)"
    : modelPath
      ? `GGUF at ${modelPath}`
      : null;

  return {
    available: true,
    models: {
      embedding: `node-llama-cpp:${GGUF_MODEL_NAME}`,
      dimensions: GGUF_EMBEDDING_DIMENSIONS,
      commercial: "upstage-solar-embedding-1-passage:4096d (UPSTAGE_API_KEY)",
    },
    modelPath,
    pullCommand,
    message: configured
      ? `Engine embedding configured: ${configured}. Real vectors are active.`
      : `No GGUF model or API key configured. Run the pullCommand to download ` +
        `${GGUF_MODEL_NAME}, then set OMS_MODEL_PATH for real 768d embeddings. ` +
        `Without a real model, syncEngineStore() will throw rather than silently ` +
        `producing fake embeddings.`,
  };
}
