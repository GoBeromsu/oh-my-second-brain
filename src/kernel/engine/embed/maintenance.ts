import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { managedSourceExclusionMatcher, readSourceExclusions } from "../../conventions/note-exclude.js";
import { assertExternalDatabasePath, engineStorePath } from "../paths.js";
import type { Chunk, ChunkerOptions, EmbeddingProvider } from "../types.js";
import { chunkDocument } from "./chunker.js";
import { validateEmbeddingIdentity } from "./identity.js";
import { readDirtyDocumentRevision, readDirtyDocumentRevisions, type DirtyDocumentRevision } from "./revision.js";
import { createDocumentSourceAccess, documentSourceMatches, documentSourceMissing, readDocumentSource, type DocumentSource } from "./source.js";
import { readEngineStoreIdentity, withExistingEngineStoreTransaction, type EmbeddingIdentity, type EngineStore } from "./store.js";
import { acquireEngineStoreWriterLock } from "./sync.js";

export interface DocumentMaintenanceOptions {
  readonly vault: string;
  readonly relPath: string;
  readonly dbPath?: string;
  readonly chunkerOpts?: Partial<ChunkerOptions>;
  readonly signal?: AbortSignal;
  /** Owner/config epoch check; evaluated immediately inside each commit. A throw rolls it back. */
  readonly isCurrent?: () => boolean;
}
export type DocumentMaintenanceResult = "updated" | "deleted" | "skipped" | "stale";

function current(options: DocumentMaintenanceOptions): boolean {
  return options.signal?.aborted !== true && options.isCurrent?.() !== false;
}
function location(options: DocumentMaintenanceOptions): { vault: string; relPath: string; dbPath: string } {
  const vault = path.resolve(options.vault);
  const relPath = options.relPath.replace(/\\/g, "/");
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/u.test(relPath) || !relPath.toLowerCase().endsWith(".md") ||
    relPath.split("/").some(segment => segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || segment === "node_modules")) {
    throw new Error("Index maintenance requires a visible Markdown path inside the vault.");
  }
  return { vault, relPath, dbPath: options.dbPath === undefined ? engineStorePath(vault) : assertExternalDatabasePath(vault, options.dbPath) };
}

const STALE_TRANSACTION = Symbol("stale maintenance transaction");

function withStore<T>(dbPath: string, identity: EmbeddingIdentity | undefined, preflight: (db: Database.Database) => boolean, action: (store: EngineStore) => T): T | null {
  const release = acquireEngineStoreWriterLock(dbPath);
  try {
    return withExistingEngineStoreTransaction(dbPath, identity?.dimensions, db => {
      if (!preflight(db)) throw STALE_TRANSACTION;
    }, store => {
      const result = action(store);
      // Initialization belongs to the publication transaction too. Refusing a
      // late result must roll back any migration or vector-table creation.
      if (result === null || result === "stale") throw STALE_TRANSACTION;
      return result;
    });
  } catch (error) {
    if (error === STALE_TRANSACTION) return null;
    throw error;
  } finally { release(); }
}

/** Read pending paths/revisions without creating or migrating any persistent state. */
export function listPendingDocumentRevisions(dbPath: string): DirtyDocumentRevision[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return readDirtyDocumentRevisions(db); }
  finally { db.close(); }
}

export interface MaintenanceState {
  /** Includes zero-chunk notes, legacy chunks, and pending-only paths with null source evidence. */
  readonly documents: ReadonlyMap<string, DocumentSource | null>;
  readonly pending: readonly DirtyDocumentRevision[];
  readonly embeddingIdentity: EmbeddingIdentity | null;
  readonly sqliteVersion: string;
}

/** Explicit maintenance inventory; opens the original database read-only without migrations. */
export function readMaintenanceState(dbPath: string): MaintenanceState {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const documents = new Map<string, DocumentSource | null>();
      for (const row of db.prepare<[], { doc_path: string }>("SELECT DISTINCT doc_path FROM engine_chunk_meta").all()) documents.set(row.doc_path, null);
      for (const [docPath, source] of createDocumentSourceAccess(db, true).readDocumentSources() ?? []) documents.set(docPath, source);
      const pending = readDirtyDocumentRevisions(db);
      for (const queued of pending) if (!documents.has(queued.docPath)) documents.set(queued.docPath, null);
      const version = db.prepare<[], { version: string }>("SELECT sqlite_version() AS version").get()!;
      return { documents, pending, embeddingIdentity: readEngineStoreIdentity(db), sqliteVersion: version.version };
    })();
  } finally { db.close(); }
}

