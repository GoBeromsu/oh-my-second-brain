/**
 * Korean syllable-bigram FTS5 index beside the engine store (branch-only, PR6).
 *
 * `engine_chunk_bigram` mirrors `engine_chunk_meta` with Hangul runs expanded
 * to syllable bigrams (see retrieval/lexical-ko.ts). It lives in the same
 * SQLite file but on its own connection, so store.ts is unchanged. A stored
 * index version plus a row-count check decide when the table is rebuilt.
 */

import Database from "better-sqlite3";
import type { ScoredHit } from "../types.js";
import { expandKoreanBigrams, makeBigramFtsQuery } from "../retrieval/lexical-ko.js";

/** Bump when the bigram expansion changes, so existing tables are rebuilt. */
export const BIGRAM_INDEX_VERSION = 1;

export interface BigramIndex {
  /** Rebuilds the bigram table when its version or row count is stale; true when it rebuilt. */
  ensure(): boolean;
  queryBigram(text: string, k: number): ScoredHit[];
  close(): void;
}

/**
 * Opens the bigram index on an existing engine store file. The file must
 * already hold the core schema (`engine_chunk_meta`).
 */
export function openBigramIndex(dbPath: string): BigramIndex {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS engine_chunk_bigram USING fts5(
        doc_path UNINDEXED,
        ordinal  UNINDEXED,
        text
      );
      CREATE TABLE IF NOT EXISTS engine_chunk_bigram_meta (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const stmtVersion = db.prepare<[], { version: number }>("SELECT version FROM engine_chunk_bigram_meta WHERE id = 1");
  const stmtMetaCount = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM engine_chunk_meta");
  const stmtBigramCount = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM engine_chunk_bigram");
  const stmtSource = db.prepare<[], { rowid: number; doc_path: string; ordinal: number; text: string }>(
    "SELECT rowid, doc_path, ordinal, text FROM engine_chunk_meta",
  );
  const stmtInsert = db.prepare<[number, string, number, string]>(
    "INSERT INTO engine_chunk_bigram (rowid, doc_path, ordinal, text) VALUES (?, ?, ?, ?)",
  );
  const stmtQuery = db.prepare<[string, number], { doc_path: string; ordinal: number }>(
    `SELECT doc_path, ordinal FROM engine_chunk_bigram
     WHERE engine_chunk_bigram MATCH ?
     ORDER BY bm25(engine_chunk_bigram)
     LIMIT ?`,
  );

  const rebuild = db.transaction(() => {
    db.exec("DELETE FROM engine_chunk_bigram");
    for (const row of stmtSource.all()) {
      stmtInsert.run(row.rowid, row.doc_path, row.ordinal, expandKoreanBigrams(row.text));
    }
    db.prepare("INSERT OR REPLACE INTO engine_chunk_bigram_meta (id, version) VALUES (1, ?)").run(BIGRAM_INDEX_VERSION);
  });

  return {
    ensure(): boolean {
      const version = stmtVersion.get()?.version;
      const stale = version !== BIGRAM_INDEX_VERSION || stmtMetaCount.get()?.n !== stmtBigramCount.get()?.n;
      if (stale) rebuild();
      return stale;
    },

    queryBigram(text: string, k: number): ScoredHit[] {
      const query = makeBigramFtsQuery(text);
      if (!query) return [];
      return stmtQuery.all(query, k).map((row, index): ScoredHit => ({
        docPath: row.doc_path,
        chunkOrdinal: row.ordinal,
        score: 1 / (1 + index),
      }));
    },

    close(): void {
      db.close();
    },
  };
}
