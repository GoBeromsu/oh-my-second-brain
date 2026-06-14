import { stat } from "node:fs/promises";
import { DEFAULT_SEMANTIC_PATTERN, SEMANTIC_INDEX_VERSION, SQLITE_QMD_COMPATIBILITY } from "./semantic-index-core.js";
import { openSemanticSqliteStore, semanticSqlitePath } from "./semantic-sqlite-db.js";
import type {
  SemanticCollectionSummary,
  SemanticIndexFile,
  SemanticIndexedDocument,
  SemanticStoredContext,
} from "./semantic-types.js";
import type { SemanticIndexLoadResult } from "./semantic-index-io.js";

interface DocumentRow {
  readonly collection: string;
  readonly path: string;
  readonly uri: string;
  readonly docid: string;
  readonly title: string | null;
  readonly content: string;
  readonly terms_json: string;
  readonly term_frequency_json: string;
  readonly line_count: number;
  readonly mtime_ms: number;
  readonly size: number;
}

interface CollectionRow {
  readonly name: string;
  readonly path: string;
  readonly pattern: string;
  readonly ignore_patterns: string;
  readonly include_by_default: number;
  readonly update_command: string | null;
  readonly context: string | null;
  readonly doc_count: number;
  readonly active_count: number;
  readonly last_modified: string | null;
}

interface ContextRow {
  readonly collection: string | null;
  readonly path_prefix: string;
  readonly context: string;
  readonly updated_at: string;
}

interface MetaRow {
  readonly value: string;
}

function stringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}

function frequencyRecord(value: string): Readonly<Record<string, number>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "number") output[key] = entry;
  }
  return output;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function rowDocument(row: DocumentRow): SemanticIndexedDocument {
  return {
    collection: row.collection,
    path: row.path,
    uri: row.uri,
    docid: row.docid,
    title: row.title ?? undefined,
    content: row.content,
    terms: stringArray(row.terms_json),
    termFrequency: frequencyRecord(row.term_frequency_json),
    lineCount: row.line_count,
    mtimeMs: row.mtime_ms,
    size: row.size,
  };
}

function rowCollection(row: CollectionRow): SemanticCollectionSummary {
  return {
    name: row.name,
    path: row.path,
    pattern: row.pattern || DEFAULT_SEMANTIC_PATTERN,
    ignore: stringArray(row.ignore_patterns),
    includeByDefault: row.include_by_default !== 0,
    updateCommand: row.update_command ?? undefined,
    context: row.context ?? undefined,
    documents: row.doc_count,
    activeDocuments: row.active_count,
    lastModified: row.last_modified ?? undefined,
  };
}

function rowContext(row: ContextRow): SemanticStoredContext {
  return {
    collection: row.collection || undefined,
    pathPrefix: row.path_prefix,
    context: row.context,
    updatedAt: row.updated_at,
  };
}

export async function readSqliteSemanticIndex(opts: {
  readonly vault?: string;
  readonly index?: string;
}): Promise<SemanticIndexLoadResult> {
  const databasePath = semanticSqlitePath(opts);
  let store;
  try {
    store = await openSemanticSqliteStore({ ...opts, readonly: true, fileMustExist: true });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `OMS SQLite semantic store not found; run oms semantic sync first. ${detail}`, path: databasePath };
  }
  try {
    const documents = store.db.prepare<[], DocumentRow>("SELECT * FROM documents WHERE active = 1 ORDER BY collection, path").all().map(rowDocument);
    const collections = store.db.prepare<[], CollectionRow>("SELECT * FROM store_collections ORDER BY name").all().map(rowCollection);
    const contexts = store.db.prepare<[], ContextRow>("SELECT * FROM store_contexts ORDER BY collection, path_prefix").all().map(rowContext);
    const generatedAt = store.db.prepare<[], MetaRow>("SELECT value FROM store_meta WHERE key = 'generated_at'").get()?.value ?? new Date(0).toISOString();
    const vault = store.db.prepare<[], MetaRow>("SELECT value FROM store_meta WHERE key = 'vault'").get()?.value ?? opts.vault ?? process.cwd();
    const collection = store.db.prepare<[], MetaRow>("SELECT value FROM store_meta WHERE key = 'collection'").get()?.value ?? "vault";
    const globalContext = store.db.prepare<[], MetaRow>("SELECT value FROM store_meta WHERE key = 'global_context'").get()?.value;
    const fileStat = await stat(databasePath);
    const index: SemanticIndexFile = {
      version: SEMANTIC_INDEX_VERSION,
      storage: "qmd-sqlite",
      generatedAt,
      vault,
      collection,
      collections,
      contexts,
      globalContext,
      qmdCompatibility: SQLITE_QMD_COMPATIBILITY,
      documents,
    };
    return { available: true, index, path: databasePath, size: humanSize(fileStat.size) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `Unable to read OMS SQLite semantic store: ${detail}`, path: databasePath };
  } finally {
    store.db.close();
  }
}
