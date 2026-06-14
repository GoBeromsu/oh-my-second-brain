import { stat } from "node:fs/promises";
import path from "node:path";
import { readSemanticIndex } from "./semantic-index.js";
import { collectionsWithCounts, normalizePathPrefix, writeIndex } from "./semantic-maintenance-shared.js";
import type {
  SemanticCleanupResult,
  SemanticDocumentListing,
  SemanticDocumentListingResult,
  SemanticIndexedDocument,
  SemanticStorage,
} from "./semantic-types.js";

function documentMatchesTarget(document: SemanticDocumentListing, target: string | undefined): boolean {
  if (!target) return true;
  const normalized = normalizePathPrefix(target);
  if (document.collection === normalized) return true;
  if (normalized.startsWith(`${document.collection}/`)) {
    return document.path.startsWith(normalized.slice(document.collection.length + 1));
  }
  return document.path.startsWith(normalized) || document.path === normalized || document.docid === normalized;
}

export async function listSemanticDocuments(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly target?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticDocumentListingResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, documents: [] };
  const documents = loaded.index.documents
    .map((document): SemanticDocumentListing => ({
      collection: document.collection,
      path: document.path,
      docid: document.docid,
      title: document.title,
      uri: document.uri,
      lineCount: document.lineCount,
      size: document.size,
    }))
    .filter((document) => documentMatchesTarget(document, opts.target))
    .sort((a, b) => a.collection.localeCompare(b.collection) || a.path.localeCompare(b.path));
  return { available: true, documents };
}

export async function cleanupSemanticStore(opts: {
  readonly vault: string;
  readonly index?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticCleanupResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, storage: opts.storage ?? "qmd-sqlite", reason: loaded.reason };
  const kept: SemanticIndexedDocument[] = [];
  for (const document of loaded.index.documents) {
    try {
      await stat(path.join(loaded.index.vault, document.path));
      kept.push(document);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
    }
  }
  const removedDocuments = loaded.index.documents.length - kept.length;
  const nextIndex = {
    ...loaded.index,
    documents: kept,
    collections: collectionsWithCounts({ ...loaded.index, documents: kept }),
  };
  await writeIndex(nextIndex, opts);
  return {
    available: true,
    storage: loaded.index.storage,
    removedDocuments,
    remainingDocuments: kept.length,
    collections: nextIndex.collections?.length ?? 0,
  };
}
