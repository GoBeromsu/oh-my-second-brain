import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SEMANTIC_PATTERN,
  JSON_QMD_COMPATIBILITY,
  semanticIndexPath,
  SEMANTIC_INDEX_VERSION,
  SEMANTIC_JSON_STORAGE,
} from "./semantic-index-core.js";
import type {
  SemanticCollectionSummary,
  SemanticIndexedDocument,
  SemanticIndexFile,
  SemanticStoredContext,
} from "./semantic-types.js";

export type SemanticIndexLoadResult =
  | { readonly available: true; readonly index: SemanticIndexFile; readonly path: string; readonly size: string }
  | { readonly available: false; readonly reason: string; readonly path: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    output.push(item);
  }
  return output;
}

function parseCollectionSummary(value: unknown): SemanticCollectionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringField(value, "name");
  const collectionPath = stringField(value, "path");
  const pattern = stringField(value, "pattern");
  const ignore = stringArray(value["ignore"]);
  const documents = numberField(value, "documents");
  const activeDocuments = numberField(value, "activeDocuments");
  const includeByDefault = value["includeByDefault"];
  if (!name || !collectionPath || !pattern || !ignore || documents === undefined || activeDocuments === undefined) {
    return undefined;
  }
  return {
    name,
    path: collectionPath,
    pattern,
    ignore,
    includeByDefault: typeof includeByDefault === "boolean" ? includeByDefault : true,
    updateCommand: stringField(value, "updateCommand"),
    context: stringField(value, "context"),
    documents,
    activeDocuments,
    lastModified: stringField(value, "lastModified"),
  };
}

function parseStoredContext(value: unknown): SemanticStoredContext | undefined {
  if (!isRecord(value)) return undefined;
  const pathPrefix = stringField(value, "pathPrefix");
  const context = stringField(value, "context");
  const updatedAt = stringField(value, "updatedAt");
  if (!pathPrefix || !context || !updatedAt) return undefined;
  return { collection: stringField(value, "collection"), pathPrefix, context, updatedAt };
}

function frequencyRecord(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number") return undefined;
    output[key] = entry;
  }
  return output;
}

function parseIndexedDocument(value: unknown): SemanticIndexedDocument | undefined {
  if (!isRecord(value)) return undefined;
  const collection = stringField(value, "collection");
  const notePath = stringField(value, "path");
  const documentUri = stringField(value, "uri");
  const documentId = stringField(value, "docid");
  const content = stringField(value, "content");
  const terms = stringArray(value["terms"]);
  const termFrequencyValue = frequencyRecord(value["termFrequency"]);
  const lineCount = numberField(value, "lineCount");
  const mtimeMs = numberField(value, "mtimeMs");
  const size = numberField(value, "size");
  if (!collection || !notePath || !documentUri || !documentId || content === undefined) return undefined;
  if (!terms || !termFrequencyValue || lineCount === undefined || mtimeMs === undefined || size === undefined) {
    return undefined;
  }
  return {
    collection,
    path: notePath,
    uri: documentUri,
    docid: documentId,
    title: stringField(value, "title"),
    content,
    terms,
    termFrequency: termFrequencyValue,
    lineCount,
    mtimeMs,
    size,
  };
}

function parseSemanticIndex(value: unknown): SemanticIndexFile | undefined {
  if (!isRecord(value)) return undefined;
  if (value["version"] !== SEMANTIC_INDEX_VERSION || value["storage"] !== SEMANTIC_JSON_STORAGE) return undefined;
  const generatedAt = stringField(value, "generatedAt");
  const vault = stringField(value, "vault");
  const collection = stringField(value, "collection");
  const rawDocuments = value["documents"];
  if (!generatedAt || !vault || !collection || !Array.isArray(rawDocuments)) return undefined;
  const documents = rawDocuments.flatMap((entry) => {
    const document = parseIndexedDocument(entry);
    return document ? [document] : [];
  });
  if (documents.length !== rawDocuments.length) return undefined;
  const collections = parseCollections(value, collection, documents.length, generatedAt);
  const contexts = parseContexts(value["contexts"]);
  if (!collections || !contexts) return undefined;
  return {
    version: SEMANTIC_INDEX_VERSION,
    storage: SEMANTIC_JSON_STORAGE,
    generatedAt,
    vault,
    collection,
    chunkStrategy: stringField(value, "chunkStrategy"),
    collections,
    contexts,
    globalContext: stringField(value, "globalContext"),
    qmdCompatibility: JSON_QMD_COMPATIBILITY,
    documents,
  };
}

function parseCollections(
  record: Readonly<Record<string, unknown>>,
  collection: string,
  documentCount: number,
  generatedAt: string,
): readonly SemanticCollectionSummary[] | undefined {
  const rawCollections = record["collections"];
  if (!Array.isArray(rawCollections)) {
    return [{
      name: collection,
      path: ".",
      pattern: DEFAULT_SEMANTIC_PATTERN,
      ignore: [],
      includeByDefault: true,
      documents: documentCount,
      activeDocuments: documentCount,
      lastModified: generatedAt,
    }];
  }
  const collections = rawCollections.flatMap((entry) => {
    const collectionSummary = parseCollectionSummary(entry);
    return collectionSummary ? [collectionSummary] : [];
  });
  return collections.length === rawCollections.length ? collections : undefined;
}

function parseContexts(value: unknown): readonly SemanticStoredContext[] | undefined {
  if (!Array.isArray(value)) return [];
  const contexts = value.flatMap((entry) => {
    const storedContext = parseStoredContext(entry);
    return storedContext ? [storedContext] : [];
  });
  return contexts.length === value.length ? contexts : undefined;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function readSemanticIndex(opts: { readonly vault?: string; readonly index?: string }): Promise<SemanticIndexLoadResult> {
  let indexPath: string;
  try {
    indexPath = semanticIndexPath({ ...opts, storage: SEMANTIC_JSON_STORAGE });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: detail, path: opts.index ?? "" };
  }
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return { available: false, reason: "OMS semantic index not found; run oms semantic sync first.", path: indexPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `Unable to parse OMS semantic index: ${detail}`, path: indexPath };
  }

  const index = parseSemanticIndex(parsed);
  if (!index) return { available: false, reason: "OMS semantic index has an unsupported shape.", path: indexPath };
  const fileStat = await stat(indexPath);
  return { available: true, index, path: indexPath, size: humanSize(fileStat.size) };
}

export async function writeSemanticIndex(
  index: SemanticIndexFile,
  opts: { readonly vault?: string; readonly index?: string },
): Promise<string> {
  const indexPath = semanticIndexPath({ vault: opts.vault ?? index.vault, index: opts.index, storage: SEMANTIC_JSON_STORAGE });
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  return indexPath;
}
