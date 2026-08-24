/**
 * Vault → engine store synchronisation.
 *
 * RALPLAN constraints (approved):
 * - vec/HyDE require sqlite-vec + real embeddings; no fake/hash fallback.
 * - embed=false is a lex-only sync: it MUST NOT fabricate vectors.
 * - Fingerprint mismatch fails fast by default; destructive rebuild only with explicit force.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { chunkDocument } from "./chunker.js";
import { requireRealEmbeddingProvider } from "./provider.js";
import { DEFAULT_SQLITE_VEC_LOADER, openEngineStore, openEngineStoreCore } from "./store.js";
import { makeEmbeddingIdentity } from "./identity.js";
import type { EmbeddingProvider } from "../types.js";
import type { ChunkerOptions, Chunk } from "../types.js";
import type { EmbeddingIdentity, EngineStore } from "./store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EngineSyncOptions {
  /** Absolute path to the vault root (OMS_VAULT). */
  vault: string;
  /** Logical collection name stored in the index (default: "vault"). */
  collection?: string;
  /** Vault-relative sub-path to sync (default: entire vault). */
  collectionPath?: string;
  /** Absolute path to the SQLite engine store database file. Default: <vault>/.oms/engine-store.sqlite */
  dbPath?: string;
  /** When false, updates lexical index only (no vectors). Default: true. */
  embed?: boolean;
  /** Allow destructive rebuild when embedding identity mismatches. Default: false. */
  force?: boolean;
  /** Explicit embedding provider id (OMS_EMBEDDING_PROVIDER). */
  embeddingProvider?: string;
  /** Explicit embedding model/id/path (OMS_EMBEDDING_MODEL). */
  embeddingModel?: string;
  /** Chunker overrides (maxTokens, overlapRatio). */
  chunkerOpts?: Partial<ChunkerOptions>;
  /** Pre-opened store to populate. The caller retains ownership of this handle. */
  store?: EngineStore;
}

export interface EngineSyncResult {
  available: boolean;
  reason?: string;
  warnings?: string[];

  collection: string;
  dbPath: string;

  scanned: number;
  added: number;
  updated: number;
  skipped: number;

  storedIdentity?: EmbeddingIdentity;
  configuredIdentity?: EmbeddingIdentity;
}

// ---------------------------------------------------------------------------
// Internal vault walker
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", ".oms"]);

export async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(fullPath, base);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield path.relative(base, fullPath).replace(/\\/g, "/");
    }
  }
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------
function dbHasAnyChunks(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT rowid FROM engine_chunk_meta LIMIT 1").get() as { rowid: number } | undefined;
    return row !== undefined;
  } finally {
    db.close();
  }
}

function formatMismatchReason(args: {
  stored?: EmbeddingIdentity;
  configured?: EmbeddingIdentity;
  forceFlagName: string;
}): string {
  const stored = args.stored;
  const cfg = args.configured;
  const storedText = stored
    ? `stored=${stored.provider}/${stored.model} dim=${stored.dimensions} fp=${stored.fingerprint.slice(0, 12)}`
    : "stored=<none>";
  const cfgText = cfg
    ? `configured=${cfg.provider}/${cfg.model} dim=${cfg.dimensions} fp=${cfg.fingerprint.slice(0, 12)}`
    : "configured=<none>";
  return (
    `Embedding identity mismatch (${storedText}; ${cfgText}). ` +
    `Rebuild vectors with ${args.forceFlagName}.`
  );
}

// ---------------------------------------------------------------------------
// Per-document sync
// ---------------------------------------------------------------------------

interface SyncCounters {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
}

