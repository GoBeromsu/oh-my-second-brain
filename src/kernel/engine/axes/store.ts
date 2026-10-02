import { normalizeAxisValue, type AxisValue, type AxisValueType } from "./values.js";
export { normalizeAxisValue, type AxisValue, type AxisValueType } from "./values.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import Database from "better-sqlite3";
import { parseNote } from "../../conventions/frontmatter.js";
import { toAxisScalars } from "../graph/node.js";
import { comparable, compare, equals, type AxisScalar } from "./predicates.js";
import { observedPathQuery, type ObservedFieldFilters } from "./observed-query.js";
export type { ObservedFieldFilters } from "./observed-query.js";
import { discoverObserved, type ObservedDiscoveryOptions, type ObservedDiscoveryResult } from "./observed-discovery.js";
export type { ObservedDiscoveryOptions, ObservedDiscoveryResult } from "./observed-discovery.js";
import { engineAxisCachePath } from "../paths.js";
import { managedSourceExclusionMatcher } from "../../conventions/note-exclude.js";
import type { NodeProjectionDocument } from "../graph/builder.js";

export type AxisKind = "folder" | "field" | "link";

export interface AxisObservation {
  readonly notePath: string;
  readonly axisKind: AxisKind;
  readonly axisKey: string;
  readonly value: AxisValue;
  readonly valueType: AxisValueType;
  /** Canonical lookup value; strings are trimmed and case-folded. */
  readonly normalizedValue: string;
  readonly count: number;
}

export interface AxisObservationInput {
  readonly notePath: string;
  readonly axisKind?: AxisKind;
  readonly axisKey: string;
  readonly value: unknown;
}

export interface AxisFacet {
  readonly axisKind: AxisKind;
  readonly axisKey: string;
  readonly value: AxisValue;
  readonly valueType: AxisValueType;
  readonly normalizedValue: string;
  readonly count: number;
}

/** A parsed current-note source, shared with the live lexical snapshot. */
export interface ObservedMetadataDocument {
  readonly docPath: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** SHA-256 of the source bytes that produced this frontmatter. */
  readonly contentSha256: string;
  readonly diagnostics?: readonly string[];
}

export interface ObservedMetadataDiagnostics {
  readonly malformedNotes: number;
  readonly unsupportedFields: number;
}

interface AxisRow {
  note_path: string;
  axis_kind: AxisKind;
  axis_key: string;
  value_type: AxisValueType;
  value_json: string;
  normalized_value: string;
  count: number;
}

function isAxisKind(value: string): value is AxisKind {
  return value === "folder" || value === "field" || value === "link";
}

function canonicalAxisKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (key.length === 0) throw new Error("Axis key must be non-empty.");
  return key;
}

function flattenValue(value: unknown): AxisValue[] {
  const values: AxisValue[] = [];
  const ancestors = new Set<readonly unknown[]>();
  const stack: Array<{ readonly value: unknown; readonly exit?: true }> = [{ value }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      if (current.exit) {
        ancestors.delete(current.value);
      } else if (!ancestors.has(current.value)) {
        ancestors.add(current.value);
        stack.push({ value: current.value, exit: true });
        for (let index = current.value.length - 1; index >= 0; index--) stack.push({ value: current.value[index] });
      }
    } else if (current.value instanceof Date || typeof current.value === "string" || typeof current.value === "number" || typeof current.value === "boolean") {
      values.push(current.value);
    }
  }
  return values;
}

function decodeValue(type: AxisValueType, json: string): AxisValue {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("Axis observation contains invalid stored JSON.");
  }
  if (type === "string" && typeof value === "string") return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "date" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`Axis observation value does not match stored type ${type}.`);
}

function toObservation(row: AxisRow): AxisObservation {
  if (!isAxisKind(row.axis_kind)) throw new Error(`Axis observation has unknown kind ${row.axis_kind}.`);
  return {
    notePath: row.note_path,
    axisKind: row.axis_kind,
    axisKey: row.axis_key,
    value: decodeValue(row.value_type, row.value_json),
    valueType: row.value_type,
    normalizedValue: row.normalized_value,
    count: row.count,
  };
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS axis_observation (
    note_path TEXT NOT NULL,
    axis_kind TEXT NOT NULL CHECK (axis_kind IN ('folder', 'field', 'link')),
    axis_key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'date')),
    value_json TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
    PRIMARY KEY (note_path, axis_kind, axis_key, value_type, normalized_value)
  );
  CREATE INDEX IF NOT EXISTS axis_observation_lookup
    ON axis_observation (axis_kind, axis_key, normalized_value);
  CREATE TABLE IF NOT EXISTS axis_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_signature TEXT NOT NULL
  );
