import {
  buildSemanticIndex,
  JSON_QMD_COMPATIBILITY,
  normalizeSemanticStorage,
  QMD_COMPATIBILITY,
  readSemanticIndex,
  SEMANTIC_JSON_STORAGE,
  SEMANTIC_SQLITE_STORAGE,
  SQLITE_QMD_COMPATIBILITY,
  writeSemanticIndex,
} from "./semantic-index.js";
import type {
  SemanticEmbeddingSyncOptions,
  SemanticEmbeddingSyncResult,
  SemanticIndexFile,
  SemanticIndexStatus,
  SemanticProviderStatus,
  SemanticStorage,
  SemanticSyncStep,
} from "./semantic-types.js";

const JSON_MODELS = {
  embedding: "oms-token-frequency-v1",
  reranking: "oms-rrf-v1",
  generation: "oms-query-document-v1",
};

const SQLITE_MODELS = {
  embedding: "oms-sqlite-vec-hash-v1",
  reranking: "oms-sqlite-rrf-v1",
  generation: "oms-query-document-v1",
};

export const SEMANTIC_MODELS = SQLITE_MODELS;

function indexStatus(pathValue: string, size: string, documents: number, updated: string): SemanticIndexStatus {
  return {
    path: pathValue,
    size,
    documents: {
      total: documents,
      vectors: documents,
      pending: 0,
      updated,
    },
  };
}

export async function readSemanticStatus(opts: {
  readonly vault?: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly modelPath?: string;
} = {}): Promise<SemanticProviderStatus> {
  const storage = normalizeSemanticStorage(opts.storage);
  const loaded = await readSemanticIndex({ ...opts, storage });
  if (!loaded.available) return { available: false, reason: loaded.reason };
  const sqliteModels = opts.modelPath
    ? { ...SQLITE_MODELS, embedding: `node-llama-cpp:${opts.modelPath}` }
    : SQLITE_MODELS;
  return {
    available: true,
    storage: loaded.index.storage,
    models: loaded.index.storage === SEMANTIC_SQLITE_STORAGE ? sqliteModels : JSON_MODELS,
    collections: loaded.index.collections,
    qmdCompatibility: loaded.index.qmdCompatibility ?? (storage === SEMANTIC_JSON_STORAGE ? JSON_QMD_COMPATIBILITY : SQLITE_QMD_COMPATIBILITY),
    index: indexStatus(loaded.path, loaded.size, loaded.index.documents.length, loaded.index.generatedAt),
  };
}

function step(name: SemanticSyncStep["name"], message: string, documents: number): SemanticSyncStep {
  return { name, status: 0, message, documents };
}

function mergeCollection(existing: SemanticIndexFile | undefined, next: SemanticIndexFile): SemanticIndexFile {
  if (!existing) return next;
  const collection = next.collection;
  const documents = [
    ...existing.documents.filter((document) => document.collection !== collection),
    ...next.documents,
  ].sort((a, b) => a.collection.localeCompare(b.collection) || a.path.localeCompare(b.path));
  const nextSummary = next.collections?.find((entry) => entry.name === collection);
  const collections = [
    ...(existing.collections ?? []).filter((entry) => entry.name !== collection),
    ...(nextSummary ? [nextSummary] : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...next,
    generatedAt: new Date().toISOString(),
    documents,
    collections,
    contexts: existing.contexts ?? [],
    globalContext: existing.globalContext,
    qmdCompatibility: next.storage === SEMANTIC_JSON_STORAGE ? JSON_QMD_COMPATIBILITY : QMD_COMPATIBILITY,
  };
}

export async function syncSemanticEmbeddingStore(
  opts: SemanticEmbeddingSyncOptions,
): Promise<SemanticEmbeddingSyncResult> {
  const steps: SemanticSyncStep[] = [];
  const storage = normalizeSemanticStorage(opts.storage);
  try {
    if (opts.pull === true) {
      steps.push({ name: "pull", status: 0, message: "OMS semantic runtime dependencies are installed; GGUF model files are configured by path." });
    }
    const existing = await readSemanticIndex({ vault: opts.vault, index: opts.index, storage });
    const index = await buildSemanticIndex({
      vault: opts.vault,
      collection: opts.collection,
      collectionPath: opts.collectionPath,
      pattern: opts.pattern,
      ignore: opts.ignore,
      includeByDefault: opts.includeByDefault,
      updateCommand: opts.updateCommand,
      context: opts.context,
      chunkStrategy: opts.chunkStrategy,
      storage,
    });
    const merged = mergeCollection(existing.available ? existing.index : undefined, index);
    steps.push(step("scan", `Scanned ${index.documents.length} markdown documents.`, index.documents.length));
    const indexPath = await writeSemanticIndex(merged, {
      vault: opts.vault,
      index: opts.index,
      storage,
      embed: opts.embed,
      modelPath: opts.modelPath,
    });
    steps.push(step("write-index", `Wrote OMS semantic index to ${indexPath}.`, merged.documents.length));
    const status = await readSemanticStatus({ vault: opts.vault, index: opts.index, storage, modelPath: opts.modelPath });
    if (!status.available) {
      return {
        available: false,
        reason: status.reason,
        storage,
        collection: merged.collection,
        index: indexPath,
        steps,
      };
    }
    steps.push(step("status", "OMS semantic index is available.", merged.documents.length));
    return {
      available: true,
      storage,
      collection: merged.collection,
      index: indexPath,
      status,
      steps,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: detail,
      storage,
      collection: opts.collection,
      index: opts.index,
      steps,
    };
  }
}
