import type { McpEngineAdapter } from "../kernel/engine/mcp/facade.js";
import {
  assembleCoreSemanticEngineReadOnly,
  assembleLiveLexicalEngine,
  assembleEngineReadOnly,
  assembleEphemeralCoreSemanticEngine,
  type AssembledEngine,
} from "../kernel/engine/assemble.js";
import {
  assembleFullSemanticEngine,
  assembleSemanticEngine,
  embeddingConfigPresent,
} from "../kernel/semantic/semantic-engine.js";
import { readVaultEmbeddingModelSync } from "../kernel/engine/embed/config.js";
import { readInstalledModelsReceiptSync } from "../kernel/engine/embed/model.js";

import type { LiveLexicalSession } from "../kernel/engine/embed/live-lexical.js";

export interface EngineSessionOptions {
  readonly write: boolean;
  /** A pure lexical search; pass a server-owned session to retain its detached core. */
  readonly liveLexical?: true | LiveLexicalSession;
  readonly embed?: boolean;
  readonly modelCacheDir?: string;
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
}

export interface EngineSession {
  readonly adapter: McpEngineAdapter;
  dispose(): Promise<void>;
}

/** Fails loudly under ADR-005 before an operation that requires real embeddings. */
export function ensureEmbeddingCapability(
  vault: string,
  modelCacheDir?: string,
  modelEnv?: Readonly<Record<string, string | undefined>>,
): void {
  if (!embeddingConfigPresent(vault, modelCacheDir, modelEnv)) {
    throw new Error(
      `Embedding capability is unavailable for ${vault}. Configure OMS_EMBEDDING_PROVIDER and OMS_EMBEDDING_MODEL, set embedding.model in .oms/settings.json, or run oms setup model install --default and oms setup model select --default.`,
    );
  }
}

export function createEngineSession(vault: string, options: EngineSessionOptions): EngineSession {
  if (options.embed === true) {
    ensureEmbeddingCapability(vault, options.modelCacheDir, options.modelEnv);
    const engine = assembleFullSemanticEngine(vault, undefined, options.modelCacheDir, options.modelEnv);
    return { adapter: engine.adapter, dispose: () => engine.dispose() };
  }

  if (options.write) {
    const engine = assembleSemanticEngine(vault, undefined, options.modelCacheDir, options.modelEnv);
    return { adapter: engine.adapter, dispose: () => engine.dispose() };
  }

  const modelInputs = {
    vault,
    vaultEmbeddingModel: readVaultEmbeddingModelSync(vault),
    installedModelsReceipt: readInstalledModelsReceiptSync(
      options.modelCacheDir === undefined ? {} : { cacheDir: options.modelCacheDir },
    ),
    ...(options.modelCacheDir === undefined ? {} : { embeddingCacheDir: options.modelCacheDir }),
    ...(options.modelEnv === undefined ? {} : { modelEnv: options.modelEnv }),
  };
  if (options.liveLexical !== undefined) {
    const engine = assembleLiveLexicalEngine(modelInputs, options.liveLexical === true ? undefined : options.liveLexical);
    return { adapter: engine.adapter, dispose: () => engine.dispose() };
  }
  const readOnly: AssembledEngine | null = embeddingConfigPresent(vault, options.modelCacheDir, options.modelEnv)
    ? assembleEngineReadOnly({
      ...modelInputs,
    })
    : assembleCoreSemanticEngineReadOnly(modelInputs);
  const engine = readOnly ?? assembleEphemeralCoreSemanticEngine(modelInputs);
  return { adapter: engine.adapter, dispose: () => engine.dispose() };
}

export async function runEngineSession<T>(
  vault: string,
  options: EngineSessionOptions,
  fn: (adapter: McpEngineAdapter) => Promise<T>,
): Promise<T> {
  const session = createEngineSession(vault, options);
  try {
    return await fn(session.adapter);
  } finally {
    await session.dispose();
  }
}
