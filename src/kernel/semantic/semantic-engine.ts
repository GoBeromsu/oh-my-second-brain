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
} from "../engine/assemble.js";
import { resolveEmbeddingModel } from "../engine/embed/model.js";
import type { Reranker } from "../engine/retrieval/reranker.js";

/** True when both canonical embedding-config env vars are set (ADR-007). */
export function embeddingConfigPresent(): boolean {
  return resolveEmbeddingModel().available;
}

function embeddingConfig(vault: string): Parameters<typeof assembleEngine>[0] {
  const resolved = resolveEmbeddingModel();
  const descriptor = resolved.descriptor;
  return {
    vault,
    ...(resolved.available && resolved.provider !== undefined
      ? { embeddingProvider: resolved.provider }
      : {}),
    ...(resolved.available && resolved.model !== undefined
      ? { embeddingModel: resolved.modelPath ?? resolved.model }
      : {}),
    // Keep the setup descriptor intact as it crosses the semantic assembly
    // seam.  Flattening only provider/model loses width, context, MRL, and
    // normalization metadata needed by the provider, store, and MCP sync.
    ...(descriptor !== undefined
      ? {
        embeddingDescriptor: descriptor,
        ...(descriptor.dimensions !== undefined ? { embeddingDimensions: descriptor.dimensions } : {}),
        ...(descriptor.context !== undefined ? { embeddingContext: descriptor.context } : {}),
        ...(descriptor.contextLength !== undefined
          ? { embeddingContextLength: descriptor.contextLength }
          : {}),
        ...(descriptor.contextTokens !== undefined
          ? { embeddingContextTokens: descriptor.contextTokens }
          : {}),
        ...(descriptor.mrlDim !== undefined ? { embeddingMrlDim: descriptor.mrlDim } : {}),
        ...(descriptor.normalization !== undefined
          ? { embeddingNormalization: descriptor.normalization }
          : {}),
        ...(descriptor.prefixScheme !== undefined
          ? { embeddingPrefixScheme: descriptor.prefixScheme }
          : {}),
      }
      : {}),
  };
}

/**
 * Vec-capable engine with a REAL embedding provider. Throws a loud ADR-007 error
 * when OMS_EMBEDDING_PROVIDER / OMS_EMBEDDING_MODEL are absent — no auto-detect,
 * no hash/fake fallback.
 */
export function assembleFullSemanticEngine(vault: string, reranker?: Reranker): AssembledEngine {
  return assembleEngine({ ...embeddingConfig(vault), reranker });
}

/**
 * Vec-capable engine when embeddings are configured, else a core engine that
 * serves lexical search and file-based document reads while vec/HyDE fail fast.
 */
export function assembleSemanticEngine(vault: string, reranker?: Reranker): AssembledEngine {
  return embeddingConfigPresent()
    ? assembleEngine({ ...embeddingConfig(vault), reranker })
    : assembleCoreSemanticEngine({ ...embeddingConfig(vault), reranker });
}
