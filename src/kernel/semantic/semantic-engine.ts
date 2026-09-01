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
import { readModelsConfigSync } from "../engine/embed/config.js";
import {
  readInstalledModelsReceiptSync,
  resolveEmbeddingModel,
} from "../engine/embed/model.js";
import type { Reranker } from "../engine/retrieval/reranker.js";

/** True when strict model resolution supplies an installed embedding descriptor. */
export function embeddingConfigPresent(
  vault: string,
  modelCacheDir?: string,
  modelEnv?: Readonly<Record<string, string | undefined>>,
): boolean {
  return resolvedEmbedding(vault, modelCacheDir, modelEnv).descriptor !== undefined;
}

function resolvedEmbedding(
  vault: string,
  modelCacheDir?: string,
  modelEnv?: Readonly<Record<string, string | undefined>>,
) {
  const vaultConfig = readModelsConfigSync(vault);
  const installedReceipt = readInstalledModelsReceiptSync(
    modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir },
  );
  return resolveEmbeddingModel({
    ...(modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir }),
    ...(modelEnv === undefined ? {} : { env: modelEnv }),
    vaultConfig,
    installedReceipt,
  });
}

function embeddingConfig(
  vault: string,
  modelCacheDir?: string,
  modelEnv?: Readonly<Record<string, string | undefined>>,
): Parameters<typeof assembleEngine>[0] {
  const modelsConfig = readModelsConfigSync(vault);
  const installedModelsReceipt = readInstalledModelsReceiptSync(
    modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir },
  );
  return {
    vault,
    modelsConfig,
    installedModelsReceipt,
    ...(modelCacheDir === undefined ? {} : { embeddingCacheDir: modelCacheDir }),
    ...(modelEnv === undefined ? {} : { modelEnv }),
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
  modelEnv?: Readonly<Record<string, string | undefined>>,
): AssembledEngine {
  return assembleEngine({ ...embeddingConfig(vault, modelCacheDir, modelEnv), reranker });
}

/**
 * Vec-capable engine when embeddings are configured, else a core engine that
 * serves lexical search and file-based document reads while vec/HyDE fail fast.
 */
export function assembleSemanticEngine(
  vault: string,
  reranker?: Reranker,
  modelCacheDir?: string,
  modelEnv?: Readonly<Record<string, string | undefined>>,
): AssembledEngine {
  return embeddingConfigPresent(vault, modelCacheDir, modelEnv)
    ? assembleEngine({ ...embeddingConfig(vault, modelCacheDir, modelEnv), reranker })
    : assembleCoreSemanticEngine({ ...embeddingConfig(vault, modelCacheDir, modelEnv), reranker });
}