`;

// Private live-session backing only, never normalized/reconstructed from EAV.
// Bump when the compact projection contract or its interpretation changes.
const LIVE_PROJECTION_VERSION = 1;
const CREATE_LIVE_PROJECTION_SCHEMA = `
  CREATE TABLE live_projection (
    note_path TEXT PRIMARY KEY,
    content_sha256 TEXT NOT NULL,
    version INTEGER NOT NULL,
    document BLOB NOT NULL
  );
`;

function isLiveProjection(value: unknown, notePath: string): value is NodeProjectionDocument {
  if (value === null || typeof value !== "object") return false;
  const document = value as Partial<NodeProjectionDocument>;
  const strings = (items: unknown): boolean => Array.isArray(items) && items.every(item => typeof item === "string");
  return document.docPath === notePath && document.frontmatter !== null && typeof document.frontmatter === "object"
    && !Array.isArray(document.frontmatter) && strings(document.diagnostics) && strings(document.links)
    && strings(document.lexicalTerms) && typeof document.bodyPreview === "string"
    && Number.isSafeInteger(document.retainedBytes) && document.retainedBytes! >= 0;
}

/** Dedicated EAV repository; never shares the embedding engine database. */
export class AxisObservationStore {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private closed = false;
  private transactionDepth = 0;
  private readonly cursorIdentity = randomUUID();
  private observationVersion = 0;
  private observedSnapshotReady = false;
  private observedSnapshotStorage: boolean;
  private liveProjectionStorage = false;
  private observedSources = new Map<string, string>();
  private observedDiagnostics: ObservedMetadataDiagnostics = { malformedNotes: 0, unsupportedFields: 0 };

  constructor(dbPath: string, options: { readonly readonly?: boolean; readonly readOnly?: boolean } = {}) {
    this.dbPath = dbPath;
    this.observedSnapshotStorage = dbPath === ":memory:";
    if (options.readonly === true || options.readOnly === true) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } else {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      if (dbPath === ":memory:") this.db.pragma("temp_store = MEMORY");
      this.db.exec(CREATE_SCHEMA);
    }
    // These deterministic helpers share declared-axis scalar semantics. The
    // observed range alone skips incomparable mixed-list members rather than
    // throwing away an otherwise valid lexical note.
    const scalar = (type: string, json: string): AxisScalar => {
      const value = decodeValue(type as AxisValueType, json);
      return value instanceof Date ? value.toISOString() : value;
    };
    const parsedParams = new Map<string, unknown>();
    const parameter = (json: string): unknown => {
      if (parsedParams.has(json)) return parsedParams.get(json);
      const parsed = JSON.parse(json) as unknown;
      if (parsedParams.size >= 128) parsedParams.clear();
      parsedParams.set(json, parsed);
      return parsed;
    };
    this.db.function("oms_axis_any", { deterministic: true }, (type: string, json: string, expected: string) => {
      const value = scalar(type, json);
      return (parameter(expected) as readonly AxisScalar[]).some(item => equals(value, item)) ? 1 : 0;
    });
    this.db.function("oms_axis_compare", { deterministic: true }, (type: string, json: string, expected: string) => {
      const value = scalar(type, json);
      const boundary = parameter(expected) as AxisScalar;
      return typeof comparable(value) === typeof comparable(boundary) ? compare(value, boundary) : null;
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Axis observation store is closed.");
  }

  /** Preserve the original compact projection, including cycles, Date and UTF-16. */
  replaceLiveProjection(document: NodeProjectionDocument, contentSha256: string): void {
    this.ensureOpen();
    if (!this.observedSnapshotStorage) throw new Error("Live projections require an in-memory or session-private ephemeral axis store.");
    if (!this.liveProjectionStorage) {
      this.db.exec(CREATE_LIVE_PROJECTION_SCHEMA);
      this.liveProjectionStorage = true;
    }
    this.db.prepare(`INSERT INTO live_projection (note_path, content_sha256, version, document) VALUES (?, ?, ?, ?)
      ON CONFLICT(note_path) DO UPDATE SET content_sha256 = excluded.content_sha256, version = excluded.version, document = excluded.document`)
      .run(document.docPath, contentSha256, LIVE_PROJECTION_VERSION, serialize(document));
  }

  /** A missing, incompatible or damaged row is a recapture, never a missing note. */
  readLiveProjection(notePath: string, contentSha256: string): NodeProjectionDocument | undefined {
    this.ensureOpen();
    if (!this.liveProjectionStorage) return undefined;
    const row = this.db.prepare("SELECT document FROM live_projection WHERE note_path = ? AND content_sha256 = ? AND version = ?")
      .get(notePath, contentSha256, LIVE_PROJECTION_VERSION) as { document: Buffer } | undefined;
    if (row === undefined) return undefined;
    try {
      const document: unknown = deserialize(row.document);
      return isLiveProjection(document, notePath) ? document : undefined;
    } catch { return undefined; }
  }

  deleteLiveProjection(notePath: string): void {
    this.ensureOpen();
    if (this.liveProjectionStorage) this.db.prepare("DELETE FROM live_projection WHERE note_path = ?").run(notePath);
  }

  /** Backing only; canonical EAV stays at its last explicitly reconciled snapshot. */
  pruneLiveProjections(includedPaths: ReadonlyMap<string, unknown>): void {
    this.ensureOpen();
    if (!this.liveProjectionStorage) return;
    const rows = this.db.prepare("SELECT note_path FROM live_projection").all() as Array<{ note_path: string }>;
    this.runInTransaction(() => {
      for (const row of rows) if (!includedPaths.has(row.note_path)) this.deleteLiveProjection(row.note_path);
    });
  }

  /**
   * Run a group of writes as one rollback-safe publication. Nested writes from
   * record/replaceNote participate in the outer transaction rather than
   * attempting to open a second SQLite transaction.
   */
  runInTransaction<T>(fn: () => T): T {
    this.ensureOpen();
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth += 1;
    try {
      return this.db.transaction(fn)();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private insertValues(
    notePath: string,
    axisKind: AxisKind,
    axisKey: string,
    value: unknown,
    statement: Database.Statement<unknown[]>,
  ): void {
    for (const original of flattenValue(value)) {
      // An empty or whitespace-only string carries no axis information, so
      // it is dropped exactly like the null/undefined that flattenValue
      // already discards. `field: ""` is a normal "declared but unset"
      // frontmatter state, not vault corruption; it must not abort the
      // whole vault scan.
      if (typeof original === "string" && original.trim().length === 0) continue;
      let normalized: ReturnType<typeof normalizeAxisValue>;
      try {
        normalized = normalizeAxisValue(original);
      } catch (error) {
        // canonicalScalar's own errors carry no note path, which makes them
        // undiagnosable from the message alone during a whole-vault scan.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${notePath}: ${message}`, { cause: error });
      }
      statement.run(notePath, axisKind, axisKey, normalized.type, JSON.stringify(normalized.value), normalized.normalizedValue);
    }
  }

  /**
   * Reconcile an in-memory observed-field projection from an already parsed
   * current-note snapshot. This never scans the vault or opens a disk cache.
   * Malformed/unsupported metadata stays diagnostic; it cannot remove the
   * note from the separate lexical snapshot. Values retain the EAV store's
   * canonical trimmed/lowercase spelling, never an invented display spelling.
   */
  reconcileObservedSnapshot(
    documents: readonly ObservedMetadataDocument[],
    sourceSignature: string,
  ): ObservedMetadataDiagnostics {
    this.ensureOpen();
    if (!this.observedSnapshotStorage) throw new Error("Observed search snapshots require an in-memory or session-private ephemeral axis store.");
    if (this.observedSnapshotReady && sourceSignature === this.sourceSignature()) return this.observedDiagnostics;
    const previousSources = this.observedSnapshotReady ? this.observedSources : new Map<string, string>();
    const previousPaths = this.observedSnapshotReady ? [...this.observedSources.keys()] : (this.db.prepare("SELECT DISTINCT note_path FROM axis_observation").all() as Array<{ note_path: string }>).map(row => row.note_path);
    const nextSources = new Map<string, string>();
    const replacements: Array<{ readonly path: string; readonly fields: Readonly<Record<string, unknown>> }> = [];
    let malformedNotes = 0;
    let unsupportedFields = 0;
    for (const document of documents) {
      if (nextSources.has(document.docPath)) throw new Error("Observed source snapshot contains duplicate note paths.");
      nextSources.set(document.docPath, document.contentSha256);
      const fields = Object.create(null) as Record<string, unknown>;
      if ((document.diagnostics?.length ?? 0) > 0) {
        malformedNotes++;
      } else {
        for (const [key, value] of Object.entries(document.frontmatter)) {
          if (!key.trim()) {
            unsupportedFields++;
            continue;
          }
          const converted = toAxisScalars(value);
          if (!converted.supported) unsupportedFields++;
          fields[key] = converted.values;
        }
      }
      if (previousSources.get(document.docPath) !== document.contentSha256) replacements.push({ path: document.docPath, fields });
    }
    this.runInTransaction(() => {
      for (const replacement of replacements) this.replaceNote(replacement.path, replacement.fields);
      for (const priorPath of previousPaths) if (!nextSources.has(priorPath)) this.deleteNote(priorPath);
      this.setSourceSignature(sourceSignature);
    });
    this.observedSnapshotReady = true;
    this.observedSources = nextSources;
    this.observedDiagnostics = { malformedNotes, unsupportedFields };
    return this.observedDiagnostics;
  }

  /** Source signature of the markdown set used for the last reconciliation. */
  sourceSignature(): string | null {
    this.ensureOpen();
    const row = this.db.prepare("SELECT source_signature FROM axis_meta WHERE id = 1").get() as { source_signature?: string } | undefined;
    return row?.source_signature ?? null;
  }

  setSourceSignature(signature: string): void {
    this.ensureOpen();
    this.db.prepare("INSERT INTO axis_meta (id, source_signature) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET source_signature = excluded.source_signature").run(signature);
    this.observationVersion++;
    this.observedSnapshotReady = false;
  }

  /** Record one scalar or every scalar in a frontmatter list. */
  record(input: AxisObservationInput): void {
    this.ensureOpen();
    const axisKind = input.axisKind ?? "field";
    if (!isAxisKind(axisKind)) throw new Error(`Unknown axis kind ${String(axisKind)}.`);
    const axisKey = canonicalAxisKey(input.axisKey);
    const values = flattenValue(input.value);
    const statement = this.db.prepare(`
      INSERT INTO axis_observation
        (note_path, axis_kind, axis_key, value_type, value_json, normalized_value, count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(note_path, axis_kind, axis_key, value_type, normalized_value)
      DO UPDATE SET count = axis_observation.count + 1
    `);
    this.runInTransaction(() => {
      for (const value of values) this.insertValues(input.notePath, axisKind, axisKey, value, statement);
    });
    this.observationVersion++;
    this.observedSnapshotReady = false;
  }

  /** Remove all observations for a note, then atomically replace them. */
  replaceNote(notePath: string, fields: Readonly<Record<string, unknown>>, options: { readonly folder?: string; readonly links?: readonly string[] } = {}): void {
    this.ensureOpen();
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM axis_observation WHERE note_path = ?").run(notePath);
      const statement = this.db.prepare(`
        INSERT INTO axis_observation
          (note_path, axis_kind, axis_key, value_type, value_json, normalized_value, count)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(note_path, axis_kind, axis_key, value_type, normalized_value)
        DO UPDATE SET count = 1
      `);
      if (options.folder !== undefined) this.insertValues(notePath, "folder", "folder", options.folder, statement);
      for (const [axisKey, value] of Object.entries(fields)) {
        this.insertValues(notePath, "field", canonicalAxisKey(axisKey), value, statement);
      }
      for (const link of options.links ?? []) this.insertValues(notePath, "link", "link", link, statement);
    });
    this.observationVersion++;
    this.observedSnapshotReady = false;
  }

  /** Delete stale observations when a markdown note is removed. */
  deleteNote(notePath: string): void {
    this.ensureOpen();
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM axis_observation WHERE note_path = ?").run(notePath);
      this.deleteLiveProjection(notePath);
    });
    this.observationVersion++;
    this.observedSnapshotReady = false;
  }

  list(options: { readonly axisKind?: AxisKind; readonly axisKey?: string; readonly notePath?: string } = {}): AxisObservation[] {
    this.ensureOpen();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.axisKind !== undefined) {
      if (!isAxisKind(options.axisKind)) throw new Error(`Unknown axis kind ${String(options.axisKind)}.`);
      clauses.push("axis_kind = ?");
      params.push(options.axisKind);
    }
    if (options.axisKey !== undefined) {
      clauses.push("axis_key = ?");
      params.push(canonicalAxisKey(options.axisKey));
    }
    if (options.notePath !== undefined) {
      clauses.push("note_path = ?");
      params.push(options.notePath);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.prepare(
      `SELECT note_path, axis_kind, axis_key, value_type, value_json, normalized_value, count
       FROM axis_observation${where}
       ORDER BY note_path, axis_kind, axis_key, normalized_value`,
    ).all(...params) as AxisRow[];
    return rows.map(toObservation);
  }

  /** Current observed-field candidates, ready to intersect native FTS before its limit. */
  matchObservedFields(fields: ObservedFieldFilters, candidatePaths?: readonly string[]): string[] {
    this.ensureOpen();
    const query = observedPathQuery(fields, candidatePaths ?? (this.observedSnapshotReady ? [...this.observedSources.keys()] : undefined));
    const rows = this.db.prepare(query.sql).all(...query.params) as Array<{ note_path: string }>;
    return rows.map(row => row.note_path);
  }

  /** Explicit bounded discovery; never returns the full metadata vocabulary. */
  discoverObservedFields(options: ObservedDiscoveryOptions = {}): ObservedDiscoveryResult {
    this.ensureOpen();
    return discoverObserved(this.db, options, this.observedSnapshotReady ? `observed-v1:${this.sourceSignature()}` : `${this.cursorIdentity}:${this.observationVersion}`, decodeValue);
  }

  /** Aggregate facets before any result limit is applied. */
  facets(options: { readonly axisKind?: AxisKind; readonly axisKey?: string } = {}): AxisFacet[] {
    const observations = this.list(options);
    const grouped = new Map<string, AxisFacet>();
    for (const observation of observations) {
      const id = `${observation.axisKind}\0${observation.axisKey}\0${observation.valueType}\0${observation.normalizedValue}`;
      const prior = grouped.get(id);
      if (prior === undefined) {
        grouped.set(id, {
          axisKind: observation.axisKind,
          axisKey: observation.axisKey,
          value: observation.value,
          valueType: observation.valueType,
          normalizedValue: observation.normalizedValue,
          count: observation.count,
        });
      } else {
        grouped.set(id, { ...prior, count: prior.count + observation.count });
      }
    }
    return [...grouped.values()].sort((left, right) =>
      left.axisKind.localeCompare(right.axisKind) || left.axisKey.localeCompare(right.axisKey) || left.normalizedValue.localeCompare(right.normalizedValue),
    );
  }

  count(options: { readonly axisKind?: AxisKind; readonly axisKey?: string } = {}): number {
    return this.list(options).reduce((sum, row) => sum + row.count, 0);
  }

  /**
   * Spill this complete projection into a caller-owned disposable destination.
   * The live owner validates its external path and removes it on failure/close.
   * VACUUM INTO copies pages without a JavaScript-sized serialized DB buffer.
   */
  copyToEphemeral(destination: string): AxisObservationStore {
    this.ensureOpen();
    this.db.prepare("VACUUM INTO ?").run(destination);
    const copied = new AxisObservationStore(destination);
    copied.observedSnapshotStorage = true;
    copied.liveProjectionStorage = this.liveProjectionStorage;
    copied.observedSources = new Map(this.observedSources);
    copied.observedDiagnostics = this.observedDiagnostics;
    copied.observedSnapshotReady = this.observedSnapshotReady;
    copied.observationVersion = this.observationVersion;
    return copied;
  }

  /** Retained SQLite page allocation for the live session's memory budget. */
  allocatedBytes(): number {
    this.ensureOpen();
    return Number(this.db.pragma("page_count", { simple: true })) * Number(this.db.pragma("page_size", { simple: true }));
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export const openAxisStore = (
  dbPath: string,
  options: { readonly readonly?: boolean; readonly readOnly?: boolean } = {},
): AxisObservationStore => new AxisObservationStore(dbPath, options);

export function axisStorePath(vault: string): string {
  return engineAxisCachePath(vault);
}

export function openVaultAxisStore(
  vault: string,
  options: { readonly readonly?: boolean; readonly readOnly?: boolean } = {},
): AxisObservationStore {
  return new AxisObservationStore(axisStorePath(vault), options);
}

function firstFolder(notePath: string): string | undefined {
  const slash = notePath.indexOf("/");
  return slash > 0 ? notePath.slice(0, slash) : undefined;
}

function extractLinks(body: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/gu;
  for (const match of body.matchAll(pattern)) {
    const target = match[1]?.trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

const AXIS_SKIP_DIRS = new Set([
  ".oms",
  ".obsidian",
  ".trash",
  ".git",
  ".claude",
  "_archive",
  "node_modules",
]);

function ensureInsideVault(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured vault root.`);
  }
}

/**
 * Strict scanner for EAV reconciliation. The shared convention walker is
 * intentionally permissive for linting, but a persisted derived snapshot
 * must fail when a directory/file disappears or a symlink leaves the vault.
 */
async function* walkVaultMarkdownStrict(
  dir: string,
  base: string,
  isExcluded: (notePath: string) => Promise<boolean>,
  rootRealPath?: string,
  visitedDirectories: Set<string> = new Set(),
): AsyncGenerator<string> {
  const root = rootRealPath ?? await realpath(base);
  const realDir = await realpath(dir);
  ensureInsideVault(root, realDir, `Vault directory "${dir}"`);
  if (visitedDirectories.has(realDir)) return;
  visitedDirectories.add(realDir);

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const realEntry = await realpath(fullPath);
    ensureInsideVault(root, realEntry, `Vault entry "${fullPath}"`);
    if (AXIS_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const entryStat = await stat(fullPath);
    if (entryStat.isDirectory()) {
      yield* walkVaultMarkdownStrict(fullPath, base, isExcluded, root, visitedDirectories);
    } else if (entryStat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const notePath = path.relative(base, fullPath).replace(/\\/g, "/");
      // Contract-excluded non-notes (template sources above all) never enter
      // the EAV scan: their frontmatter is intentionally not valid YAML.
      if (!(await isExcluded(notePath))) yield notePath;
    }
  }
}

/** Scan markdown into the dedicated EAV cache. Malformed YAML is loud. */
export async function collectVaultAxisObservations(
  vault: string,
  suppliedStore?: AxisObservationStore,
): Promise<AxisObservationStore> {
  const ownsStore = suppliedStore === undefined;
  let store = suppliedStore;
  const liveNotes = new Set<string>();
  const sourceFiles = new Map<string, Buffer>();
  const parsedNotes: Array<{
    notePath: string;
    parsed: ReturnType<typeof parseNote>;
  }> = [];
  try {
    const isExcluded = await managedSourceExclusionMatcher(vault);
    // Read and parse the complete source set before touching the existing
    // snapshot. This keeps read/parse failures from exposing a partial scan.
    for await (const notePath of walkVaultMarkdownStrict(vault, vault, isExcluded)) {
      const raw = await readFile(path.join(vault, notePath), "utf-8");
      sourceFiles.set(notePath, Buffer.from(raw, "utf8"));
      const parsed = parseNote(raw);
      if (parsed.diagnostics.length > 0) {
        throw new Error(`${notePath}: malformed frontmatter (${parsed.diagnostics.map((item) => item.message).join("; ")})`);
      }
      liveNotes.add(notePath);
      parsedNotes.push({ notePath, parsed });
    }

    const digest = createHash("sha256");
    for (const notePath of [...sourceFiles.keys()].sort()) {
      digest.update(notePath);
      digest.update("\0");
      digest.update(sourceFiles.get(notePath)!);
      digest.update("\0");
    }
    // Do not create or open the derived database until the complete source
    // scan has succeeded. A failed first scan must not publish an empty cache.
    if (store === undefined) {
      await ensureAxisStoreDirectory(vault);
      store = openVaultAxisStore(vault);
    }
    const activeStore = store;
    activeStore.runInTransaction(() => {
      for (const { notePath, parsed } of parsedNotes) {
        activeStore.replaceNote(notePath, parsed.frontmatter, {
          folder: firstFolder(notePath),
          links: extractLinks(parsed.body),
        });
      }

      // A scan is a reconciliation, not an append-only import. Remove rows
      // for notes that were present in an earlier snapshot but no longer
      // exist.
      const staleNotes = new Set(activeStore.list().map((observation) => observation.notePath));
      for (const notePath of staleNotes) {
        if (!liveNotes.has(notePath)) activeStore.deleteNote(notePath);
      }
      activeStore.setSourceSignature(digest.digest("hex"));
    });
    return activeStore;
  } catch (error) {
    if (ownsStore) store?.close();
    throw error;
  }
}

// `mkdir` is intentionally kept in the module so callers can create an empty
// cache path without touching the embedding engine store.
export async function ensureAxisStoreDirectory(vault: string): Promise<void> {
  await mkdir(path.dirname(axisStorePath(vault)), { recursive: true });
}
