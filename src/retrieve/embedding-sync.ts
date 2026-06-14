import { syncSemanticEmbeddingStore, type SemanticEmbeddingSyncResult } from "../search/semantic.js";
import type { MorningRetrieveOptions } from "./morning.js";

export async function syncRetrieveEmbeddings(
  opts: MorningRetrieveOptions,
): Promise<SemanticEmbeddingSyncResult | undefined> {
  if (opts.semantic?.syncBeforeSearch !== true) return undefined;
  return syncSemanticEmbeddingStore({
    vault: opts.vault,
    collection: opts.semantic.collection,
    ensureCollection: opts.semantic.syncEnsureCollection,
    update: opts.semantic.syncUpdate,
    embed: opts.semantic.syncEmbed,
    force: opts.semantic.syncForce,
    pull: opts.semantic.syncPull,
    index: opts.semantic.index,
    storage: opts.semantic.syncStorage ?? opts.semantic.storage,
    modelPath: opts.semantic.syncModelPath ?? opts.semantic.modelPath,
    chunkStrategy: opts.semantic.chunkStrategy,
    maxDocsPerBatch: opts.semantic.syncMaxDocsPerBatch,
    maxBatchMb: opts.semantic.syncMaxBatchMb,
  });
}
