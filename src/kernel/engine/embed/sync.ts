/**
 * Vault → engine store synchronisation.
 *
 * RALPLAN constraints (approved):
 * - vec/HyDE require sqlite-vec + real embeddings; no fake/hash fallback.
 * - embed=false is a lex-only sync: it MUST NOT fabricate vectors.
 * - Fingerprint mismatch fails fast by default; destructive rebuild only with explicit force.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chunkDocument } from "./chunker.js";
import { requireRealEmbeddingProvider } from "./provider.js";
import { openEngineStore, openEngineStoreCore } from "./store.js";
import { makeEmbeddingIdentity } from "./identity.js";
import type { EmbeddingProvider } from "../types.js";
import type { ChunkerOptions, Chunk } from "../types.js";
import type { EmbeddingIdentity, EngineStore } from "./store.js";
import type { EmbeddingModelDescriptor } from "./model.js";

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
  /**
   * Explicit vault-relative markdown files to sync. When supplied, this
   * selection replaces recursive walking of collectionPath.
   */
  files?: readonly string[];
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
  /** Canonical descriptor supplied by setup; scalar fields override it. */
  embeddingDescriptor?: EmbeddingModelDescriptor;
  /** Descriptor-derived vector width (defaults to the provider's width). */
  embeddingDimensions?: number;
  /** Canonical descriptor context window in tokens. */
  embeddingContext?: number;
  /** Descriptor-derived context length; no implicit identity default. */
  embeddingContextLength?: number;
  /** Setup descriptor alias for embeddingContextLength. */
  embeddingContextTokens?: number;
  /** Descriptor-derived MRL output width. */
  embeddingMrlDim?: number;
  /** Descriptor-declared vector normalization scheme. */
  embeddingNormalization?: string;
  /** Descriptor-declared query/passage prefix scheme. */
  embeddingPrefixScheme?: string;
  /** Chunker overrides (maxTokens, overlapRatio). */
  chunkerOpts?: Partial<ChunkerOptions>;
  /** Pre-opened store to populate. The caller retains ownership of this handle. */
  store?: EngineStore;
  /** Keep synchronization process-local when populating an in-memory store. */
  persist?: boolean;
  /**
   * Test-only crash injection for generation swaps. Production callers should
   * leave this unset; it is intentionally explicit so crash recovery tests can
   * exercise every boundary without mutating process-global state.
   */
  crashPoint?: GenerationSwapCrashPoint;
  /**
   * Close any long-lived handle that is bound to the active generation before
   * its sidecars are removed and the generation is renamed.
   */
  onGenerationSwapPrepare?: () => void;
  /**
   * Rebind a long-lived handle after the swap (or restore it when preparation
   * aborts). Called while the writer lock is still held.
   */
  onGenerationSwapComplete?: (swapped: boolean) => void;
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
  /** True when this sync replaced the active on-disk generation. */
  generationSwapped?: boolean;
}

export type GenerationSwapCrashPoint =
  | "after-build"
  | "after-validation"
  | "before-swap"
  | "after-swap";

// ---------------------------------------------------------------------------
// Internal vault walker
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", ".oms"]);

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

