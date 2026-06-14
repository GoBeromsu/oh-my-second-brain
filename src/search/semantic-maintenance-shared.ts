import path from "node:path";
import {
  JSON_QMD_COMPATIBILITY,
  normalizeSemanticStorage,
  QMD_COMPATIBILITY,
  readSemanticIndex,
  SEMANTIC_JSON_STORAGE,
  writeSemanticIndex,
} from "./semantic-index.js";
import type { SemanticCollectionSummary, SemanticIndexFile, SemanticStorage } from "./semantic-types.js";

export function now(): string {
  return new Date().toISOString();
}

export function normalizePathPrefix(value: string | undefined): string {
  const normalized = (value?.trim() || ".").replace(/\\/g, "/").replace(/^\.?\//u, "");
  return normalized.length > 0 ? normalized : ".";
}

export function emptyIndex(vault: string, storage?: SemanticStorage): SemanticIndexFile {
  const normalizedStorage = normalizeSemanticStorage(storage);
  return {
    version: 1,
    storage: normalizedStorage,
    generatedAt: now(),
    vault: path.resolve(vault),
    collection: "vault",
    collections: [],
    contexts: [],
    qmdCompatibility: normalizedStorage === SEMANTIC_JSON_STORAGE ? JSON_QMD_COMPATIBILITY : QMD_COMPATIBILITY,
    documents: [],
  };
}

export async function loadIndexOrEmpty(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticIndexFile> {
  const loaded = await readSemanticIndex(opts);
  return loaded.available ? loaded.index : emptyIndex(opts.vault, opts.storage);
}

export async function writeIndex(index: SemanticIndexFile, opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<void> {
  await writeSemanticIndex(
    { ...index, generatedAt: now(), qmdCompatibility: index.qmdCompatibility ?? QMD_COMPATIBILITY },
    { ...opts, storage: index.storage },
  );
}

function collectionCounts(index: SemanticIndexFile, collection: SemanticCollectionSummary): SemanticCollectionSummary {
  const documents = index.documents.filter((document) => document.collection === collection.name).length;
  return {
    ...collection,
    documents,
    activeDocuments: documents,
    lastModified: collection.lastModified ?? index.generatedAt,
  };
}

export function collectionsWithCounts(index: SemanticIndexFile): readonly SemanticCollectionSummary[] {
  return (index.collections ?? []).map((collection) => collectionCounts(index, collection));
}
