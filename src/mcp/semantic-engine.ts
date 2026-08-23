/**
 * Engine assembly helpers for the OMS semantic surface.
 *
 * After the src/search teardown there is a single semantic backend: the native
 * engine. Embedding selection is canonical and explicit (ADR-007): the engine
 * never auto-detects a provider and never fabricates vectors.
 *
 *   - {@link assembleFullSemanticEngine} requires OMS_EMBEDDING_PROVIDER +
 *     OMS_EMBEDDING_MODEL and throws a loud, actionable error otherwise. The
 *     MCP server uses it for vec/HyDE-bearing semantic ops so a model-less host
 *     loud-guards instead of silently degrading.
 *   - {@link assembleSemanticEngine} returns the vec-capable engine when the
 *     canonical pair is configured, else a core (lex + document) engine where
 *     vec/HyDE fail fast. The CLI, the localhost HTTP transport, and the MCP
 *     server's model-OPTIONAL paths (explicit lex-only query, document reads,
 *     retrieve_context's semantic leg, ReadResource) use it so lex and
 *     file-based reads work without a model.
 */

import {
  assembleCoreSemanticEngine,
  assembleEngine,
  type AssembledEngine,
} from "../kernel/engine/assemble.js";

/** True when both canonical embedding-config env vars are set (ADR-007). */
export function embeddingConfigPresent(): boolean {
  return Boolean(process.env["OMS_EMBEDDING_PROVIDER"] && process.env["OMS_EMBEDDING_MODEL"]);
}

function embeddingConfig(vault: string): Parameters<typeof assembleEngine>[0] {
  return {
    vault,
    ...(process.env["OMS_EMBEDDING_PROVIDER"]
      ? { embeddingProvider: process.env["OMS_EMBEDDING_PROVIDER"] }
      : {}),
    ...(process.env["OMS_EMBEDDING_MODEL"]
      ? { embeddingModel: process.env["OMS_EMBEDDING_MODEL"] }
      : {}),
  };
}

/**
 * Vec-capable engine with a REAL embedding provider. Throws a loud ADR-007 error
 * when OMS_EMBEDDING_PROVIDER / OMS_EMBEDDING_MODEL are absent — no auto-detect,
 * no hash/fake fallback.
 */
export function assembleFullSemanticEngine(vault: string): AssembledEngine {
  return assembleEngine(embeddingConfig(vault));
}

/**
 * Vec-capable engine when embeddings are configured, else a core engine that
 * serves lexical search and file-based document reads while vec/HyDE fail fast.
 */
export function assembleSemanticEngine(vault: string): AssembledEngine {
  return embeddingConfigPresent()
    ? assembleEngine(embeddingConfig(vault))
    : assembleCoreSemanticEngine(embeddingConfig(vault));
}