/**
 * One explicit write-side transaction publishes chunks, FTS, source evidence, and
 * a fresh dirty revision. Missing notes are removed only after a second absence
 * check inside that transaction. No store is created for an ordinary note write.
 */
export async function maintainDocumentIndex(options: DocumentMaintenanceOptions & { readonly queuedAt?: string; readonly purgeExcluded?: boolean }): Promise<DocumentMaintenanceResult> {
  const { vault, relPath, dbPath } = location(options);
  if (!existsSync(dbPath)) return "skipped";
  if (!current(options)) return "stale";
  const excluded = await managedSourceExclusionMatcher(vault);
  if (await excluded(relPath)) {
    if (options.purgeExcluded !== true) return "skipped";
    // Only the complete-scan owner requests this. Capture the current source and
    // queue, reread policy, then guard the short deletion transaction as well.
    const captured = documentSourceMissing(vault, relPath) ? null : await readDocumentSource(vault, relPath, options.chunkerOpts);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let revision: string | null | undefined;
    try { revision = readDirtyDocumentRevision(db, relPath); }
    finally { db.close(); }
    const policy = await readSourceExclusions(vault);
    const latestExclusion = await managedSourceExclusionMatcher(vault);
    if (!await latestExclusion(relPath) || !current(options)) return "stale";
    const result = withStore(dbPath, undefined, db => current(options) && readDirtyDocumentRevision(db, relPath) === revision &&
      (captured === null ? documentSourceMissing(vault, relPath) : documentSourceMatches(vault, relPath, captured.source)), store => {
      if (!current(options) || store.documentRevisions!.read(relPath) !== revision ||
        !(captured === null ? documentSourceMissing(vault, relPath) : documentSourceMatches(vault, relPath, captured.source))) return "stale";
      store.clearDocument(relPath);
      store.documentRevisions!.remove(relPath);
      return "deleted";
    }) ?? "stale";
    // Policy files and SQLite cannot share a transaction. If a subsequent policy
    // observation disagrees, the owner must rescan even if this deletion committed.
    return (await readSourceExclusions(vault)).digest === policy.digest ? result : "stale";
  }
  if (documentSourceMissing(vault, relPath)) {
    if (!current(options)) return "stale";
    return withStore(dbPath, undefined, () => current(options) && documentSourceMissing(vault, relPath), store => {
      if (!current(options) || !documentSourceMissing(vault, relPath)) return "stale";
      store.clearDocument(relPath);
      store.documentRevisions!.remove(relPath);
      return "deleted";
    }) ?? "stale";
  }
  const { content, source } = await readDocumentSource(vault, relPath, options.chunkerOpts);
  const chunks = chunkDocument(relPath, content, options.chunkerOpts);
  if (!current(options)) return "stale";
  return withStore(dbPath, undefined, () => current(options) && documentSourceMatches(vault, relPath, source), store => {
    if (!current(options) || !documentSourceMatches(vault, relPath, source)) return "stale";
    const previous = store.readDocumentSource!(relPath);
    const shas = store.getShas(relPath);
    if (previous?.fingerprint === source.fingerprint && previous.contentSha256 === source.contentSha256 && previous.chunker === source.chunker &&
      store.documentRevisions!.read(relPath) !== null && shas.size === chunks.length && chunks.every(chunk => shas.get(chunk.ordinal) === chunk.sha || shas.get(chunk.ordinal) === `dirty:${chunk.sha}`)) return "skipped";
    store.clearDocument(relPath);
    store.upsertLex(chunks);
    store.recordDocumentSource(relPath, source, chunks);
    store.documentRevisions!.queue(relPath, options.queuedAt ?? new Date().toISOString());
    return "updated";
  }) ?? "stale";
}

export interface QueuedEmbeddingOptions extends DocumentMaintenanceOptions {
  readonly provider: EmbeddingProvider;
  readonly identity: EmbeddingIdentity;
}

/**
 * Inference owns no database handle or writer lock. Commit requires the same
 * queued revision, raw source, chunker, stored model, and live owner/config epoch.
 * An ignored abort or late native result cannot overwrite or dequeue newer work.
 */
