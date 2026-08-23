/**
 * SQLite-backed EngineStore: FTS5 lexical search + sqlite-vec ANN.
 *
 * RALPLAN constraints (approved):
 * - Core schema (meta + FTS + engine_meta) MUST exist even when sqlite-vec is unavailable.
 * - vec/HyDE MUST NOT silently degrade to empty hits; vector usage must fail loudly.
 * - A core-only open path must exist for lex-only operation without embedding config.
 */

import { mkdirSync } from "node:fs";
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

export const ENGINE_EMBED_META_VERSION = "oms-embed-meta-v1";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pack a Float32Array as raw-bytes Buffer for sqlite-vec MATCH queries. */
function vecBuf(vector: Float32Array): Buffer {
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
      embedding_fingerprint TEXT,
      embedding_schema_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

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
  mkdirSync(path.dirname(dbPath), { recursive: true });
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
    embedding_fingerprint: string | null;
  }>(
    "SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_fingerprint FROM engine_meta WHERE id = 1",
  );

  const stmtWriteIdentity = db.prepare<[string, string, number, string]>(
    "UPDATE engine_meta SET embedding_provider = ?, embedding_model = ?, embedding_dimensions = ?, embedding_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
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
      if (
        !row.embedding_provider ||
        !row.embedding_model ||
        row.embedding_dimensions === null ||
        !row.embedding_fingerprint
      ) {
        return null;
      }
      return {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
        fingerprint: row.embedding_fingerprint,
      };
    },

    writeEmbeddingIdentity(identity: EmbeddingIdentity): void {
      stmtWriteIdentity.run(identity.provider, identity.model, identity.dimensions, identity.fingerprint);
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
    embedding_fingerprint: string | null;
  }>(
    "SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_fingerprint FROM engine_meta WHERE id = 1",
  );

  const stmtWriteIdentity = db.prepare<[string, string, number, string]>(
    "UPDATE engine_meta SET embedding_provider = ?, embedding_model = ?, embedding_dimensions = ?, embedding_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
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
      if (
        !row.embedding_provider ||
        !row.embedding_model ||
        row.embedding_dimensions === null ||
        !row.embedding_fingerprint
      ) {
        return null;
      }
      return {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
        fingerprint: row.embedding_fingerprint,
      };
    },

    writeEmbeddingIdentity(identity: EmbeddingIdentity): void {
      stmtWriteIdentity.run(identity.provider, identity.model, identity.dimensions, identity.fingerprint);
    },

    // VectorStore
    upsert(rows: ReadonlyArray<Chunk & { vector: Float32Array }>): void {
      doUpsert(rows);
    },

    queryVec(vec: Float32Array, k: number, collection?: string): ScoredHit[] {
      if (!stmtQueryVec) {
        throw new Error("EngineStore: vector queries are unavailable (sqlite-vec not loaded).");
      }
      const buf = vecBuf(vec);
      // sqlite-vec cannot apply a metadata predicate to ANN search. Fetch every
      // indexed chunk before filtering so collection scoping cannot be starved
      // by globally higher-ranked candidates, then restore the requested limit.
      const candidateLimit = collection === undefined ? k : (stmtCountChunks.get()?.count ?? 0);
      const rows = stmtQueryVec.all(buf, candidateLimit);
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
