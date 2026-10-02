import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { acquireEngineStoreWriterLock, syncEngineStore, type EngineSyncOptions, type EngineSyncResult } from "./embed/sync.js";
import { assertExternalDatabasePath, engineStorePath } from "./paths.js";

/**
 * Per-note index maintenance for the write pipeline. The keyword rows of the one note
 * are replaced synchronously; its vectors are only queued in `engine_dirty`, and the
 * doctor `sync-embeddings` repair drains the queue. A vault without an engine store is
 * left without one: this module never creates a store.
 */

export type KeywordUpdate = "updated" | "failed" | "skipped";

export interface IndexUpdateDeps {
  readonly sync: (opts: EngineSyncOptions) => Promise<EngineSyncResult>;
  readonly exists: (path: string) => boolean;
  readonly now: () => Date;
}

const DEFAULT_DEPS: IndexUpdateDeps = { sync: syncEngineStore, exists: existsSync, now: () => new Date() };

const DIRTY_PREFIX = "dirty:";

function storePath(vault: string, dbPath: string | undefined): string {
  return dbPath === undefined ? engineStorePath(vault) : assertExternalDatabasePath(vault, dbPath);
}

function hasQueue(database: Database.Database): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_dirty'").get() !== undefined;
}

/**
 * A queued note's chunk digests are prefixed so the next embedding sync sees them as
 * changed and embeds them again; the lexical rows themselves are already current.
 */
function markDirty(database: Database.Database, docPaths: readonly string[]): void {
  const mark = database.prepare(`UPDATE engine_chunk_meta SET sha = ? || sha WHERE doc_path = ? AND sha NOT LIKE ?`);
  for (const docPath of docPaths) mark.run(DIRTY_PREFIX, docPath, `${DIRTY_PREFIX}%`);
}

function withWriter<T>(dbPath: string, action: (database: Database.Database) => T): T {
  const release = acquireEngineStoreWriterLock(dbPath);
  try {
    const database = new Database(dbPath, { fileMustExist: true });
    try {
      return database.transaction(() => action(database))();
    } finally {
      database.close();
    }
  } finally {
    release();
  }
}

export interface KeywordUpdateOptions {
  readonly vault: string;
  /** Vault-relative path of the note just written. */
  readonly relPath: string;
  readonly dbPath?: string | undefined;
}

/**
 * Replaces the note's keyword rows and queues its vectors. `skipped` when the vault has
 * no engine store or the note is excluded from search; `failed` when the store refused.
 */
export async function updateKeywordIndex(options: KeywordUpdateOptions, deps: Partial<IndexUpdateDeps> = {}): Promise<KeywordUpdate> {
  const { sync, exists, now } = { ...DEFAULT_DEPS, ...deps };
  let dbPath: string;
  try {
    dbPath = storePath(options.vault, options.dbPath);
  } catch {
    return "failed";
  }
  // The writer also uses fileMustExist: a removal after this check must not recreate it.
  if (!exists(dbPath)) return "skipped";
  try {
    const result = await sync({ vault: options.vault, files: [options.relPath], embed: false, dbPath, existingOnly: true, queueDirtyAt: now().toISOString() });
    if (!result.available) return "failed";
    if (result.scanned === 0) return "skipped";
    return "updated";
  } catch {
    return "failed";
  }
}

/** Queued note paths, oldest first; empty when the store or the queue is absent. */
export function listDirtyQueue(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!hasQueue(database)) return [];
    const rows = database.prepare("SELECT doc_path FROM engine_dirty ORDER BY queued_at, doc_path").all() as { doc_path: string }[];
    return rows.map((row) => row.doc_path);
  } finally {
    database.close();
  }
}

/**
 * Before an embedding sync: re-marks every queued note, so a lexical-only sync that ran
 * since the write cannot hide the stale vectors. Returns the queued paths. Harmless when
 * the sync then turns out unavailable: a queued note's vectors are stale either way, and
 * the marks only make the next available sync re-embed them.
 */
export function prepareDirtyDrain(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  return withWriter(dbPath, (database) => {
    if (!hasQueue(database)) return [];
    const queued = (database.prepare("SELECT doc_path FROM engine_dirty ORDER BY queued_at, doc_path").all() as { doc_path: string }[])
      .map((row) => row.doc_path);
    markDirty(database, queued);
    return queued;
  });
}

/**
 * After an embedding sync: removes the queued notes the sync actually re-embedded, and
 * those no longer in the store. A note that still carries a dirty digest stays queued.
 */
export function completeDirtyDrain(dbPath: string): { readonly drained: readonly string[]; readonly pending: readonly string[] } {
  if (!existsSync(dbPath)) return { drained: [], pending: [] };
  return withWriter(dbPath, (database) => {
    if (!hasQueue(database)) return { drained: [], pending: [] };
    const queued = (database.prepare("SELECT doc_path FROM engine_dirty ORDER BY queued_at, doc_path").all() as { doc_path: string }[])
      .map((row) => row.doc_path);
    const stillDirty = database.prepare("SELECT 1 FROM engine_chunk_meta WHERE doc_path = ? AND sha LIKE ? LIMIT 1");
    const remove = database.prepare("DELETE FROM engine_dirty WHERE doc_path = ?");
    const drained: string[] = [];
    const pending: string[] = [];
    for (const docPath of queued) {
      if (stillDirty.get(docPath, `${DIRTY_PREFIX}%`) !== undefined) {
        pending.push(docPath);
        continue;
      }
      remove.run(docPath);
      drained.push(docPath);
    }
    return { drained, pending };
  });
}