async function syncDocument(opts: {
  relPath: string;
  vault: string;
  store: EngineStore;
  provider: EmbeddingProvider | null;
  shouldEmbed: boolean;
  chunkerOpts: Partial<ChunkerOptions> | undefined;
  counters: SyncCounters;
  rebuildAllVectors: boolean;
}): Promise<void> {
  let content: string;
  try {
    content = await readFile(path.join(opts.vault, opts.relPath), "utf-8");
  } catch {
    return;
  }

  opts.counters.scanned++;
  const chunks: Chunk[] = chunkDocument(opts.relPath, content, opts.chunkerOpts);
  const storedShas = opts.store.getShas(opts.relPath);

  const chunkCountChanged = storedShas.size !== chunks.length;
  const fullRewrite = opts.rebuildAllVectors || chunkCountChanged;

  if (!opts.shouldEmbed) {
    // Lex-only: update meta+FTS only.
    // When the chunk-count changes we clear and reinsert to avoid orphaned extra chunks.
    if (fullRewrite) {
      opts.store.clearDocument(opts.relPath);
      opts.store.upsertLex(chunks);
      opts.counters.added += chunks.length;
      return;
    }

    const toUpsert: Chunk[] = [];
    for (const chunk of chunks) {
      const storedSha = storedShas.get(chunk.ordinal);
      if (storedSha === chunk.sha) {
        opts.counters.skipped++;
        continue;
      }
      toUpsert.push(chunk);
      if (storedSha === undefined) opts.counters.added++;
      else opts.counters.updated++;
    }
    if (toUpsert.length > 0) opts.store.upsertLex(toUpsert);
    return;
  }

  if (!opts.provider) {
    throw new Error("Internal error: shouldEmbed=true but provider is null.");
  }

  // Vector path
  if (fullRewrite) {
    opts.store.clearDocument(opts.relPath);
    const toUpsert: Array<Chunk & { vector: Float32Array }> = [];
    for (const chunk of chunks) {
      const vector = await opts.provider.embed(chunk.text);
      toUpsert.push({ ...chunk, vector });
      opts.counters.added++;
    }
    if (toUpsert.length > 0) opts.store.upsert(toUpsert);
    return;
  }

  const toUpsert: Array<Chunk & { vector: Float32Array }> = [];
  for (const chunk of chunks) {
    const storedSha = storedShas.get(chunk.ordinal);
    if (storedSha === chunk.sha) {
      opts.counters.skipped++;
      continue;
    }
    const vector = await opts.provider.embed(chunk.text);
    toUpsert.push({ ...chunk, vector });
    if (storedSha === undefined) opts.counters.added++;
    else opts.counters.updated++;
  }
  if (toUpsert.length > 0) opts.store.upsert(toUpsert);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function syncEngineStore(opts: EngineSyncOptions): Promise<EngineSyncResult> {
  const vault = path.resolve(opts.vault);
  const collection = opts.collection ?? "vault";
  const collectionRoot = opts.collectionPath ? path.resolve(vault, opts.collectionPath) : vault;
  const dbPath = opts.dbPath ?? path.join(vault, ".oms", "engine-store.sqlite");
  const shouldEmbed = opts.embed !== false;
  const force = opts.force === true;

  const warnings: string[] = [];

  let provider: EmbeddingProvider | null = null;
  let store: EngineStore | null = opts.store ?? null;
  const ownsStore = opts.store === undefined;

  let storedIdentity: EmbeddingIdentity | undefined;
  let configuredIdentity: EmbeddingIdentity | undefined;

  try {
    if (!shouldEmbed) {
      // Lex-only path: no embedding provider required.
      store ??= openEngineStoreCore(dbPath);
      warnings.push("embed=false: lexical index updated; no vectors generated");

      const counters: SyncCounters = { scanned: 0, added: 0, updated: 0, skipped: 0 };
      for await (const relPath of walkMarkdown(collectionRoot, vault)) {
        await syncDocument({
          relPath,
          vault,
          store,
          provider: null,
          shouldEmbed: false,
          chunkerOpts: opts.chunkerOpts,
          counters,
          rebuildAllVectors: false,
        });
      }

      return {
        available: true,
        warnings,
        collection,
        dbPath,
        scanned: counters.scanned,
        added: counters.added,
        updated: counters.updated,
        skipped: counters.skipped,
      };
    }

    const embeddingProvider = (opts.embeddingProvider ?? "").trim();
    const embeddingModel = (opts.embeddingModel ?? "").trim();

    provider = requireRealEmbeddingProvider({ provider: embeddingProvider, model: embeddingModel });
    configuredIdentity = makeEmbeddingIdentity({
      provider: embeddingProvider,
      model: embeddingModel,
      dimensions: provider.dimensions,
    });

    // Vector-capable open.
    store = openEngineStore(dbPath, provider.dimensions);
    if (!store.capabilities().vecAvailable) {
      warnings.push("Vector layer unavailable: sqlite-vec not loaded");
      return {
        available: false,
        reason: "Vector layer unavailable: sqlite-vec not loaded.",
        warnings,
        collection,
        dbPath,
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        configuredIdentity,
      };
    }

    storedIdentity = store.readEmbeddingIdentity() ?? undefined;

    // If there are indexed chunks on disk but no stored identity, treat as mismatch.
    const hasStoredChunks = dbHasAnyChunks(dbPath);
    const missingStoredIdentity = storedIdentity === undefined;

    const mismatch =
      (storedIdentity !== undefined &&
        (storedIdentity.provider !== configuredIdentity.provider ||
          storedIdentity.model !== configuredIdentity.model ||
          storedIdentity.dimensions !== configuredIdentity.dimensions ||
          storedIdentity.fingerprint !== configuredIdentity.fingerprint)) ||
      (missingStoredIdentity && hasStoredChunks);
    if (mismatch && !force) {
      return {
        available: false,
        reason: formatMismatchReason({
          stored: storedIdentity,
          configured: configuredIdentity,
          forceFlagName: "--force/force:true",
        }),
        warnings,
        collection,
        dbPath,
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        storedIdentity,
        configuredIdentity,
      };
    }

    // On force mismatch: destructive rebuild of the vec0 table.
    let rebuildAllVectors = false;
    if (mismatch && force) {
      // Close the live store handle before mutating the vec0 table.
      store.close();
      store = null;

      const db = new Database(dbPath);
      try {
        DEFAULT_SQLITE_VEC_LOADER(db);
        db.exec("DROP TABLE IF EXISTS engine_chunk_vec;");
        db.exec(
          `CREATE VIRTUAL TABLE engine_chunk_vec USING vec0(embedding float[${provider.dimensions}]);`,
        );
        rebuildAllVectors = true;
      } finally {
        db.close();
      }

      // Re-open so prepared statements reflect the rebuilt vec table.
      store = openEngineStore(dbPath, provider.dimensions);
      if (!store.capabilities().vecAvailable) {
        warnings.push("Vector layer unavailable: sqlite-vec not loaded");
        return {
          available: false,
          reason: "Vector layer unavailable: sqlite-vec not loaded.",
          warnings,
          collection,
          dbPath,
          scanned: 0,
          added: 0,
          updated: 0,
          skipped: 0,
          configuredIdentity,
        };
      }
    }

    if (!store) {
      throw new Error("Internal error: engine store is null after preparation.");
    }
    const counters: SyncCounters = { scanned: 0, added: 0, updated: 0, skipped: 0 };
    for await (const relPath of walkMarkdown(collectionRoot, vault)) {
      await syncDocument({
        relPath,
        vault,
        store,
        provider,
        shouldEmbed: true,
        chunkerOpts: opts.chunkerOpts,
        counters,
        rebuildAllVectors,
      });
    }

    // Persist configured embedding identity only after a successful embed=true sync.
    store.writeEmbeddingIdentity(configuredIdentity);

    return {
      available: true,
      warnings,
      collection,
      dbPath,
      scanned: counters.scanned,
      added: counters.added,
      updated: counters.updated,
      skipped: counters.skipped,
      storedIdentity,
      configuredIdentity,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason,
      warnings,
      collection,
      dbPath,
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      storedIdentity,
      configuredIdentity,
    };
  } finally {
    await provider?.dispose().catch(() => undefined);
    if (ownsStore) store?.close();
  }
}
