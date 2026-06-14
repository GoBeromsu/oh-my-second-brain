/**
 * SQLite-backed VectorStore: sqlite-vec ANN + FTS5 BM25.
 *
 * Schema is isolated under `engine_chunk_*` tables to coexist with the
 * existing src/search layer in the same SQLite file if needed.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, ScoredHit, VectorStore } from "../types.js";

// ---------------------------------------------------------------------------
// Extended store interface (superset of VectorStore — dispatcher-safe)
// ---------------------------------------------------------------------------

/**
 * Extended VectorStore returned by openEngineStore().
 *
 * Adds two helpers needed by the vault→store sync layer without disturbing
 * the VectorStore interface consumed by the retrieval dispatcher.
 * EngineStore satisfies VectorStore everywhere (structural subtype).
 */
export interface EngineStore extends VectorStore {
  /**
   * Return a Map from chunk ordinal → stored SHA-256 for all chunks of
   * `docPath`.  Used by syncEngineStore() to skip re-embedding unchanged chunks.
   */
  getShas(docPath: string): Map<number, string>;
  /**
   * Delete all chunks (meta + vec + FTS) for `docPath`.
   * Useful when a document is deleted from the vault.
   */
  clearDocument(docPath: string): void;
  /**
   * Return every distinct `doc_path` currently stored.
   * Used by the cleanup op to diff stored docs against live vault paths.
   */
  listDocPaths(): string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pack a Float32Array as a raw-bytes Buffer for sqlite-vec MATCH queries. */
function vecBuf(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Simple tokeniser for FTS5 query building — mirrors the search layer approach. */
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

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

function ensureSchema(db: Database.Database, dimensions: number): boolean {
  db.pragma("journal_mode = WAL");

  // Core metadata table (non-virtual, owns the canonical rowid)
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

  // vec0 virtual table — dimension count must be baked into the DDL
  const vecExists = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='engine_chunk_vec'",
      )
      .get() as { name: string } | undefined
  ) !== undefined;

  let vectorAvailable = false;
  if (!vecExists) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE engine_chunk_vec USING vec0(embedding float[${dimensions}]);`,
      );
      vectorAvailable = true;
    } catch {
      // sqlite-vec unavailable — ANN queries will return empty lists
    }
  } else {
    vectorAvailable = true;
  }

  return vectorAvailable;
}

// ---------------------------------------------------------------------------
// Row-level types for better-sqlite3 prepared statements
// ---------------------------------------------------------------------------

interface MetaRow {
  readonly rowid: number;
  readonly doc_path: string;
  readonly ordinal: number;
  readonly text: string;
  readonly sha: string;
}

interface LexRow {
  readonly rowid: number;
  readonly doc_path: string;
  readonly ordinal: number;
  readonly rank: number;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) an engine store at `dbPath`.
 *
 * Returns an EngineStore (superset of VectorStore) which is directly usable
 * as DispatcherDeps.store without any cast.
 *
 * `dimensions` must match the embedding model's output width.
 * The vec0 virtual table DDL bakes in this value — opening with a different
 * dimension on an existing DB is a no-op (the existing table is reused as-is).
 *
 * @param dbPath     - Absolute path to the SQLite database file.
 * @param dimensions - Embedding vector width (must match EmbeddingProvider.dimensions).
 */
export function openEngineStore(dbPath: string, dimensions: number): EngineStore {
  // Ensure parent directory exists
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Load sqlite-vec extension
  let vecLoaded = false;
  try {
    sqliteVec.load(db);
    vecLoaded = true;
  } catch {
    // Native extension unavailable — queryVec will always return []
  }

  const vectorAvailable = vecLoaded && ensureSchema(db, dimensions);

  // ---------------------------------------------------------------------------
  // Prepared statements
  // ---------------------------------------------------------------------------

  const stmtGetMeta = db.prepare<[string, number], MetaRow>(
    "SELECT rowid, doc_path, ordinal, text, sha FROM engine_chunk_meta WHERE doc_path = ? AND ordinal = ?",
  );

  const stmtInsertMeta = db.prepare<[string, number, string, string]>(
    "INSERT INTO engine_chunk_meta (doc_path, ordinal, text, sha) VALUES (?, ?, ?, ?)",
  );

  const stmtUpdateMeta = db.prepare<[string, string, string, number]>(
    "UPDATE engine_chunk_meta SET text = ?, sha = ? WHERE doc_path = ? AND ordinal = ?",
  );

  const stmtDeleteVec = vectorAvailable
    ? db.prepare<[bigint]>("DELETE FROM engine_chunk_vec WHERE rowid = ?")
    : null;

  const stmtInsertVec = vectorAvailable
    ? db.prepare<[bigint, Buffer]>("INSERT INTO engine_chunk_vec(rowid, embedding) VALUES (?, ?)")
    : null;

  const stmtDeleteFts = db.prepare<[bigint]>(
    "DELETE FROM engine_chunk_fts WHERE rowid = ?",
  );

  const stmtInsertFts = db.prepare<[bigint, string, number, string]>(
    "INSERT INTO engine_chunk_fts(rowid, doc_path, ordinal, text) VALUES (?, ?, ?, ?)",
  );

  // queryVec: JOIN directly avoids a second lookup round-trip
  const stmtQueryVec = vectorAvailable
    ? db.prepare<[Buffer, number], { doc_path: string; ordinal: number; distance: number }>(
        `SELECT m.doc_path, m.ordinal, v.distance
         FROM engine_chunk_vec v
         JOIN engine_chunk_meta m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
    : null;

