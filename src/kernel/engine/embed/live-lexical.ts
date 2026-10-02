import { AxisObservationStore } from "../axes/store.js";
import type { ObservedDiscoveryResult } from "../axes/observed-discovery.js";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapWithConcurrency } from "../../conventions/vault-walk.js";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import { parseNodeProjectionDocument, projectNodeIndex, type NodeProjectionDocument } from "../graph/builder.js";
import type { EngineGraphNode } from "../graph/node.js";
import type { SearchTemplateSource } from "../retrieval/template-source.js";
import type { ScoredHit, VectorStore } from "../types.js";
import { assertExternalDatabasePath, engineStorePath } from "../paths.js";
import { hashReadSnapshotFile } from "./read-snapshot.js";
import { fileMetadataWitness } from "../../conventions/file-snapshot.js";
import { parseNote } from "../../conventions/frontmatter.js";
import { makeDeferredStore } from "./deferred.js";
import { scanIndexSources, type IndexSourceSnapshot } from "./freshness.js";
import { chunkDocument } from "./chunker.js";
import { readDocumentSource, type DocumentSource } from "./source.js";
import { openDetachedLexicalStore, type DetachedLexicalStore, type EngineStore } from "./store.js";
import { LexicalDocumentBatch } from "./lexical-batch.js";

/** Retained SQLite pages, not a claim about peak RSS while reading a large file. */
export const LIVE_LEXICAL_MEMORY_BYTES = 128 * 1024 * 1024;
export const LIVE_LEXICAL_PROJECTION_BYTES = 64 * 1024 * 1024;
export const LIVE_OBSERVED_MEMORY_BYTES = 64 * 1024 * 1024;
const CHUNKER = JSON.stringify({ version: 1, maxTokens: 900, overlapRatio: 0.15 });

export interface LexicalCandidateSelection {
  readonly paths: readonly string[];
  /** Captured synchronously while the same source generation remains pinned. */
  readonly discover?: (matchingPaths: readonly string[]) => ObservedDiscoveryResult;
}

export type LexicalSnapshotSelector = (snapshot: IndexSourceSnapshot, documents: readonly NodeProjectionDocument[], observations: AxisObservationStore) => LexicalCandidateSelection;

export interface PreparedLexicalRead {
  readonly store: VectorStore;
  readonly snapshot: IndexSourceSnapshot;
  readonly candidatePaths?: readonly string[];
  readonly discovery?: ObservedDiscoveryResult;
  /** The ordinary graph/node projection over this request's captured sources. */
  nodeProjection(meta: SearchTemplateSource): Promise<EngineGraphNode[]>;
}

interface RefreshedLexicalSource {
  readonly snapshot: IndexSourceSnapshot;
  readonly documents: readonly NodeProjectionDocument[];
}

export interface LiveLexicalOptions {
  readonly vault: string;
  readonly dbPath?: string;
  /** Test/embedding seam; oversized corpora spill into a disposable temp store. */
  readonly maxMemoryBytes?: number;
  /** Compact parsed fields/links only; excess entries use the private axis store. */
  readonly maxProjectionBytes?: number;
  /** Combined private backing/EAV page budget; canonical EAV rows stay observed-only. */
  readonly maxObservedBytes?: number;
}