export async function* walkMarkdown(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw new Error(`Unable to scan vault directory "${dir}": ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
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

function explicitMarkdownFiles(
  vault: string,
  collectionRelative: string,
  files: readonly string[],
): string[] {
  const selected = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Embedding sync files must contain non-empty vault-relative paths.");
    }
    const normalized = value.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
      throw new Error("Embedding sync files must stay inside the vault.");
    }
    const fullPath = path.resolve(vault, normalized);
    const relPath = path.relative(vault, fullPath).replace(/\\/g, "/");
    if (relPath === ".." || relPath.startsWith("../") || !relPath.toLowerCase().endsWith(".md")) {
      throw new Error(`Embedding sync file must be a markdown path inside the vault: ${value}`);
    }
    if (relPath.split("/").some((segment) => SKIP_DIRS.has(segment))) {
      throw new Error(`Embedding sync file is inside an ignored vault directory: ${value}`);
    }
    if (!isDocumentInCollection(relPath, collectionRelative)) continue;
    selected.add(relPath);
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

async function* selectedMarkdownFiles(
  vault: string,
  collectionRoot: string,
  collectionRelative: string,
  files: readonly string[] | undefined,
): AsyncGenerator<string> {
  if (files === undefined) {
    yield* walkMarkdown(collectionRoot, vault);
    return;
  }
  for (const relPath of explicitMarkdownFiles(vault, collectionRelative, files)) {
    yield relPath;
  }
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------
function storeHasAnyChunks(store: EngineStore): boolean {
  return store.listDocPaths().length > 0;
}

function identityEquivalent(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as unknown as Record<string, unknown>)[key] !== (b as unknown as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

interface ProviderIdentityMetadata {
  readonly context?: number;
  readonly contextLength?: number;
  readonly mrlDim?: number;
  readonly normalization?: string;
  readonly prefixScheme?: string;
}

function providerIdentityMetadata(provider: EmbeddingProvider): ProviderIdentityMetadata {
  return provider as EmbeddingProvider & ProviderIdentityMetadata;
}

/**
 * Acquire the writer lock without a dependency on a native locking package.
 *
 * A complete owner payload is published through a temporary O_EXCL inode and
 * atomically claimed with a hard link. The file records the owner PID so a
 * process killed between claim and release does not strand every future sync.
 * A live owner is always rejected (rather than silently waiting), which keeps
 * concurrent writers loud and bounded.
 */
export function acquireEngineStoreWriterLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  const lockDir = path.dirname(lockPath);
  mkdirSync(lockDir, { recursive: true });

  for (;;) {
    // Publish the owner payload through a completed temporary inode, then
    // claim the visible path with a hard link. Unlike open(..., "wx") followed
    // by write(), this never exposes an empty/partial lock file for stale
    // cleanup to mistake for a dead owner.
    const tempPath = path.join(
      lockDir,
      `.${path.basename(lockPath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    let tempFd: number | undefined;
    const ownerText = `${process.pid}\n${Date.now()}-${Math.random().toString(16).slice(2)}\n`;
    try {
      tempFd = openSync(tempPath, "wx");
      const owner = Buffer.from(ownerText, "utf8");
      writeSync(tempFd, owner, 0, owner.length, 0);
      fsyncSync(tempFd);
      closeSync(tempFd);
      tempFd = undefined;

      linkSync(tempPath, lockPath);
      unlinkSync(tempPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (tempFd !== undefined) {
        try {
          closeSync(tempFd);
        } catch {
          // Preserve the original claim/write error.
        }
      }
      try {
        unlinkSync(tempPath);
      } catch (cleanupErr) {
        if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupErr;
      }
      if (code !== "EEXIST") throw err;

      let observedLockText: string | undefined;
      let ownerPid: number | undefined;
      try {
        observedLockText = readFileSync(lockPath, "utf8");
        const ownerText = observedLockText.trim().split(/\r?\n/, 1)[0] ?? "";
        if (/^\d+$/.test(ownerText)) ownerPid = Number.parseInt(ownerText, 10);
      } catch {
        // An unreadable lock is treated as stale.
      }
      if (ownerPid !== undefined && Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          throw new Error(`Embedding sync is already in progress (lock: ${lockPath}).`);
        } catch (probeErr) {
          if ((probeErr as NodeJS.ErrnoException).code !== "ESRCH") throw probeErr;
        }
      }

      // Remove exactly the stale inode that was inspected. Renaming it away
      // first prevents a second stale cleaner from unlinking a newly claimed
      // lock between its read and delete operations.
      const stalePath = path.join(
        lockDir,
        `.${path.basename(lockPath)}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      try {
        renameSync(lockPath, stalePath);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameErr;
      }

      // Another stale cleaner may have replaced the path between our read and
      // rename. Compare the complete owner payload (which includes a nonce for
      // locks created here) before deleting the moved inode.
      let movedLockText: string | undefined;
      try {
        movedLockText = readFileSync(stalePath, "utf8");
      } catch {
        // Treat an unreadable moved inode as a failed identity check.
      }
      if (observedLockText === undefined || movedLockText !== observedLockText) {
        let restored = false;
        try {
          linkSync(stalePath, lockPath);
          restored = true;
        } catch (restoreErr) {
          const restoreCode = (restoreErr as NodeJS.ErrnoException).code;
          if (restoreCode !== "EEXIST" && restoreCode !== "ENOENT") throw restoreErr;
        }
        if (restored) {
          try {
            unlinkSync(stalePath);
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
          }
        }
        continue;
      }

      try {
        unlinkSync(stalePath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
          // Keep the stale inode visible when cleanup fails, unless another
          // writer already claimed the path after the atomic rename.
          try {
            linkSync(stalePath, lockPath);
          } catch (restoreErr) {
            const restoreCode = (restoreErr as NodeJS.ErrnoException).code;
            if (restoreCode !== "EEXIST" && restoreCode !== "ENOENT") throw restoreErr;
          }
          throw unlinkErr;
        }
      }
      continue;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(lockPath, "utf8") !== ownerText) return;
        unlinkSync(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    };
  }
}

function crashAt(
  point: GenerationSwapCrashPoint | undefined,
  expected: GenerationSwapCrashPoint,
): void {
  if (point === expected) {
    throw new Error(`Injected generation swap crash at ${expected}.`);
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

function isDocumentInCollection(docPath: string, collectionRoot: string): boolean {
  return collectionRoot === "" ||
    docPath === collectionRoot ||
    docPath.startsWith(`${collectionRoot}/`);
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
      const vector = await opts.provider.embed(chunk.text, chunk.title);
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
    const vector = await opts.provider.embed(chunk.text, chunk.title);
    toUpsert.push({ ...chunk, vector });
    if (storedSha === undefined) opts.counters.added++;
    else opts.counters.updated++;
  }
  if (toUpsert.length > 0) opts.store.upsert(toUpsert);
}

async function rebuildGenerationAtomically(opts: {
  dbPath: string;
  vault: string;
  collectionRoot: string;
  collectionRelative: string;
  files: readonly string[] | undefined;
  provider: EmbeddingProvider;
  configuredIdentity: EmbeddingIdentity;
  chunkerOpts: Partial<ChunkerOptions> | undefined;
  counters: SyncCounters;
  crashPoint: GenerationSwapCrashPoint | undefined;
  closeActive: () => void;
  onGenerationSwapPrepare?: () => void;
  onGenerationSwapComplete?: (swapped: boolean) => void;
  onSwap?: () => void;
}): Promise<void> {
  if (opts.dbPath === ":memory:") {
    throw new Error("Atomic generation swap requires a file-backed engine store.");
  }

  const directory = path.dirname(opts.dbPath);
  const base = path.basename(opts.dbPath);
  let shadowPath: string | undefined;
  let shadow: EngineStore | null = null;
  let swapped = false;
  let swapPreparationStarted = false;

  try {
    // Keep the shadow in the same directory so rename(2) is one filesystem
    // operation. The random suffix also prevents a previous crash from
    // colliding with a future generation.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = path.join(
        directory,
        `.${base}.generation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
      );
      if (!existsSync(candidate)) {
        shadowPath = candidate;
        break;
      }
    }
    if (!shadowPath) throw new Error("Could not allocate a shadow embedding generation path.");

    shadow = openEngineStore(shadowPath, opts.provider.dimensions);
    if (!shadow.capabilities().vecAvailable) {
      throw new Error("Vector layer unavailable while building the shadow generation.");
    }

    const expectedDocs = new Set<string>();
    for await (const relPath of selectedMarkdownFiles(
      opts.vault,
      opts.collectionRoot,
      opts.collectionRelative,
      opts.files,
    )) {
      expectedDocs.add(relPath);
      await syncDocument({
        relPath,
        vault: opts.vault,
        store: shadow,
        provider: opts.provider,
        shouldEmbed: true,
        chunkerOpts: opts.chunkerOpts,
        counters: opts.counters,
        rebuildAllVectors: true,
      });
    }

    crashAt(opts.crashPoint, "after-build");

    // Identity is written only to the inactive generation. The live
    // generation remains byte-for-byte unchanged until the rename below.
    shadow.writeEmbeddingIdentity(opts.configuredIdentity);
    const writtenIdentity = shadow.readEmbeddingIdentity();
    if (writtenIdentity === null || !identityEquivalent(writtenIdentity, opts.configuredIdentity)) {
      throw new Error("Shadow embedding generation failed identity validation.");
    }
    const actualDocs = new Set(shadow.listDocPaths());
    if (actualDocs.size !== expectedDocs.size || [...expectedDocs].some((doc) => !actualDocs.has(doc))) {
      throw new Error("Shadow embedding generation failed document validation.");
    }

    crashAt(opts.crashPoint, "after-validation");

    // Keep the active handle open while building and validating the shadow.
    // Closing it only here ensures no active bytes or identity can change
    // before validation has completed. Any long-lived reader owned by the
    // caller must close at the same boundary so its WAL/SHM descriptors do
    // not survive the rename.
    swapPreparationStarted = true;
    opts.onGenerationSwapPrepare?.();
    opts.closeActive();
    // close() checkpoints WAL and releases every shadow descriptor before
    // rename. The active sidecars are removed only after every known active
    // handle has closed; stale files from an interrupted run are harmless.
    unlinkStaleSidecars(opts.dbPath);
    shadow.close();
    shadow = null;
    crashAt(opts.crashPoint, "before-swap");

    // rename is atomic on the same filesystem: readers observe either the
    // complete old database or the complete new one, never a partial build.
    // Future EAV/axis state deliberately lives in its own database and is not
    // copied into this embedding generation.
    unlinkStaleSidecars(shadowPath);
    renameGeneration(shadowPath, opts.dbPath);
    swapped = true;
    opts.onSwap?.();
    opts.onGenerationSwapComplete?.(true);
    crashAt(opts.crashPoint, "after-swap");
  } finally {
    try {
      shadow?.close();
      if (shadowPath && !swapped) {
        unlinkStaleSidecars(shadowPath);
        try {
          unlinkSync(shadowPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } finally {
      // A crash or validation failure after preparation still closed the
      // caller's long-lived handle. Give it a chance to rebind to the intact
      // old generation before releasing the cross-process writer lock.
      if (swapPreparationStarted && !swapped) {
        opts.onGenerationSwapComplete?.(false);
      }
    }
  }
}

function unlinkStaleSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function renameGeneration(shadowPath: string, activePath: string): void {
  renameSync(shadowPath, activePath);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function syncEngineStore(opts: EngineSyncOptions): Promise<EngineSyncResult> {
  const vault = path.resolve(opts.vault);
  const collection = opts.collection ?? "vault";
  const collectionRoot = opts.collectionPath ? path.resolve(vault, opts.collectionPath) : vault;
  const collectionRelative = path.relative(vault, collectionRoot).replace(/\\/g, "/");
  const invalidCollectionPath =
    path.isAbsolute(collectionRelative) ||
    collectionRelative === ".." ||
    collectionRelative.startsWith("../");
  const dbPath = opts.dbPath ?? path.join(vault, ".oms", "engine-store.sqlite");
  const shouldEmbed = opts.embed !== false;
  const force = opts.force === true;
  const persist = opts.persist !== false;

  const warnings: string[] = [];

  let provider: EmbeddingProvider | null = null;
  let store: EngineStore | null = opts.store ?? null;
  const ownsStore = opts.store === undefined;

  let storedIdentity: EmbeddingIdentity | undefined;
  let configuredIdentity: EmbeddingIdentity | undefined;
  let generationSwapped = false;
  let releaseLock: (() => void) | null = null;

  try {
    if (invalidCollectionPath) {
      throw new Error("Embedding sync collectionPath must stay inside the vault.");
    }
    if (!shouldEmbed) {
      // Lex-only path: no embedding provider required.
      if (persist) releaseLock = acquireEngineStoreWriterLock(dbPath);
      store ??= openEngineStoreCore(dbPath);
      warnings.push("embed=false: lexical index updated; no vectors generated");

      const counters: SyncCounters = { scanned: 0, added: 0, updated: 0, skipped: 0 };
      for await (const relPath of selectedMarkdownFiles(
        vault,
        collectionRoot,
        collectionRelative,
        opts.files,
      )) {
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

    const descriptor = opts.embeddingDescriptor;
    const embeddingProvider = (
      opts.embeddingProvider ??
      descriptor?.provider ??
      ""
    ).trim();
    const embeddingModel = (
      opts.embeddingModel ??
      (descriptor?.path || descriptor?.modelPath) ??
      descriptor?.model ??
      ""
    ).trim();
    const embeddingDimensions = opts.embeddingDimensions ?? descriptor?.dimensions;
    const embeddingContext = opts.embeddingContext ?? descriptor?.context;
    const embeddingContextLength = opts.embeddingContextLength ?? descriptor?.contextLength;
    const embeddingContextTokens = opts.embeddingContextTokens ?? descriptor?.contextTokens;
    const embeddingMrlDim = opts.embeddingMrlDim ?? descriptor?.mrlDim;
    const embeddingNormalization = opts.embeddingNormalization ?? descriptor?.normalization;
    const embeddingPrefixScheme = opts.embeddingPrefixScheme ?? descriptor?.prefixScheme;
    if (descriptor !== undefined) {
      const descriptorContext = embeddingContext ?? embeddingContextLength ?? embeddingContextTokens;
      if (
        typeof embeddingDimensions !== "number" ||
        typeof descriptorContext !== "number" ||
        typeof embeddingMrlDim !== "number" ||
        typeof embeddingNormalization !== "string" ||
        !embeddingNormalization.trim() ||
        typeof embeddingPrefixScheme !== "string" ||
        !embeddingPrefixScheme.trim()
      ) {
        throw new Error(
          "Embedding descriptor is incomplete. dimensions/context/mrlDim/normalization/prefixScheme are required.",
        );
      }
    }

    provider = requireRealEmbeddingProvider({
      provider: embeddingProvider,
      model: embeddingModel,
      dimensions: embeddingDimensions,
      context: embeddingContext,
      contextLength: embeddingContextLength,
      contextTokens: embeddingContextTokens,
      mrlDim: embeddingMrlDim,
      normalization: embeddingNormalization,
      prefixScheme: embeddingPrefixScheme,
    });
    const metadata = providerIdentityMetadata(provider);
    const contextLength =
      embeddingContext ??
      embeddingContextLength ??
      embeddingContextTokens ??
      metadata.context ??
      metadata.contextLength;
    const mrlDim = embeddingMrlDim ?? metadata.mrlDim;
    const normalization = embeddingNormalization ?? metadata.normalization;
    const prefixScheme = embeddingPrefixScheme ?? metadata.prefixScheme;
    if (contextLength === undefined || mrlDim === undefined || normalization === undefined || prefixScheme === undefined) {
      throw new Error(
        "Embedding descriptor is incomplete. dimensions/context/mrlDim/normalization/prefixScheme are required for vector sync.",
      );
    }
    const identity = makeEmbeddingIdentity({
      provider: embeddingProvider,
      model: embeddingModel,
      dimensions: provider.dimensions,
      contextLength,
      mrlDim,
      normalization,
      prefixScheme,
    });
    configuredIdentity = identity;

    // Lock before opening the write handle so identity inspection and every
    // subsequent write observe one writer generation.
    if (persist) releaseLock = acquireEngineStoreWriterLock(dbPath);
    // A caller-owned handle is used as-is and is never closed by this
    // function. Otherwise sync owns the handle it opens below.
    store ??= openEngineStore(dbPath, provider.dimensions);
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

    try {
      storedIdentity = store.readEmbeddingIdentity() ?? undefined;
    } catch (error) {
      // A stale metadata version is intentionally not decoded as an identity.
      // Force mode can still rebuild it through the atomic generation path;
      // without force, preserve the loud rejection reason.
      if (force && error instanceof Error && /metadata version/i.test(error.message)) {
        storedIdentity = undefined;
      } else {
        throw error;
      }
    }

    // If there are indexed chunks on disk but no stored identity, treat as mismatch.
    const hasStoredChunks = storeHasAnyChunks(store);
    const missingStoredIdentity = storedIdentity === undefined;

    const mismatch =
      (storedIdentity !== undefined &&
        !identityEquivalent(storedIdentity, identity)) ||
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

    if (mismatch && force) {
      if (!ownsStore) {
        throw new Error(
          "Force reindex requires an internally-owned store; close the caller-owned handle and retry without store.",
        );
      }
      if (collectionRelative !== "") {
        const outOfScope = store.listDocPaths().filter(
          (docPath) => !isDocumentInCollection(docPath, collectionRelative),
        );
        if (outOfScope.length > 0) {
          throw new Error(
            `Scoped force reindex refused: ${outOfScope.length} indexed document(s) fall outside "${collectionRelative}". ` +
              "Run an unscoped force reindex to replace the complete generation.",
          );
        }
      }
      // Build a complete shadow generation before touching the active path.
      // Caller-owned handles are rejected above rather than being closed or
      // left pointing at a removed table.
      const counters: SyncCounters = { scanned: 0, added: 0, updated: 0, skipped: 0 };
      await rebuildGenerationAtomically({
        dbPath,
        vault,
        collectionRoot,
        collectionRelative,
        files: opts.files,
        provider,
        configuredIdentity: identity,
        chunkerOpts: opts.chunkerOpts,
        counters,
        crashPoint: opts.crashPoint,
        onGenerationSwapPrepare: opts.onGenerationSwapPrepare,
        onGenerationSwapComplete: opts.onGenerationSwapComplete,
        onSwap: () => {
          generationSwapped = true;
        },
        closeActive: () => {
          if (!store) throw new Error("Internal error: active store is already closed.");
          store.close();
          store = null;
        },
      });
      // The active handle was intentionally closed before the atomic rename.
      // Reopen it so callers that inspect the owned handle after the swap do
      // not retain prepared statements bound to the retired inode.
      store = openEngineStore(dbPath, provider.dimensions);

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
        generationSwapped,
      };
    }

    if (!store) throw new Error("Internal error: engine store is null after preparation.");
    const counters: SyncCounters = { scanned: 0, added: 0, updated: 0, skipped: 0 };
    for await (const relPath of selectedMarkdownFiles(
      vault,
      collectionRoot,
      collectionRelative,
      opts.files,
    )) {
      await syncDocument({
        relPath,
        vault,
        store,
        provider,
        shouldEmbed: true,
        chunkerOpts: opts.chunkerOpts,
        counters,
        rebuildAllVectors: false,
      });
    }

    // Persist configured embedding identity only after a successful embed=true
    // incremental sync.
    store.writeEmbeddingIdentity(identity);

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
      generationSwapped,
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
      generationSwapped,
    };
  } finally {
    await provider?.dispose().catch(() => undefined);
    if (ownsStore) store?.close();
    releaseLock?.();
  }
}
