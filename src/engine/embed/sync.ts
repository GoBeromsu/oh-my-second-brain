/**
 * Vault → engine store synchronisation.
 *
 * Ports the vault-scan + embed + upsert pipeline from
 * src/search/semantic-sync.ts::syncSemanticEmbeddingStore() and
 * src/search/semantic-index-build.ts::buildSemanticIndex() into the engine.
 *
 * Key differences from the search layer:
 *   - Operates on chunks (chunker.ts), not whole documents.
 *   - SHA-256 incremental diff at chunk level: only re-embeds changed chunks.
 *   - Stores into the sqlite-vec EngineStore (not the JSON/SQLite search index).
 *   - No runtime import from src/search (R18 hard constraint).
 *
 * SHA-256 incremental pattern ported idea-only from qmd (tobi, MIT) —
 * see ACKNOWLEDGMENTS.md M1 section.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chunkDocument } from "./chunker.js";
import { requireRealEmbeddingProvider } from "./provider.js";
import { openEngineStore } from "./store.js";
import type { EmbeddingProvider } from "../types.js";
import type { ChunkerOptions, Chunk } from "../types.js";
import type { EngineStore } from "./store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EngineSyncOptions {
  /** Absolute path to the vault root (OMS_VAULT). */
  vault: string;
  /** Logical collection name stored in the index (default: "vault"). */
  collection?: string;
  /**
   * Vault-relative sub-path to sync (default: entire vault).
   * Must not escape the vault root.
   */
  collectionPath?: string;
  /**
   * Absolute path to the SQLite engine store database file.
   * Default: <vault>/.oms/engine-store.sqlite
   */
  dbPath?: string;
  /**
   * Absolute path to the GGUF model file.
   * Required unless UPSTAGE_API_KEY is set; omitting both causes a loud throw.
   */
  modelPath?: string;
  /**
   * When false, chunks are stored in the DB but not embedded (scan-only mode).
   * Default: true.
   */
  embed?: boolean;
  /** Chunker overrides (maxTokens, overlapRatio). */
  chunkerOpts?: Partial<ChunkerOptions>;
}

export interface EngineSyncResult {
  available: boolean;
  reason?: string;
  collection: string;
  dbPath: string;
  scanned: number;
  added: number;
  updated: number;
  /** Chunks skipped because their SHA-256 matched the stored value. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Internal vault walker (ported from semantic-index-build.ts, idea-only)
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
// Per-document incremental sync helper
// ---------------------------------------------------------------------------

interface SyncCounters {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
}

async function syncDocument(
  relPath: string,
  vault: string,
  store: EngineStore,
  provider: EmbeddingProvider,
  shouldEmbed: boolean,
  chunkerOpts: Partial<ChunkerOptions> | undefined,
  counters: SyncCounters,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(path.join(vault, relPath), "utf-8");
  } catch {
    return; // unreadable file — skip silently
  }

  counters.scanned++;
  const chunks: Chunk[] = chunkDocument(relPath, content, chunkerOpts);

  // SHA-256 incremental diff: read stored shas for this document
  const storedShas = store.getShas(relPath);

  const toUpsert: Array<Chunk & { vector: Float32Array }> = [];

  for (const chunk of chunks) {
    const storedSha = storedShas.get(chunk.ordinal);
    if (storedSha === chunk.sha) {
      // Chunk text is unchanged — skip embedding (SHA-256 incremental pattern, qmd MIT)
      counters.skipped++;
      continue;
    }

    let vector: Float32Array;
    if (shouldEmbed) {
      vector = await provider.embed(chunk.text);
    } else {
      // embed=false: store a zero vector as placeholder (test/scan-only mode)
      vector = new Float32Array(provider.dimensions);
    }

    toUpsert.push({ ...chunk, vector });
    if (storedSha === undefined) {
      counters.added++;
    } else {
      counters.updated++;
    }
  }

  if (toUpsert.length > 0) {
    store.upsert(toUpsert);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scan the vault (or a sub-collection), chunk every markdown file, and
 * upsert changed chunks into the engine SQLite store.
 *
 * Unchanged chunks (SHA-256 match) are skipped — embedding is not called for
 * them, keeping incremental re-sync cheap.
 *
 * Requires a real embedding provider: set OMS_MODEL_PATH (GGUF) or
 * UPSTAGE_API_KEY (Upstage Solar). Omitting both causes a loud throw so that
 * the vault index is never silently populated with fake embeddings.
 *
 * The GGUF model is lazy-loaded on the first embed() call and unloaded after
 * 5 minutes of inactivity.
 *
 * @param opts - Sync configuration.
 * @returns Counters describing what was scanned / added / updated / skipped.
 */
export async function syncEngineStore(
  opts: EngineSyncOptions,
): Promise<EngineSyncResult> {
  const vault = path.resolve(opts.vault);
  const collection = opts.collection ?? "vault";
  const collectionRoot = opts.collectionPath
    ? path.resolve(vault, opts.collectionPath)
    : vault;
  const dbPath =
    opts.dbPath ?? path.join(vault, ".oms", "engine-store.sqlite");
  const shouldEmbed = opts.embed !== false;

  let provider: EmbeddingProvider | null = null;
  let store: EngineStore | null = null;

  try {
    provider = requireRealEmbeddingProvider({ modelPath: opts.modelPath });
    store = openEngineStore(dbPath, provider.dimensions);

    const counters: SyncCounters = {
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
    };

    for await (const relPath of walkMarkdown(collectionRoot, vault)) {
      await syncDocument(
        relPath,
        vault,
        store,
        provider,
        shouldEmbed,
        opts.chunkerOpts,
        counters,
      );
    }

    return {
      available: true,
      collection,
      dbPath,
      scanned: counters.scanned,
      added: counters.added,
      updated: counters.updated,
      skipped: counters.skipped,
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason,
      collection,
      dbPath,
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
    };
  } finally {
    // Always dispose provider and close store — no resource leaks
    await provider?.dispose().catch(() => undefined);
    store?.close();
  }
}
