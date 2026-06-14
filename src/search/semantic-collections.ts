import { semanticDocumentId, semanticDocumentUri, semanticIndexPath, readSemanticIndex, writeSemanticIndex } from "./semantic-index.js";
import {
  collectionsWithCounts,
  emptyIndex,
  now,
  writeIndex,
} from "./semantic-maintenance-shared.js";
import type {
  SemanticCollectionMutationResult,
  SemanticCollectionResult,
  SemanticInitResult,
  SemanticStorage,
} from "./semantic-types.js";

export async function initSemanticStore(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticInitResult> {
  const loaded = await readSemanticIndex(opts);
  const indexPath = semanticIndexPath(opts);
  if (loaded.available) {
    return { available: true, initialized: false, storage: loaded.index.storage, index: indexPath };
  }
  const index = emptyIndex(opts.vault, opts.storage);
  await writeSemanticIndex(index, opts);
  return { available: true, initialized: true, storage: index.storage, index: indexPath };
}

export async function listSemanticCollections(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticCollectionResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, collections: [] };
  return { available: true, collections: collectionsWithCounts(loaded.index) };
}

export async function removeSemanticCollection(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly collection: string;
}): Promise<SemanticCollectionMutationResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, collection: opts.collection };
  const before = loaded.index.collections ?? [];
  const collections = before.filter((collection) => collection.name !== opts.collection);
  const documents = loaded.index.documents.filter((document) => document.collection !== opts.collection);
  const contexts = (loaded.index.contexts ?? []).filter((context) => context.collection !== opts.collection);
  await writeIndex({ ...loaded.index, collections, contexts, documents }, opts);
  return { available: true, collection: opts.collection, removed: collections.length !== before.length };
}

export async function renameSemanticCollection(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly from: string;
  readonly to: string;
}): Promise<SemanticCollectionMutationResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, collection: opts.from };
  const collections = (loaded.index.collections ?? []).map((collection) =>
    collection.name === opts.from ? { ...collection, name: opts.to, lastModified: now() } : collection,
  );
  const renamed = collections.some((collection) => collection.name === opts.to);
  const documents = loaded.index.documents.map((document) => {
    if (document.collection !== opts.from) return document;
    return {
      ...document,
      collection: opts.to,
      docid: semanticDocumentId(opts.to, document.path),
      uri: semanticDocumentUri(opts.to, document.path),
    };
  });
  const contexts = (loaded.index.contexts ?? []).map((context) =>
    context.collection === opts.from ? { ...context, collection: opts.to, updatedAt: now() } : context,
  );
  await writeIndex({ ...loaded.index, collection: loaded.index.collection === opts.from ? opts.to : loaded.index.collection, collections, contexts, documents }, opts);
  return { available: true, collection: opts.to, renamed };
}

export async function updateSemanticCollection(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
  readonly collection: string;
  readonly updateCommand?: string;
  readonly includeByDefault?: boolean;
}): Promise<SemanticCollectionMutationResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, collection: opts.collection };
  const collections = (loaded.index.collections ?? []).map((collection) => {
    if (collection.name !== opts.collection) return collection;
    return {
      ...collection,
      updateCommand: opts.updateCommand ?? collection.updateCommand,
      includeByDefault: opts.includeByDefault ?? collection.includeByDefault,
      lastModified: now(),
    };
  });
  const updated = collections.some((collection) => collection.name === opts.collection);
  await writeIndex({ ...loaded.index, collections }, opts);
  return { available: true, collection: opts.collection, updated };
}
