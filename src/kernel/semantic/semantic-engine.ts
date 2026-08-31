/**
 * Engine assembly helpers for the OMS semantic surface.
 *
 * After the src/search teardown there is a single semantic backend: the native
 * engine. Embedding selection is canonical and explicit (ADR-007): the engine
 * never auto-detects a provider and never fabricates vectors.
 *
 *   - {@link assembleFullSemanticEngine} requires a resolved installed
 *     descriptor and throws a loud, actionable error otherwise. The MCP server
 *     uses it for vec/HyDE-bearing semantic ops so a model-less host loud-guards
 *     instead of silently degrading.
 *   - {@link assembleSemanticEngine} returns the vec-capable engine when an
 *     installed descriptor resolves, else a core (lex + document) engine where
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

/** True when strict model resolution supplies an installed embedding descriptor. */
export function embeddingConfigPresent(modelCacheDir?: string): boolean {
  return resolveEmbeddingModel(
    modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir },
  ).descriptor !== undefined;
}

function embeddingConfig(vault: string, modelCacheDir?: string): Parameters<typeof assembleEngine>[0] {
  const { descriptor } = resolveEmbeddingModel(
    modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir },
  );
  if (descriptor === undefined) {
    return {
      vault,
      ...(modelCacheDir === undefined ? {} : { embeddingCacheDir: modelCacheDir }),
    };
  }
  if (descriptor.path === undefined) {
    throw new Error("Resolved embedding descriptor is missing its installed model path.");
  }
  // Pass ONLY the descriptor. It already carries provider, portable model id,
  // absolute artifact path, and every shape field, so assembly derives all of them
  // from one source.
  //
  // The redundant scalars this used to send were not merely noise, they were a bug:
  // `embeddingModel` was set to `descriptor.path` while assembly compares that slot
  // against `descriptor.model`, the portable identity. A filesystem path can never
  // equal a model id, so any vault with an installed model failed assembly with
  // "Embedding descriptor does not match the configured model". It survived because
  // the branch only runs when a receipt exists, and no test had one.
  return {
    vault,
    embeddingDescriptor: descriptor,
    ...(modelCacheDir === undefined ? {} : { embeddingCacheDir: modelCacheDir }),
  };
}

/**
 * Vec-capable engine with a REAL embedding provider. Throws a loud ADR-007 error
 * when no installed descriptor resolves — no auto-detect, no hash/fake fallback.
 */
export function assembleFullSemanticEngine(
  vault: string,
  reranker?: Reranker,
  modelCacheDir?: string,
): AssembledEngine {
  return assembleEngine({ ...embeddingConfig(vault, modelCacheDir), reranker });
}

/**
 * Vec-capable engine when embeddings are configured, else a core engine that
 * serves lexical search and file-based document reads while vec/HyDE fail fast.
 */
export function assembleSemanticEngine(
  vault: string,
  reranker?: Reranker,
  modelCacheDir?: string,
): AssembledEngine {
  return embeddingConfigPresent(modelCacheDir)
    ? assembleEngine({ ...embeddingConfig(vault, modelCacheDir), reranker })
    : assembleCoreSemanticEngine({ ...embeddingConfig(vault, modelCacheDir), reranker });
}