export async function embedQueuedDocument(options: QueuedEmbeddingOptions): Promise<DocumentMaintenanceResult> {
  const { vault, relPath, dbPath } = location(options);
  if (!existsSync(dbPath)) return "skipped";
  if (!current(options)) return "stale";
  const identity = { ...options.identity };
  validateEmbeddingIdentity(identity);
  if (options.provider.dimensions !== identity.dimensions) throw new Error("Embedding provider dimensions do not match the configured identity.");
  const excluded = await managedSourceExclusionMatcher(vault);
  if (await excluded(relPath)) return "skipped";
  if (documentSourceMissing(vault, relPath)) return maintainDocumentIndex(options);
  const { content, source } = await readDocumentSource(vault, relPath, options.chunkerOpts);
  const chunks = chunkDocument(relPath, content, options.chunkerOpts);
  if (!current(options)) return "stale";
  const expected = withStore(dbPath, undefined, () => current(options) && documentSourceMatches(vault, relPath, source), store => {
    if (!current(options) || !documentSourceMatches(vault, relPath, source)) return null;
    let revision = store.documentRevisions!.read(relPath);
    if (revision === undefined) return null;
    const indexed = store.readDocumentSource!(relPath);
    if (indexed?.contentSha256 !== source.contentSha256 || indexed.chunker !== source.chunker || indexed.fingerprint !== source.fingerprint) return null;
    const storedIdentity = store.readEmbeddingIdentity();
    if (storedIdentity?.fingerprint !== identity.fingerprint) throw new Error("Index maintenance embedding identity differs from the store; run explicit embedding synchronization.");
    const shas = store.getShas(relPath);
    if (shas.size !== chunks.length || chunks.some(chunk => shas.get(chunk.ordinal) !== chunk.sha && shas.get(chunk.ordinal) !== `dirty:${chunk.sha}`)) return null;
    const clean = chunks.every(chunk => shas.get(chunk.ordinal) === chunk.sha);
    const coverage = clean ? store.vectorOrdinals!(relPath) : new Set<number>();
    if (clean && chunks.every(chunk => coverage.has(chunk.ordinal))) {
      // A successful explicit sync may have committed before its separate doctor
      // drain. Verify coverage, then finish only this still-current queue entry.
      store.documentRevisions!.remove(relPath);
      return "completed";
    }
    if (revision === null || chunks.some(chunk => shas.get(chunk.ordinal) === chunk.sha)) {
      revision = store.documentRevisions!.queue(relPath, new Date().toISOString());
    }
    return { revision, shas: store.getShas(relPath) };
  });
  if (expected === null) return "stale";
  if (expected === "completed") return "updated";
  const vectors: Array<Chunk & { vector: Float32Array }> = [];
  for (const chunk of chunks) {
    if (!current(options)) return "stale";
    const vector = await options.provider.embed(chunk.text, chunk.title);
    if (!current(options)) return "stale";
    vectors.push({ ...chunk, vector });
  }
  if (!current(options)) return "stale";
  return withStore(dbPath, identity, db => {
    if (!current(options) || !documentSourceMatches(vault, relPath, source) ||
      readDirtyDocumentRevision(db, relPath) !== expected.revision ||
      readEngineStoreIdentity(db)?.fingerprint !== identity.fingerprint) return false;
    const shas = db.prepare<[string], { ordinal: number; sha: string }>("SELECT ordinal, sha FROM engine_chunk_meta WHERE doc_path = ?").all(relPath);
    return shas.length === expected.shas.size && shas.every(row => expected.shas.get(row.ordinal) === row.sha);
  }, store => {
    if (!current(options) || !documentSourceMatches(vault, relPath, source) ||
      store.documentRevisions!.read(relPath) !== expected.revision ||
      store.readEmbeddingIdentity()?.fingerprint !== identity.fingerprint) return "stale";
    const shas = store.getShas(relPath);
    if (shas.size !== expected.shas.size || [...expected.shas].some(([ordinal, sha]) => shas.get(ordinal) !== sha)) return "stale";
    if (!store.capabilities().vecAvailable) throw new Error("Vector layer unavailable: sqlite-vec not loaded.");
    store.upsert(vectors);
    store.recordDocumentSource(relPath, source, chunks);
    store.documentRevisions!.remove(relPath);
    return "updated";
  }) ?? "stale";
}