function stamp(filename: string): string {
  try {
    const info = statSync(filename, { bigint: true });
    const witness = fileMetadataWitness(info);
    // Unknown/coarse metadata never authorizes reuse. Hash the source bytes on
    // these filesystems; the detached snapshot protocol still checks stability.
    const digest = witness === null ? hashReadSnapshotFile(filename) : undefined;
    if (digest === null) return "absent";
    return JSON.stringify([realpathSync(filename), witness ?? `bytes:${digest}`]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Metadata is change evidence; no source SQLite handle or source sidecars are opened. */
function generation(vault: string, dbPath: string): string {
  return createHash("sha256").update(JSON.stringify([
    realpathSync(vault), vaultIdentity(vault), assertExternalDatabasePath(vault, dbPath), stamp(dbPath), stamp(`${dbPath}-wal`), CHUNKER,
  ])).digest("hex");
}

/** Directory timestamps change on ordinary edits; only its stable identity matters. */
function vaultIdentity(vault: string): string | undefined {
  const canonical = realpathSync(vault);
  const info = statSync(canonical, { bigint: true });
  if (!info.isDirectory() || typeof info.dev !== "bigint" || info.dev <= 0n
    || typeof info.ino !== "bigint" || info.ino <= 0n) return undefined;
  return JSON.stringify([canonical, info.dev.toString(), info.ino.toString(), CHUNKER]);
}

function lexicalKey(query: string, k: number, collection?: string): string {
  return JSON.stringify([query, k, collection ?? null]);
}

/**
 * One server/invocation owns one detached native lexical corpus. Refresh is
 * single-flight; each request captures its candidate lists before yielding, so
 * later refreshes cannot change an in-flight rerank or hydrate different text.
 */
export class LiveLexicalSession {
  private readonly vault: string;
  private readonly dbPath: string;
  private readonly maxMemoryBytes: number;
  private readonly maxProjectionBytes: number;
  private readonly maxObservedBytes: number;
  private observations: AxisObservationStore | undefined;
  private observedDiskPath: string | undefined;
  private readonly projections = new Map<string, { readonly sha: string; readonly document: NodeProjectionDocument }>();
  private projectionBytes = 0;
  private current: DetachedLexicalStore | undefined;
  private sourceGeneration: string | undefined;
  private completeVaultIdentity: string | undefined;
  private temporaryDirectory: string | undefined;
  private onDisk = false;
  private currentDiskPath: string | undefined;
  private refreshing: Promise<RefreshedLexicalSource> | undefined;
  private closed = false;
  private active = 0;
  private drained: (() => void) | undefined;
  private disposal: Promise<void> | undefined;

  constructor(options: LiveLexicalOptions) {
    this.vault = path.resolve(options.vault);
    this.dbPath = options.dbPath ?? engineStorePath(this.vault);
    this.maxMemoryBytes = options.maxMemoryBytes ?? LIVE_LEXICAL_MEMORY_BYTES;
    this.maxProjectionBytes = options.maxProjectionBytes ?? LIVE_LEXICAL_PROJECTION_BYTES;
    this.maxObservedBytes = options.maxObservedBytes ?? LIVE_OBSERVED_MEMORY_BYTES;
    if (!Number.isSafeInteger(this.maxObservedBytes) || this.maxObservedBytes < 1) throw new Error("Observed metadata memory budget must be a positive safe integer.");
    if (!Number.isSafeInteger(this.maxProjectionBytes) || this.maxProjectionBytes < 0) throw new Error("Live projection budget must be a non-negative safe integer.");
    if (!Number.isSafeInteger(this.maxMemoryBytes) || this.maxMemoryBytes < 1) {
      throw new Error("Live lexical memory budget must be a positive safe integer.");
    }
  }

  /** Assembly guard; only prepare() exposes captured lexical reads. */
  readonly store: EngineStore = {
    ...makeDeferredStore(),
    listDocPaths: () => this.current?.store.listDocPaths() ?? [],
    readEmbeddingIdentity: () => null,
  };

  private tempPath(): string {
    if (this.temporaryDirectory === undefined) {
      // Validate before mkdtemp: even temporary derived state must stay outside
      // the vault, including when TMPDIR points through a symbolic link.
      assertExternalDatabasePath(this.vault, path.join(tmpdir(), "oms-live-lexical", "core.sqlite"));
      this.temporaryDirectory = mkdtempSync(path.join(tmpdir(), "oms-live-lexical-"));
    }
    return path.join(this.temporaryDirectory, `${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  }

  private removeTemporaryDatabase(filename: string | undefined): void {
    if (filename === undefined) return;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filename}${suffix}`, { force: true });
  }

  private replace(next: DetachedLexicalStore, token: string, diskPath?: string): void {
    const previous = this.current;
    const previousPath = this.currentDiskPath;
    this.current = next;
    this.sourceGeneration = token;
    this.onDisk = diskPath !== undefined;
    this.currentDiskPath = diskPath;
    previous?.close();
    this.removeTemporaryDatabase(previousPath);
  }

  private enforceBudget(): void {
    if (this.current === undefined || this.onDisk || this.current.allocatedBytes() <= this.maxMemoryBytes) return;
    const previous = this.current;
    const destination = this.tempPath();
    try {
      const next = previous.copyTo(destination);
      this.replace(next, this.sourceGeneration!, destination);
    } catch (error) {
      this.removeTemporaryDatabase(destination);
      throw error;
    }
  }

  private releaseObserved(): void {
    const observations = this.observations;
    const filename = this.observedDiskPath;
    this.observations = undefined;
    this.observedDiskPath = undefined;
    try { observations?.close(); }
    finally { this.removeTemporaryDatabase(filename); }
  }

  private enforceObservedBudget(): void {
    if (this.observations === undefined || this.observedDiskPath !== undefined || this.observations.allocatedBytes() <= this.maxObservedBytes) return;
    const previous = this.observations;
    let destination: string | undefined;
    try {
      destination = this.tempPath();
      this.observations = previous.copyToEphemeral(destination);
      this.observedDiskPath = destination;
      previous.close();
    } catch (error) {
      previous.close();
      this.observations = undefined;
      this.removeTemporaryDatabase(destination);
      throw new Error("Observed metadata spill failed; no partial results were returned.", { cause: error });
    }
  }

  private seed(): string | undefined {
    // Once every eligible source has been captured, this private corpus owns
    // its evidence. Persistent lexical/vector maintenance cannot make it stale;
    // the complete source scan below still reconciles each request's Markdown.
    // Keep confinement checks even when the persistent database is not read.
    assertExternalDatabasePath(this.vault, this.dbPath);
    const identity = vaultIdentity(this.vault);
    if (this.current !== undefined && identity !== undefined && this.completeVaultIdentity === identity) return identity;
    this.completeVaultIdentity = undefined;
    const token = generation(this.vault, this.dbPath);
    if (this.current !== undefined && this.sourceGeneration === token) return identity;
    // Conservatively avoid loading a large source (including vectors) into RAM.
    let large = false;
    let sourceExists = false;
    try { large = statSync(this.dbPath).size > this.maxMemoryBytes; sourceExists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (sourceExists) {
      // The source copier only knows the external database directory. Enforce
      // the actual vault boundary even when the destination core stays in RAM.
      assertExternalDatabasePath(this.vault, path.join(tmpdir(), "oms-engine-read", "snapshot.sqlite"));
    }
    const destination = large ? this.tempPath() : undefined;
    let next: DetachedLexicalStore;
    try { next = openDetachedLexicalStore(this.dbPath, destination ?? ":memory:"); }
    catch (error) { this.removeTemporaryDatabase(destination); throw error; }
    if (generation(this.vault, this.dbPath) !== token) {
      next.close();
      this.removeTemporaryDatabase(destination);
      throw new Error("LIVE_LEXICAL_SOURCE_CHANGED: the index generation changed while capturing it; retry the search.");
    }
    this.replace(next, token, destination);
    this.enforceBudget();
    return identity;
  }

  private dropProjection(docPath: string): void {
    const prior = this.projections.get(docPath);
    if (prior !== undefined) this.projectionBytes -= prior.document.retainedBytes;
    this.projections.delete(docPath);
  }

  private rememberProjection(docPath: string, sha: string, document: NodeProjectionDocument): void {
    this.dropProjection(docPath);
    // Stable admission avoids an LRU rotation rereading the whole vault on each
    // query. Oversized/excess documents are backed privately, never omitted or
    // admitted to the object cache by deserialization on subsequent requests.
    if (this.projectionBytes + document.retainedBytes > this.maxProjectionBytes) {
      this.observations ??= new AxisObservationStore(":memory:");
      this.observations.replaceLiveProjection(document, sha);
      this.enforceObservedBudget();
      return;
    }
    this.observations?.deleteLiveProjection(docPath);
    this.projections.set(docPath, { sha, document });
    this.projectionBytes += document.retainedBytes;
  }

  private async refresh(): Promise<RefreshedLexicalSource> {
    try { return await this.refreshSources(); }
    catch (error) {
      // A partial refresh never graduates from generation-checked bootstrap.
      this.completeVaultIdentity = undefined;
      // All source workers have drained before this cleanup. Other workers may
      // have repopulated backing storage after the first failed spill.
      this.releaseObserved();
      // Failed spilling must not leave an oversized memory cache that a later
      // metadata-only fast path can silently reuse. Readers have drained here.
      if (this.current !== undefined && !this.onDisk && this.current.allocatedBytes() > this.maxMemoryBytes) {
        const oversized = this.current;
        this.current = undefined;
        this.sourceGeneration = undefined;
        oversized.close();
      }
      throw error;
    }
  }

  private async refreshSources(): Promise<RefreshedLexicalSource> {
    const identity = this.seed();
    this.enforceBudget();
    const sources = this.current!.store.readDocumentSources() ?? new Map<string, DocumentSource>();
    const forceBytePaths = new Set([...sources].filter(([, source]) => source.fingerprint === null).map(([docPath]) => docPath));
    const snapshot = await scanIndexSources(this.vault, undefined, forceBytePaths);
    // listDocPaths omits zero-chunk documents, so source evidence participates too.
    const storedPaths = new Set([...this.current!.store.listDocPaths(), ...sources.keys()]);
    for (const docPath of storedPaths) {
      if (!snapshot.files.has(docPath)) {
        this.current!.store.clearDocument(docPath);
        // Ordinary refresh prunes backing only. The next observed selector
        // authoritatively reconciles EAV without invalidating unchanged rows.
        this.observations?.deleteLiveProjection(docPath);
      }
    }
    for (const docPath of this.projections.keys()) if (!snapshot.files.has(docPath)) this.dropProjection(docPath);
    this.observations?.pruneLiveProjections(snapshot.files);
    const files = new Map(snapshot.files);
    const contentSha256 = new Map<string, string>();
    const publish = (docPath: string, source: DocumentSource) => {
      files.set(docPath, source.fingerprint === null ? `bytes:${source.contentSha256}` : `metadata:${source.fingerprint}`);
      contentSha256.set(docPath, source.contentSha256);
    };
    const batch = new LexicalDocumentBatch(documents => {
      this.current!.reconcileDocuments(documents);
      for (const { docPath, source } of documents) publish(docPath, source);
    });
    const captured = await mapWithConcurrency([...snapshot.files], 32, async ([docPath, fingerprint]): Promise<
      { readonly document: NodeProjectionDocument } | { readonly error: unknown }
    > => {
      // Drain every reader before a failed refresh can release/dispose the store.
      // Promise.all's early rejection alone would leave other workers mutating it.
      try {
        const source = sources.get(docPath);
        const projection = this.projections.get(docPath);
        const sameBytes = source !== undefined && (
          (source.fingerprint !== null && `metadata:${source.fingerprint}` === fingerprint)
          || fingerprint === `bytes:${source.contentSha256}`
        );
        // Byte-mode inventory already captured and hashed the current source; it
        // can reuse the parsed projection without a redundant second body capture.
        if (sameBytes && source !== undefined && source.chunker === CHUNKER) {
          const document = projection?.sha === source.contentSha256 ? projection.document
            : this.observations?.readLiveProjection(docPath, source.contentSha256);
          if (document !== undefined) {
            contentSha256.set(docPath, source.contentSha256);
            return { document };
          }
        }
        const current = await readDocumentSource(snapshot.vault, docPath);
        const parsed = parseNote(current.content);
        const document = parseNodeProjectionDocument(docPath, current.content, false, parsed);
        this.rememberProjection(docPath, current.source.contentSha256, document);
        const chunks = chunkDocument(docPath, current.content, undefined, parsed);
        if (this.onDisk) batch.add({ docPath, source: current.source, chunks });
        else {
          // Pending FTS pages are not fully counted before commit. Preserve one
          // complete document per in-memory budget check; batch only after spill.
          this.current!.reconcileDocument(docPath, current.source, chunks);
          publish(docPath, current.source);
          this.enforceBudget();
        }
        return { document };
      } catch (error) { return { error }; }
    });
    const documents: NodeProjectionDocument[] = [];
    for (const result of captured) {
      if ("error" in result) { batch.discard(); throw result.error; }
      documents.push(result.document);
    }
    batch.flush();
    this.enforceBudget();
    if (identity !== vaultIdentity(this.vault) || snapshot.vault !== realpathSync(this.vault)) {
      throw new Error("LIVE_LEXICAL_SOURCE_CHANGED: the vault identity changed while capturing it; retry the search.");
    }
    // This marks complete capture, not freshness of a returned result or of
    // the persistent/vector index. Callers still perform final source checks.
    this.completeVaultIdentity = identity;
    const byteVerifiedPaths = new Set([...files].filter(([, token]) => token.startsWith("bytes:")).map(([docPath]) => docPath));
    return { snapshot: { vault: snapshot.vault, files, contentSha256, byteVerifiedPaths }, documents };
  }

  async prepare(vault: string, queries: readonly string[], k: number, collection?: string, selector?: LexicalSnapshotSelector): Promise<PreparedLexicalRead> {
    if (this.closed) throw new Error("Live lexical session is closed.");
    if (path.resolve(vault) !== this.vault) throw new Error("Live lexical session cannot serve another vault.");
    if (collection !== undefined) {
      const relative = path.relative(this.vault, path.resolve(this.vault, collection));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Index source collection must stay inside the vault.");
    }
    this.active++;
    try {
      if (this.refreshing === undefined) {
        this.refreshing = this.refresh();
      }
      const { snapshot, documents } = await this.refreshing;
      let selection: LexicalCandidateSelection | undefined;
      if (selector !== undefined) {
        this.observations ??= new AxisObservationStore(":memory:");
        selection = selector(snapshot, documents, this.observations);
      }
      const results = new Map<string, ScoredHit[]>();
      for (const query of queries) {
        const key = lexicalKey(query, k, collection);
        if (!results.has(key)) results.set(key, selection === undefined
          ? this.current!.store.queryLex(query, k, collection)
          : this.current!.store.queryLexCandidates!(query, k, selection.paths, collection));
      }
      const matchingPaths = selection?.discover === undefined ? undefined : queries.length === 0 ? selection.paths
        : [...new Set(queries.flatMap(query => this.current!.store.queryLexPaths!(query, selection.paths, collection)))].sort();
      const discovery = matchingPaths === undefined ? undefined : selection?.discover?.(matchingPaths);
      if (selector !== undefined) this.enforceObservedBudget();
      const unavailable = (): never => { throw new Error("A prepared lexical read cannot perform writes or vector retrieval."); };
      return {
        snapshot,
        ...(selection === undefined ? {} : { candidatePaths: [...selection.paths] }),
        ...(discovery === undefined ? {} : { discovery }),
        async nodeProjection(meta) {
          const excluded = await managedSourceExclusionMatcher(snapshot.vault, meta.source.sourcePaths ?? []);
          const admitted: NodeProjectionDocument[] = [];
          for (const document of documents) if (!(await excluded(document.docPath))) admitted.push(document);
          return projectNodeIndex(admitted, meta);
        },
        store: {
          upsert: unavailable,
          queryVec: unavailable,
          queryLex(query, width, selectedCollection) {
            const captured = results.get(lexicalKey(query, width, selectedCollection));
            if (captured === undefined) throw new Error("Lexical query was not captured in this request snapshot.");
            return captured.map(hit => ({ ...hit }));
          },
          close: () => undefined,
        },
      };
    } catch (error) {
      // Failed selectors, native capture, discovery/cursor decoding and spills
      // must not retain an over-budget EAV cache or poison an ordinary query.
      if (selector !== undefined) this.releaseObserved();
      throw error;
    } finally {
      if (--this.active === 0) {
        // Keep this generation pinned until every joined prepare has captured
        // its synchronous candidate lists. Clearing in refresh().finally() would
        // let another microtask seed/mutate the store before those continuations.
        this.refreshing = undefined;
        this.drained?.();
      }
    }
  }

  /** Useful for bounded-cache verification; never exposes the mutable store. */
  retainedStorage(): { readonly bytes: number; readonly memory: boolean; readonly projectionBytes: number; readonly projectionDocuments: number; readonly observedBytes: number; readonly observedMemory: boolean } {
    return { bytes: this.current?.allocatedBytes() ?? 0, memory: !this.onDisk, projectionBytes: this.projectionBytes, projectionDocuments: this.projections.size, observedBytes: this.observations?.allocatedBytes() ?? 0, observedMemory: this.observedDiskPath === undefined };
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      if (this.active > 0) await new Promise<void>(resolve => { this.drained = resolve; });
      try { this.current?.close(); }
      finally {
        this.current = undefined;
        this.observations?.close();
        this.observations = undefined;
        this.observedDiskPath = undefined;
        this.projections.clear();
        this.projectionBytes = 0;
        if (this.temporaryDirectory !== undefined) rmSync(this.temporaryDirectory, { recursive: true, force: true });
      }
    })();
    return this.disposal;
  }
}
