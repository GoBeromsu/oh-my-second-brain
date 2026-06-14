import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { termFrequency, uniqueSortedTerms } from "./semantic-token.js";
import {
  DEFAULT_SEMANTIC_PATTERN,
  matchesSemanticPattern,
  normalizeCollection,
  JSON_QMD_COMPATIBILITY,
  QMD_COMPATIBILITY,
  safeSemanticCollectionPath,
  semanticDocumentId,
  semanticDocumentUri,
  SEMANTIC_INDEX_VERSION,
  SEMANTIC_JSON_STORAGE,
} from "./semantic-index-core.js";
import type { SemanticCollectionSummary, SemanticIndexedDocument, SemanticIndexFile, SemanticStorage } from "./semantic-types.js";

async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".oms" || entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(fullPath, base);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield path.relative(base, fullPath).replace(/\\/g, "/");
    }
  }
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#{1,6}\s+(.+)$/u.exec(line.trim());
    const heading = match?.[1]?.trim();
    if (heading) return heading;
  }
  return undefined;
}

function titleFromNote(notePath: string, raw: string): string {
  const parsed = parseNote(raw);
  const title = parsed.frontmatter["title"];
  if (typeof title === "string" && title.trim()) return title.trim();
  return firstHeading(parsed.body) ?? path.basename(notePath, ".md");
}

async function indexedDocument(vault: string, collection: string, notePath: string): Promise<SemanticIndexedDocument> {
  const fullPath = path.join(vault, notePath);
  const [content, fileStat] = await Promise.all([readFile(fullPath, "utf-8"), stat(fullPath)]);
  return {
    collection,
    path: notePath,
    uri: semanticDocumentUri(collection, notePath),
    docid: semanticDocumentId(collection, notePath),
    title: titleFromNote(notePath, content),
    content,
    terms: uniqueSortedTerms(content),
    termFrequency: termFrequency(content),
    lineCount: content.split(/\r?\n/u).length,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

export async function buildSemanticIndex(opts: {
  readonly vault: string;
  readonly collection?: string;
  readonly collectionPath?: string;
  readonly pattern?: string;
  readonly ignore?: readonly string[];
  readonly includeByDefault?: boolean;
  readonly updateCommand?: string;
  readonly context?: string;
  readonly chunkStrategy?: string;
  readonly storage?: SemanticStorage;
}): Promise<SemanticIndexFile> {
  const vault = path.resolve(opts.vault);
  const collection = normalizeCollection(opts.collection);
  const collectionPath = safeSemanticCollectionPath(vault, opts.collectionPath);
  const scanRoot = path.resolve(vault, collectionPath);
  const pattern = opts.pattern?.trim() || DEFAULT_SEMANTIC_PATTERN;
  const ignore = opts.ignore ?? [];
  const documents: SemanticIndexedDocument[] = [];
  for await (const notePath of walkMarkdown(scanRoot, vault)) {
    if (matchesSemanticPattern(notePath, collectionPath, pattern, ignore)) {
      documents.push(await indexedDocument(vault, collection, notePath));
    }
  }
  documents.sort((a, b) => a.path.localeCompare(b.path));
  const generatedAt = new Date().toISOString();
  const summary: SemanticCollectionSummary = {
    name: collection,
    path: collectionPath,
    pattern,
    ignore,
    includeByDefault: opts.includeByDefault ?? true,
    updateCommand: opts.updateCommand,
    context: opts.context,
    documents: documents.length,
    activeDocuments: documents.length,
    lastModified: generatedAt,
  };
  return {
    version: SEMANTIC_INDEX_VERSION,
    storage: opts.storage ?? SEMANTIC_JSON_STORAGE,
    generatedAt,
    vault,
    collection,
    chunkStrategy: opts.chunkStrategy,
    collections: [summary],
    contexts: [],
    qmdCompatibility: opts.storage === SEMANTIC_JSON_STORAGE ? JSON_QMD_COMPATIBILITY : QMD_COMPATIBILITY,
    documents,
  };
}
