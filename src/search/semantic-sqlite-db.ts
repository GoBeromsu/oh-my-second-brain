import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  semanticIndexPath,
  SEMANTIC_SQLITE_STORAGE,
} from "./semantic-index-core.js";
import { SQLITE_VECTOR_DIMENSIONS } from "./semantic-embedding-hash.js";

export type SemanticSqliteDb = ReturnType<typeof Database>;

export interface OpenSemanticSqliteStore {
  readonly db: SemanticSqliteDb;
  readonly path: string;
  readonly vectorAvailable: boolean;
}

export function semanticSqlitePath(opts: { readonly vault?: string; readonly index?: string }): string {
  return semanticIndexPath({ ...opts, storage: SEMANTIC_SQLITE_STORAGE });
}

export async function openSemanticSqliteStore(opts: {
  readonly vault?: string;
  readonly index?: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}): Promise<OpenSemanticSqliteStore> {
  const databasePath = semanticSqlitePath(opts);
  if (!opts.readonly) await mkdir(path.dirname(databasePath), { recursive: true });
  const databaseOptions: { readonly?: boolean; fileMustExist?: boolean } = {};
  if (opts.readonly !== undefined) databaseOptions.readonly = opts.readonly;
  if (opts.fileMustExist !== undefined) databaseOptions.fileMustExist = opts.fileMustExist;
  const db = new Database(databasePath, databaseOptions);
  let vectorAvailable = false;
  try {
    sqliteVec.load(db);
    vectorAvailable = true;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
  }
  if (!opts.readonly) ensureSemanticSqliteSchema(db, vectorAvailable);
  return { db, path: databasePath, vectorAvailable };
}

export function ensureSemanticSqliteSchema(db: SemanticSqliteDb, vectorAvailable: boolean): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT NOT NULL DEFAULT '[]',
      include_by_default INTEGER NOT NULL DEFAULT 1,
      update_command TEXT,
      context TEXT,
      doc_count INTEGER NOT NULL DEFAULT 0,
      active_count INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT
    );
    CREATE TABLE IF NOT EXISTS store_contexts (
      collection TEXT,
      path_prefix TEXT NOT NULL,
      context TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(collection, path_prefix)
    );
    CREATE TABLE IF NOT EXISTS documents (
      rowid INTEGER PRIMARY KEY,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      uri TEXT NOT NULL,
      docid TEXT NOT NULL UNIQUE,
      title TEXT,
      content TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      term_frequency_json TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(collection, path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      docid UNINDEXED,
      collection UNINDEXED,
      path UNINDEXED,
      title,
      content
    );
  `);
  if (vectorAvailable) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors USING vec0(embedding float[${SQLITE_VECTOR_DIMENSIONS}]);`);
  }
}
