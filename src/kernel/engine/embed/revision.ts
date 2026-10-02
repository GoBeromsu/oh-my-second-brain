import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface DirtyDocumentRevision {
  readonly docPath: string;
  readonly queuedAt: string;
  /** null identifies a pre-revision queue entry; maintenance upgrades it from Markdown. */
  readonly revision: string | null;
}

/** Only called by explicit write-side opens, never by search/read-only handles. */
export function ensureDocumentRevisionSchema(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS engine_dirty (doc_path TEXT PRIMARY KEY, queued_at TEXT NOT NULL, revision TEXT)");
  const columns = db.prepare("PRAGMA table_info(engine_dirty)").all() as { name: string }[];
  if (!columns.some(column => column.name === "revision")) db.exec("ALTER TABLE engine_dirty ADD COLUMN revision TEXT");
}

function revisionProjection(db: Database.Database): string | null {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_dirty'").get() === undefined) return null;
  const columns = db.prepare("PRAGMA table_info(engine_dirty)").all() as { name: string }[];
  return columns.some(column => column.name === "revision") ? "revision" : "NULL AS revision";
}

/** A bounded read for conditional deletion, including pre-revision queues. */
export function readDirtyDocumentRevision(db: Database.Database, docPath: string): string | null | undefined {
  const revision = revisionProjection(db);
  if (revision === null) return undefined;
  return db.prepare<[string], { revision: string | null }>(`SELECT ${revision} FROM engine_dirty WHERE doc_path = ?`).get(docPath)?.revision;
}

/** This reader tolerates a legacy/missing queue without creating or migrating it. */
export function readDirtyDocumentRevisions(db: Database.Database): DirtyDocumentRevision[] {
  const revision = revisionProjection(db);
  if (revision === null) return [];
  return (db.prepare(`SELECT doc_path, queued_at, ${revision} FROM engine_dirty ORDER BY queued_at, doc_path`).all() as {
    doc_path: string; queued_at: string; revision: string | null;
  }[]).map(row => ({ docPath: row.doc_path, queuedAt: row.queued_at, revision: row.revision }));
}

export function createDocumentRevisionAccess(db: Database.Database) {
  const read = db.prepare<[string], { revision: string | null }>("SELECT revision FROM engine_dirty WHERE doc_path = ?");
  const invalidate = db.prepare("UPDATE engine_dirty SET revision = ? WHERE doc_path = ?");
  const remove = db.prepare("DELETE FROM engine_dirty WHERE doc_path = ?");
  const mark = db.prepare("UPDATE engine_chunk_meta SET sha = 'dirty:' || sha WHERE doc_path = ? AND sha NOT LIKE 'dirty:%'");
  return {
    transaction<T>(action: () => T): T { return db.transaction(action)(); },
    read(docPath: string): string | null | undefined { return read.get(docPath)?.revision; },
    invalidate(docPath: string): void { invalidate.run(randomUUID(), docPath); },
    remove(docPath: string): void { remove.run(docPath); },
    queue(docPath: string, queuedAt: string): string {
      const revision = randomUUID();
      db.prepare("INSERT OR REPLACE INTO engine_dirty (doc_path, queued_at, revision) VALUES (?, ?, ?)").run(docPath, queuedAt, revision);
      mark.run(docPath);
      return revision;
    },
  };
}

export type DocumentRevisionAccess = ReturnType<typeof createDocumentRevisionAccess>;
