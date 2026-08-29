/**
 * SQLite-backed EngineStore: FTS5 lexical search + sqlite-vec ANN.
 *
 * RALPLAN constraints (approved):
 * - Core schema (meta + FTS + engine_meta) MUST exist even when sqlite-vec is unavailable.
 * - vec/HyDE MUST NOT silently degrade to empty hits; vector usage must fail loudly.
 * - A core-only open path must exist for lex-only operation without embedding config.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, ScoredHit, VectorStore } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SqliteVecLoader = (db: Database.Database) => void;

export const DEFAULT_SQLITE_VEC_LOADER: SqliteVecLoader = (db) => sqliteVec.load(db);

export interface EngineStoreCapabilities {
  readonly vecAvailable: boolean;
}

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly contextLength: number;
  readonly mrlDim: number;
  readonly normalization: string;
  readonly prefixScheme: string;
  readonly fingerprint: string;
}

/**
 * Extended VectorStore returned by openEngineStore()/openEngineStoreCore().
 *
 * EngineStore satisfies VectorStore everywhere (structural subtype).
 */
export interface EngineStore extends VectorStore {
  /** Capability snapshot for this store handle. */
  capabilities(): EngineStoreCapabilities;

  /** Upsert chunks into meta+FTS only (no vectors). */
  upsertLex(rows: ReadonlyArray<Chunk>): void;

  /** Read stored embedding identity (null when none is recorded). */
  readEmbeddingIdentity(): EmbeddingIdentity | null;

  /** Overwrite stored embedding identity and updated_at. */
  writeEmbeddingIdentity(identity: EmbeddingIdentity): void;

  /**
   * Return a Map from chunk ordinal → stored SHA-256 for all chunks of `docPath`.
   * Used by syncEngineStore() to skip reprocessing unchanged chunks.
   */
  getShas(docPath: string): Map<number, string>;

  /** Delete all chunks (meta + vec + FTS) for `docPath`. */
  clearDocument(docPath: string): void;

  /** Return every distinct `doc_path` currently stored. */
  listDocPaths(): string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENGINE_EMBED_META_VERSION = "oms-embed-meta-v2";

/**
 * Largest `k` sqlite-vec accepts in a knn query.
 *
 * Above this the extension rejects the statement outright ("k value in knn
 * query too large"). Callers legitimately ask for an unbounded candidate set:
 * without an explicit `candidateLimit` the MCP facade requests
 * `Number.MAX_SAFE_INTEGER` so it retrieves the complete ranked stream and keeps
 * `totalCount` and offset cursors accurate past the first page. FTS tolerates
 * that; sqlite-vec does not, so the vector store clamps rather than propagate a
 * limit the extension cannot honour.
 */
export const SQLITE_VEC_MAX_K = 4096;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a requested knn width into sqlite-vec's supported range.
 *
 * A non-positive or non-finite request collapses to 1 rather than 0 so a caller
 * that asks for "some" results never silently receives an empty page.
 *
 * Clamping is a real ceiling, not a formality. In a vault with more than
 * `SQLITE_VEC_MAX_K` indexed chunks the vector candidate stream is truncated, so
 * a vector-derived `totalCount` and any deep page past that band are bounded by
 * it; a collection-scoped query is affected more sharply, because sqlite-vec
 * ranks before the collection predicate is applied and a collection whose chunks
 * all fall outside the band can be starved. Both are properties of
 * ANN-before-predicate search in sqlite-vec. The alternative was failing every
 * vector query outright, which is what shipped before this clamp.
 */
function clampVecK(k: number): number {
  if (!Number.isFinite(k)) return SQLITE_VEC_MAX_K;
  return Math.max(1, Math.min(SQLITE_VEC_MAX_K, Math.floor(k)));
}

/** Pack a finite Float32Array as raw bytes for sqlite-vec operations. */
function vecBuf(vector: Float32Array): Buffer {
  if (!(vector instanceof Float32Array)) {
    throw new Error("EngineStore vector must be a Float32Array.");
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
      throw new Error(`EngineStore vector contains a non-finite value at index ${index}.`);
    }
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Simple tokeniser for FTS5 query building — mirrors the legacy search layer. */
function makeFtsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 32);
  if (terms.length === 0) return "";
  return terms.map((t) => `${t.replace(/"/g, "")}*`).join(" OR ");
}

function collectionDescendantLikePattern(collection: string): string {
  return `${collection.replace(/[!%_]/g, "!$&")}/%`;
}

function ensureCoreSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");

  // (1) engine_meta — single-row embedding identity metadata
  // updated_at is initialised at schema creation and updated again only when
  // writeEmbeddingIdentity() is called.
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      embedding_provider TEXT,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      embedding_context_length INTEGER,
      embedding_mrl_dim INTEGER,
      embedding_normalization TEXT,
      embedding_prefix_scheme TEXT,
      embedding_fingerprint TEXT,
      embedding_schema_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Existing stores are deliberately not rewritten here.  Additive columns
  // let us inspect their schema version and reject stale identities loudly
  // instead of accidentally treating old vectors as compatible.
  const columns = new Set(
    (db.prepare("PRAGMA table_info(engine_meta)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions: ReadonlyArray<[string, string]> = [
    ["embedding_context_length", "INTEGER"],
    ["embedding_mrl_dim", "INTEGER"],
    ["embedding_normalization", "TEXT"],
    ["embedding_prefix_scheme", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE engine_meta ADD COLUMN ${name} ${type}`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO engine_meta (id, embedding_schema_version, updated_at) VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(ENGINE_EMBED_META_VERSION);

  // (2) engine_chunk_meta + engine_chunk_fts
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_chunk_meta (
      rowid  INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_path TEXT NOT NULL,
      ordinal  INTEGER NOT NULL,
      text     TEXT NOT NULL,
      sha      TEXT NOT NULL,
      UNIQUE(doc_path, ordinal)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS engine_chunk_fts USING fts5(
      doc_path UNINDEXED,
      ordinal  UNINDEXED,
      text
    );
  `);
}

function vecTableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_chunk_vec'")
    .get() as { name: string } | undefined;
  return row !== undefined;
}

function createVecTable(db: Database.Database, dimensions: number): void {
  db.exec(
    `CREATE VIRTUAL TABLE engine_chunk_vec USING vec0(embedding float[${dimensions}]);`,
  );
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/**
 * Open (or create) an engine store at `dbPath` in CORE-ONLY mode.
 *
 * Core-only mode:
 * - creates core schema (meta + FTS + engine_meta)
 * - does NOT create vec0
 * - queryVec() throws
 * - upsert() throws
 */
export function openEngineStoreCore(dbPath: string): EngineStore {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);

  ensureCoreSchema(db);
  // Optional: load sqlite-vec so lex-only sync can delete stale vectors for
  // modified chunks (prevents silent cross-model reuse on later vec queries).
  let stmtDeleteVec: ReturnType<Database.Database["prepare"]> | null = null;
  let stmtClearDocVec: ReturnType<Database.Database["prepare"]> | null = null;
  try {
    DEFAULT_SQLITE_VEC_LOADER(db);
    if (vecTableExists(db)) {
      stmtDeleteVec = db.prepare<[bigint]>("DELETE FROM engine_chunk_vec WHERE rowid = ?");
      stmtClearDocVec = db.prepare<[string]>(
        "DELETE FROM engine_chunk_vec WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
      );
    }
  } catch {
    // sqlite-vec unavailable or vec table absent — core-only mode still works.
  }

  // Prepared statements — core only
  const stmtGetMeta = db.prepare<[string, number], { rowid: number; doc_path: string; ordinal: number; text: string; sha: string }>(
    "SELECT rowid, doc_path, ordinal, text, sha FROM engine_chunk_meta WHERE doc_path = ? AND ordinal = ?",
  );
  const stmtInsertMeta = db.prepare<[string, number, string, string]>(
    "INSERT INTO engine_chunk_meta (doc_path, ordinal, text, sha) VALUES (?, ?, ?, ?)",
  );
  const stmtUpdateMeta = db.prepare<[string, string, string, number]>(
    "UPDATE engine_chunk_meta SET text = ?, sha = ? WHERE doc_path = ? AND ordinal = ?",
  );

  const stmtDeleteFts = db.prepare<[bigint]>(
    "DELETE FROM engine_chunk_fts WHERE rowid = ?",
  );
  const stmtInsertFts = db.prepare<[bigint, string, number, string]>(
    "INSERT INTO engine_chunk_fts(rowid, doc_path, ordinal, text) VALUES (?, ?, ?, ?)",
  );

  const stmtQueryLex = db.prepare<[string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );
  const stmtQueryLexInCollection = db.prepare<[string, string, string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ? AND (m.doc_path = ? OR m.doc_path LIKE ? ESCAPE '!')
     ORDER BY rank
     LIMIT ?`,
  );

  const stmtGetShas = db.prepare<[string], { ordinal: number; sha: string }>(
    "SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ?",
  );

  const stmtClearDocFts = db.prepare<[string]>(
    "DELETE FROM engine_chunk_fts WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
  );
  const stmtClearDocMeta = db.prepare<[string]>(
    "DELETE FROM engine_chunk_meta WHERE doc_path = ?",
  );

  const stmtListDocPaths = db.prepare<[], { doc_path: string }>(
    "SELECT DISTINCT doc_path FROM engine_chunk_meta",
  );

  const stmtReadIdentity = db.prepare<[], {
    embedding_provider: string | null;
    embedding_model: string | null;
    embedding_dimensions: number | null;
    embedding_context_length: number | null;
    embedding_mrl_dim: number | null;
    embedding_normalization: string | null;
    embedding_prefix_scheme: string | null;
    embedding_fingerprint: string | null;
    embedding_schema_version: string;
  }>(
    "SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_context_length, embedding_mrl_dim, embedding_normalization, embedding_prefix_scheme, embedding_fingerprint, embedding_schema_version FROM engine_meta WHERE id = 1",
  );

  const stmtWriteIdentity = db.prepare<[string, string, number, number, number, string, string, string]>(
    "UPDATE engine_meta SET embedding_provider = ?, embedding_model = ?, embedding_dimensions = ?, embedding_context_length = ?, embedding_mrl_dim = ?, embedding_normalization = ?, embedding_prefix_scheme = ?, embedding_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
  );

  const doUpsertLex = db.transaction((rows: ReadonlyArray<Chunk>) => {
    for (const row of rows) {
      const existing = stmtGetMeta.get(row.docPath, row.ordinal);
      if (existing) {
        const id = BigInt(existing.rowid);
        stmtDeleteVec?.run(id);
        stmtDeleteFts.run(id);
        stmtUpdateMeta.run(row.text, row.sha, row.docPath, row.ordinal);
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      } else {
        const info = stmtInsertMeta.run(row.docPath, row.ordinal, row.text, row.sha);
        const id = BigInt(info.lastInsertRowid);
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      }
    }
  });

  const doClearDocument = db.transaction((docPath: string) => {
    stmtClearDocVec?.run(docPath);
    stmtClearDocFts.run(docPath);
    stmtClearDocMeta.run(docPath);
  });

  return {
    capabilities(): EngineStoreCapabilities {
      return { vecAvailable: false };
    },

    upsertLex(rows: ReadonlyArray<Chunk>): void {
      doUpsertLex(rows);
    },

    // VectorStore
    upsert(): void {
      throw new Error("EngineStore(core-only): vector upsert is unavailable.");
    },

    queryVec(): ScoredHit[] {
      throw new Error("EngineStore(core-only): vector queries are unavailable.");
    },

    queryLex(text: string, k: number, collection?: string): ScoredHit[] {
      const ftsQ = makeFtsQuery(text);
      if (!ftsQ) return [];
      let rows: Array<{ doc_path: string; ordinal: number; rank: number }>;
      try {
        rows = collection === undefined
          ? stmtQueryLex.all(ftsQ, k)
          : stmtQueryLexInCollection.all(ftsQ, collection, collectionDescendantLikePattern(collection), k);
      } catch {
        return [];
      }
      return rows.map((r, index): ScoredHit => ({
        docPath: r.doc_path,
        chunkOrdinal: r.ordinal,
        score: 1 / (1 + index),
      }));
    },

    close(): void {
      db.pragma("wal_checkpoint(PASSIVE)");
      db.close();
    },

    // EngineStore extensions
    readEmbeddingIdentity(): EmbeddingIdentity | null {
      const row = stmtReadIdentity.get();
      if (!row) return null;
      if (row.embedding_schema_version !== ENGINE_EMBED_META_VERSION) {
        throw new Error(
          `Embedding metadata version "${row.embedding_schema_version}" is incompatible; expected "${ENGINE_EMBED_META_VERSION}".`,
        );
      }
      const hasAnyIdentityField =
        row.embedding_provider !== null ||
        row.embedding_model !== null ||
        row.embedding_dimensions !== null ||
        row.embedding_context_length !== null ||
        row.embedding_mrl_dim !== null ||
        row.embedding_normalization !== null ||
        row.embedding_prefix_scheme !== null ||
        row.embedding_fingerprint !== null;
      if (!hasAnyIdentityField) return null;
      if (
        !row.embedding_provider ||
        !row.embedding_model ||
        row.embedding_dimensions === null ||
        row.embedding_context_length === null ||
        row.embedding_mrl_dim === null ||
        !row.embedding_normalization ||
        !row.embedding_prefix_scheme ||
        !row.embedding_fingerprint
      ) {
        throw new Error("Embedding metadata identity is incomplete.");
      }
      return {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
        contextLength: row.embedding_context_length,
        mrlDim: row.embedding_mrl_dim,
        normalization: row.embedding_normalization,
        prefixScheme: row.embedding_prefix_scheme,
        fingerprint: row.embedding_fingerprint,
      };
    },

    writeEmbeddingIdentity(identity: EmbeddingIdentity): void {
      stmtWriteIdentity.run(
        identity.provider,
        identity.model,
        identity.dimensions,
        identity.contextLength,
        identity.mrlDim,
        identity.normalization,
        identity.prefixScheme,
        identity.fingerprint,
      );
    },

    getShas(docPath: string): Map<number, string> {
      const rows = stmtGetShas.all(docPath);
      const out = new Map<number, string>();
      for (const r of rows) out.set(r.ordinal, r.sha);
      return out;
    },

    clearDocument(docPath: string): void {
      doClearDocument(docPath);
    },

    listDocPaths(): string[] {
      return stmtListDocPaths.all().map((r) => r.doc_path);
    },
  };
}

/** Open a core-only store held entirely in SQLite memory. */
export function openInMemoryEngineStoreCore(): EngineStore {
  return openEngineStoreCore(":memory:");
}

/**
 * Open (or create) an engine store at `dbPath` with vector capability.
 *
 * Vector-capable mode still guarantees core schema exists even when sqlite-vec
 * cannot be loaded, but in that case vecAvailable=false and vector operations
 * throw.
 */
export function openEngineStore(
  dbPath: string,
  dimensions: number,
  opts: { readonly sqliteVecLoader?: SqliteVecLoader } = {},
): EngineStore {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  ensureCoreSchema(db);

  const sqliteVecLoader = opts.sqliteVecLoader ?? DEFAULT_SQLITE_VEC_LOADER;
  let vecLoaded = false;
  try {
    sqliteVecLoader(db);
    vecLoaded = true;
  } catch {
    vecLoaded = false;
  }

  // Create vec table only when the extension is loaded.
  let vecAvailable = false;
  if (vecLoaded) {
    if (!vecTableExists(db)) {
      try {
        createVecTable(db, dimensions);
        vecAvailable = true;
      } catch {
        vecAvailable = false;
      }
    } else {
      vecAvailable = true;
    }
  }

  // Prepared statements (core)
  const stmtGetMeta = db.prepare<[string, number], { rowid: number; doc_path: string; ordinal: number; text: string; sha: string }>(
    "SELECT rowid, doc_path, ordinal, text, sha FROM engine_chunk_meta WHERE doc_path = ? AND ordinal = ?",
  );
  const stmtInsertMeta = db.prepare<[string, number, string, string]>(
    "INSERT INTO engine_chunk_meta (doc_path, ordinal, text, sha) VALUES (?, ?, ?, ?)",
  );
  const stmtUpdateMeta = db.prepare<[string, string, string, number]>(
    "UPDATE engine_chunk_meta SET text = ?, sha = ? WHERE doc_path = ? AND ordinal = ?",
  );

  const stmtDeleteFts = db.prepare<[bigint]>(
    "DELETE FROM engine_chunk_fts WHERE rowid = ?",
  );
  const stmtInsertFts = db.prepare<[bigint, string, number, string]>(
    "INSERT INTO engine_chunk_fts(rowid, doc_path, ordinal, text) VALUES (?, ?, ?, ?)",
  );

  const stmtQueryLex = db.prepare<[string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );
  const stmtQueryLexInCollection = db.prepare<[string, string, string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ? AND (m.doc_path = ? OR m.doc_path LIKE ? ESCAPE '!')
     ORDER BY rank
     LIMIT ?`,
  );

  const stmtGetShas = db.prepare<[string], { ordinal: number; sha: string }>(
    "SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ?",
  );

  const stmtClearDocFts = db.prepare<[string]>(
    "DELETE FROM engine_chunk_fts WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
  );
  const stmtClearDocMeta = db.prepare<[string]>(
    "DELETE FROM engine_chunk_meta WHERE doc_path = ?",
  );

  const stmtListDocPaths = db.prepare<[], { doc_path: string }>(
    "SELECT DISTINCT doc_path FROM engine_chunk_meta",
  );

  const stmtReadIdentity = db.prepare<[], {
    embedding_provider: string | null;
    embedding_model: string | null;
    embedding_dimensions: number | null;
    embedding_context_length: number | null;
    embedding_mrl_dim: number | null;
    embedding_normalization: string | null;
    embedding_prefix_scheme: string | null;
    embedding_fingerprint: string | null;
    embedding_schema_version: string;
  }>(
    "SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_context_length, embedding_mrl_dim, embedding_normalization, embedding_prefix_scheme, embedding_fingerprint, embedding_schema_version FROM engine_meta WHERE id = 1",
  );

  const stmtWriteIdentity = db.prepare<[string, string, number, number, number, string, string, string]>(
    "UPDATE engine_meta SET embedding_provider = ?, embedding_model = ?, embedding_dimensions = ?, embedding_context_length = ?, embedding_mrl_dim = ?, embedding_normalization = ?, embedding_prefix_scheme = ?, embedding_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
  );

  // Prepared statements (vec)
  const stmtDeleteVec = vecAvailable
    ? db.prepare<[bigint]>("DELETE FROM engine_chunk_vec WHERE rowid = ?")
    : null;
  const stmtInsertVec = vecAvailable
    ? db.prepare<[bigint, Buffer]>("INSERT INTO engine_chunk_vec(rowid, embedding) VALUES (?, ?)")
    : null;

  const stmtQueryVec = vecAvailable
    ? db.prepare<[Buffer, number], { doc_path: string; ordinal: number; distance: number }>(
        `SELECT m.doc_path, m.ordinal, v.distance
         FROM engine_chunk_vec v
         JOIN engine_chunk_meta m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
    : null;
  const stmtCountChunks = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM engine_chunk_meta",
  );

  const stmtClearDocVec = vecAvailable
    ? db.prepare<[string]>(
        "DELETE FROM engine_chunk_vec WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
      )
    : null;

  const doClearDocument = db.transaction((docPath: string) => {
    stmtClearDocVec?.run(docPath);
    stmtClearDocFts.run(docPath);
    stmtClearDocMeta.run(docPath);
  });

  const doUpsertLex = db.transaction((rows: ReadonlyArray<Chunk>) => {
    for (const row of rows) {
      const existing = stmtGetMeta.get(row.docPath, row.ordinal);
      if (existing) {
        const id = BigInt(existing.rowid);
        // Lex-only updates can change the chunk text without regenerating an
        // embedding. Remove the old vector before replacing metadata so a
        // later vector query cannot return a stale hit for the new chunk.
        stmtDeleteVec?.run(id);
        stmtDeleteFts.run(id);
        stmtUpdateMeta.run(row.text, row.sha, row.docPath, row.ordinal);
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      } else {
        const info = stmtInsertMeta.run(row.docPath, row.ordinal, row.text, row.sha);
        const id = BigInt(info.lastInsertRowid);
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      }
    }
  });

  const doUpsert = db.transaction((rows: ReadonlyArray<Chunk & { vector: Float32Array }>) => {
    if (!vecAvailable || !stmtInsertVec || !stmtDeleteVec) {
      throw new Error("EngineStore: vector layer unavailable (sqlite-vec not loaded).");
    }
    for (const row of rows) {
      const existing = stmtGetMeta.get(row.docPath, row.ordinal);
      if (existing) {
        const id = BigInt(existing.rowid);
        stmtDeleteVec.run(id);
        stmtDeleteFts.run(id);
        stmtUpdateMeta.run(row.text, row.sha, row.docPath, row.ordinal);
        stmtInsertVec.run(id, vecBuf(row.vector));
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      } else {
        const info = stmtInsertMeta.run(row.docPath, row.ordinal, row.text, row.sha);
        const id = BigInt(info.lastInsertRowid);
        stmtInsertVec.run(id, vecBuf(row.vector));
        stmtInsertFts.run(id, row.docPath, row.ordinal, row.text);
      }
    }
  });

  return {
    capabilities(): EngineStoreCapabilities {
      return { vecAvailable };
    },

    upsertLex(rows: ReadonlyArray<Chunk>): void {
      doUpsertLex(rows);
    },

    readEmbeddingIdentity(): EmbeddingIdentity | null {
      const row = stmtReadIdentity.get();
      if (!row) return null;
      if (row.embedding_schema_version !== ENGINE_EMBED_META_VERSION) {
        throw new Error(
          `Embedding metadata version "${row.embedding_schema_version}" is incompatible; expected "${ENGINE_EMBED_META_VERSION}".`,
        );
      }
      const hasAnyIdentityField =
        row.embedding_provider !== null ||
        row.embedding_model !== null ||
        row.embedding_dimensions !== null ||
        row.embedding_context_length !== null ||
        row.embedding_mrl_dim !== null ||
        row.embedding_normalization !== null ||
        row.embedding_prefix_scheme !== null ||
        row.embedding_fingerprint !== null;
      if (!hasAnyIdentityField) return null;
      if (
        !row.embedding_provider ||
        !row.embedding_model ||
        row.embedding_dimensions === null ||
        row.embedding_context_length === null ||
        row.embedding_mrl_dim === null ||
        !row.embedding_normalization ||
        !row.embedding_prefix_scheme ||
        !row.embedding_fingerprint
      ) {
        throw new Error("Embedding metadata identity is incomplete.");
      }
      return {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
        contextLength: row.embedding_context_length,
        mrlDim: row.embedding_mrl_dim,
        normalization: row.embedding_normalization,
        prefixScheme: row.embedding_prefix_scheme,
        fingerprint: row.embedding_fingerprint,
      };
    },

    writeEmbeddingIdentity(identity: EmbeddingIdentity): void {
      stmtWriteIdentity.run(
        identity.provider,
        identity.model,
        identity.dimensions,
        identity.contextLength,
        identity.mrlDim,
        identity.normalization,
        identity.prefixScheme,
        identity.fingerprint,
      );
    },

    // VectorStore
    upsert(rows: ReadonlyArray<Chunk & { vector: Float32Array }>): void {
      doUpsert(rows);
    },

    queryVec(vec: Float32Array, k: number, collection?: string): ScoredHit[] {
      const buf = vecBuf(vec);
      if (!stmtQueryVec) {
        throw new Error("EngineStore: vector queries are unavailable (sqlite-vec not loaded).");
      }
      // sqlite-vec cannot apply a metadata predicate to ANN search. Widen the
      // candidate set to every indexed chunk before filtering so collection
      // scoping is not starved by globally higher-ranked candidates, then
      // restore the requested limit. Both branches clamp: the extension caps
      // knn `k`, and callers may legitimately request an unbounded page.
      const requested = collection === undefined ? k : (stmtCountChunks.get()?.count ?? 0);
      const rows = stmtQueryVec.all(buf, clampVecK(requested));
      return rows
        .filter((r) => collection === undefined || r.doc_path === collection || r.doc_path.startsWith(`${collection}/`))
        .slice(0, k)
        .map((r): ScoredHit => ({
        docPath: r.doc_path,
        chunkOrdinal: r.ordinal,
        score: 1 / (1 + Math.max(0, r.distance)),
        }));
    },

    queryLex(text: string, k: number, collection?: string): ScoredHit[] {
      const ftsQ = makeFtsQuery(text);
      if (!ftsQ) return [];
      let rows: Array<{ doc_path: string; ordinal: number; rank: number }>;
      try {
        rows = collection === undefined
          ? stmtQueryLex.all(ftsQ, k)
          : stmtQueryLexInCollection.all(ftsQ, collection, collectionDescendantLikePattern(collection), k);
      } catch {
        return [];
      }
      return rows.map((r, index): ScoredHit => ({
        docPath: r.doc_path,
        chunkOrdinal: r.ordinal,
        score: 1 / (1 + index),
      }));
    },

    close(): void {
      db.pragma("wal_checkpoint(PASSIVE)");
      db.close();
    },

    // EngineStore extensions
    getShas(docPath: string): Map<number, string> {
      const rows = stmtGetShas.all(docPath);
      const out = new Map<number, string>();
      for (const r of rows) out.set(r.ordinal, r.sha);
      return out;
    },

    clearDocument(docPath: string): void {
      doClearDocument(docPath);
    },

    listDocPaths(): string[] {
      return stmtListDocPaths.all().map((r) => r.doc_path);
    },
  };
}

const REQUIRED_CORE_TABLES = [
  "engine_meta",
  "engine_chunk_meta",
  "engine_chunk_fts",
] as const;

/**
 * Open an engine store that already exists, creating nothing.
 *
 * `fileMustExist` is what enforces the read-only guarantee that matters: a
 * search on a vault with no index must not bring one into being. The connection
 * itself is writable, and that is deliberate.
 *
 * SQLite's `readonly: true` was tried first and rejected. The store runs in WAL
 * mode, and a read-only connection to a WAL database still needs the `-shm`
 * shared-memory index. SQLite creates it, and a read-only connection cannot
 * check-point or remove it on close, so every search left `engine-store.sqlite-shm`
 * and `-wal` behind in the user's vault. A writable connection creates the same
 * sidecars transiently and cleans them up when it closes, so it leaves the vault
 * genuinely untouched. Refusing to create beats being unable to tidy up.
 *
 * Write protection is therefore enforced above this line, not by SQLite: the
 * store returned by `openReadOnlyStore` prepares only SELECT statements and every
 * mutator throws.
 */
function openExistingCoreStore(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) return null;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (error) {
    throw new Error(
      `Engine store is unavailable at "${dbPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
    ).all(...REQUIRED_CORE_TABLES) as Array<{ name: string }>;
    if (rows.length !== REQUIRED_CORE_TABLES.length) {
      throw new Error(`Engine store at "${dbPath}" is corrupt or incompatible: required core tables are missing.`);
    }
    const metaColumns = new Set(
      (db.prepare("PRAGMA table_info(engine_meta)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const requiredMetaColumns = [
      "embedding_context_length",
      "embedding_mrl_dim",
      "embedding_normalization",
      "embedding_prefix_scheme",
    ];
    if (requiredMetaColumns.some((column) => !metaColumns.has(column))) {
      throw new Error(`Engine store at "${dbPath}" is corrupt or incompatible: required metadata columns are missing.`);
    }
    return db;
  } catch (error) {
    db.close();
    if (error instanceof Error && error.message.startsWith(`Engine store at "${dbPath}"`)) {
      throw error;
    }
    throw new Error(
      `Engine store at "${dbPath}" is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readonlyMutation(method: string): never {
  throw new Error(
    `EngineStore: ${method} is unavailable because this store was opened for reading only.`,
  );
}

function openReadOnlyStore(
  dbPath: string,
  opts: { readonly sqliteVecLoader?: SqliteVecLoader; readonly vectors?: boolean } = {},
): EngineStore | null {
  const db = openExistingCoreStore(dbPath);
  if (db === null) return null;

  const stmtQueryLex = db.prepare<[string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );
  const stmtQueryLexInCollection = db.prepare<[string, string, string, number], { doc_path: string; ordinal: number; rank: number }>(
    `SELECT m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ? AND (m.doc_path = ? OR m.doc_path LIKE ? ESCAPE '!')
     ORDER BY rank
     LIMIT ?`,
  );
  const stmtGetShas = db.prepare<[string], { ordinal: number; sha: string }>(
    "SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ?",
  );
  const stmtListDocPaths = db.prepare<[], { doc_path: string }>(
    "SELECT DISTINCT doc_path FROM engine_chunk_meta",
  );
  const stmtReadIdentity = db.prepare<[], {
    embedding_provider: string | null;
    embedding_model: string | null;
    embedding_dimensions: number | null;
    embedding_context_length: number | null;
    embedding_mrl_dim: number | null;
    embedding_normalization: string | null;
    embedding_prefix_scheme: string | null;
    embedding_fingerprint: string | null;
    embedding_schema_version: string;
  }>(
    "SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_context_length, embedding_mrl_dim, embedding_normalization, embedding_prefix_scheme, embedding_fingerprint, embedding_schema_version FROM engine_meta WHERE id = 1",
  );

  // These carry their bound parameter and row types: the bare
  // ReturnType<prepare> erases both generics, which makes `.get()` demand an
  // argument it does not take and forces a cast on every row read.
  let stmtQueryVec: Database.Statement<[Buffer, number], { doc_path: string; ordinal: number; distance: number }> | null = null;
  let stmtCountChunks: Database.Statement<[], { count: number }> | null = null;
  if (opts.vectors) {
    try {
      (opts.sqliteVecLoader ?? DEFAULT_SQLITE_VEC_LOADER)(db);
      if (vecTableExists(db)) {
        stmtQueryVec = db.prepare<[Buffer, number], { doc_path: string; ordinal: number; distance: number }>(
          `SELECT m.doc_path, m.ordinal, v.distance
           FROM engine_chunk_vec v
           JOIN engine_chunk_meta m ON m.rowid = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance`,
        );
        stmtCountChunks = db.prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM engine_chunk_meta",
        );
      }
    } catch {
      stmtQueryVec = null;
      stmtCountChunks = null;
    }
  }

  return {
    capabilities(): EngineStoreCapabilities {
      return { vecAvailable: stmtQueryVec !== null };
    },
    upsertLex(): void {
      readonlyMutation("upsertLex");
    },
    upsert(): void {
      readonlyMutation("upsert");
    },
    queryVec(vec: Float32Array, k: number, collection?: string): ScoredHit[] {
      const buf = vecBuf(vec);
      if (!stmtQueryVec || !stmtCountChunks) {
        throw new Error("EngineStore: vector queries are unavailable (sqlite-vec not loaded).");
      }
      const requested = collection === undefined ? k : (stmtCountChunks.get()?.count ?? 0);
      return stmtQueryVec.all(buf, clampVecK(requested))
        .filter((row) => collection === undefined || row.doc_path === collection || row.doc_path.startsWith(`${collection}/`))
        .slice(0, k)
        .map((row): ScoredHit => ({
          docPath: row.doc_path,
          chunkOrdinal: row.ordinal,
          score: 1 / (1 + Math.max(0, row.distance)),
        }));
    },
    queryLex(text: string, k: number, collection?: string): ScoredHit[] {
      const ftsQ = makeFtsQuery(text);
      if (!ftsQ) return [];
      try {
        const rows = collection === undefined
          ? stmtQueryLex.all(ftsQ, k)
          : stmtQueryLexInCollection.all(ftsQ, collection, collectionDescendantLikePattern(collection), k);
        return rows.map((row, index): ScoredHit => ({
          docPath: row.doc_path,
          chunkOrdinal: row.ordinal,
          score: 1 / (1 + index),
        }));
      } catch (error) {
        throw new Error(
          `Engine store lexical query failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
    close(): void {
      db.close();
    },
    readEmbeddingIdentity(): EmbeddingIdentity | null {
      const row = stmtReadIdentity.get();
      if (!row) return null;
      if (row.embedding_schema_version !== ENGINE_EMBED_META_VERSION) {
        throw new Error(
          `Embedding metadata version "${row.embedding_schema_version}" is incompatible; expected "${ENGINE_EMBED_META_VERSION}".`,
        );
      }
      const hasAnyIdentityField =
        row.embedding_provider !== null ||
        row.embedding_model !== null ||
        row.embedding_dimensions !== null ||
        row.embedding_context_length !== null ||
        row.embedding_mrl_dim !== null ||
        row.embedding_normalization !== null ||
        row.embedding_prefix_scheme !== null ||
        row.embedding_fingerprint !== null;
      if (!hasAnyIdentityField) return null;
      if (
        !row.embedding_provider ||
        !row.embedding_model ||
        row.embedding_dimensions === null ||
        row.embedding_context_length === null ||
        row.embedding_mrl_dim === null ||
        !row.embedding_normalization ||
        !row.embedding_prefix_scheme ||
        !row.embedding_fingerprint
      ) {
        throw new Error("Embedding metadata identity is incomplete.");
      }
      return {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
        contextLength: row.embedding_context_length,
        mrlDim: row.embedding_mrl_dim,
        normalization: row.embedding_normalization,
        prefixScheme: row.embedding_prefix_scheme,
        fingerprint: row.embedding_fingerprint,
      };
    },
    writeEmbeddingIdentity(): void {
      readonlyMutation("writeEmbeddingIdentity");
    },
    getShas(docPath: string): Map<number, string> {
      return new Map(stmtGetShas.all(docPath).map((row) => [row.ordinal, row.sha]));
    },
    clearDocument(): void {
      readonlyMutation("clearDocument");
    },
    listDocPaths(): string[] {
      return stmtListDocPaths.all().map((row) => row.doc_path);
    },
  };
}

/** Open an existing core store for reads without creating files or schema. */
export function openEngineStoreCoreReadOnly(dbPath: string): EngineStore | null {
  return openReadOnlyStore(dbPath);
}

/** Open an existing vector-capable store for reads without creating files or schema. */
export function openEngineStoreReadOnly(
  dbPath: string,
  _dimensions: number,
  opts: { readonly sqliteVecLoader?: SqliteVecLoader } = {},
): EngineStore | null {
  return openReadOnlyStore(dbPath, { ...opts, vectors: true });
}