  const stmtQueryLex = db.prepare<[string, number], LexRow>(
    `SELECT m.rowid, m.doc_path, m.ordinal, bm25(engine_chunk_fts) AS rank
     FROM engine_chunk_fts
     JOIN engine_chunk_meta m ON m.rowid = engine_chunk_fts.rowid
     WHERE engine_chunk_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );

  // getShas: read stored ordinal→sha pairs for a document (used by sync layer)
  const stmtGetShas = db.prepare<[string], { ordinal: number; sha: string }>(
    "SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ?",
  );

  // clearDocument: delete all chunks for a document across all three tables
  const stmtClearDocVec = vectorAvailable
    ? db.prepare<[string]>(
        "DELETE FROM engine_chunk_vec WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
      )
    : null;
  const stmtClearDocFts = db.prepare<[string]>(
    "DELETE FROM engine_chunk_fts WHERE rowid IN (SELECT rowid FROM engine_chunk_meta WHERE doc_path = ?)",
  );
  const stmtClearDocMeta = db.prepare<[string]>(
    "DELETE FROM engine_chunk_meta WHERE doc_path = ?",
  );

  // listDocPaths: distinct documents currently present (used by cleanup diff)
  const stmtListDocPaths = db.prepare<[], { doc_path: string }>(
    "SELECT DISTINCT doc_path FROM engine_chunk_meta",
  );

  const doClearDocument = db.transaction((docPath: string) => {
    stmtClearDocVec?.run(docPath);
    stmtClearDocFts.run(docPath);
    stmtClearDocMeta.run(docPath);
  });

  // ---------------------------------------------------------------------------
  // Upsert transaction
  // ---------------------------------------------------------------------------

  const doUpsert = db.transaction(
    (rows: ReadonlyArray<Chunk & { vector: Float32Array }>) => {
      for (const row of rows) {
        const existing = stmtGetMeta.get(row.docPath, row.ordinal);

        if (existing !== undefined) {
          // Delete old vec + FTS entries keyed by rowid (sqlite-vec requires BigInt)
          const existingId = BigInt(existing.rowid);
          stmtDeleteVec?.run(existingId);
          stmtDeleteFts.run(existingId);
          // Update meta (rowid unchanged)
          stmtUpdateMeta.run(row.text, row.sha, row.docPath, row.ordinal);
          // Re-insert vec + FTS with the same rowid
          if (stmtInsertVec) stmtInsertVec.run(existingId, vecBuf(row.vector));
          stmtInsertFts.run(existingId, row.docPath, row.ordinal, row.text);
        } else {
          // Fresh insert — sqlite-vec vec0 requires BigInt rowid (mirrors search layer)
          const info = stmtInsertMeta.run(row.docPath, row.ordinal, row.text, row.sha);
          const rowid = BigInt(info.lastInsertRowid);
          if (stmtInsertVec) stmtInsertVec.run(rowid, vecBuf(row.vector));
          stmtInsertFts.run(rowid, row.docPath, row.ordinal, row.text);
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // VectorStore implementation
  // ---------------------------------------------------------------------------

  return {
    upsert(rows: ReadonlyArray<Chunk & { vector: Float32Array }>): void {
      doUpsert(rows);
    },

    queryVec(vec: Float32Array, k: number): ScoredHit[] {
      if (!stmtQueryVec) return [];
      const buf = vecBuf(vec);
      let rows: Array<{ doc_path: string; ordinal: number; distance: number }>;
      try {
        rows = stmtQueryVec.all(buf, k);
      } catch {
        return [];
      }
      return rows.map((r): ScoredHit => ({
        docPath: r.doc_path,
        chunkOrdinal: r.ordinal,
        // Convert L2 distance to score: closer = higher
        score: 1 / (1 + Math.max(0, r.distance)),
      }));
    },

    queryLex(text: string, k: number): ScoredHit[] {
      const ftsQ = makeFtsQuery(text);
      if (!ftsQ) return [];
      let rows: LexRow[];
      try {
        rows = stmtQueryLex.all(ftsQ, k);
      } catch {
        return [];
      }
      // BM25 rank is negative (lower = better); map to 1-based position score
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
