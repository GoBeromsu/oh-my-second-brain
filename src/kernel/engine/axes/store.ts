import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { parseNote } from "../../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../../conventions/note-exclude.js";

export type AxisKind = "folder" | "field" | "link";
export type AxisValueType = "string" | "number" | "boolean" | "date";
export type AxisValue = string | number | boolean | Date;

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

function scalarType(value: AxisValue): AxisValueType {
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function canonicalScalar(value: AxisValue): AxisValue {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Axis date value must be valid.");
    return value.toISOString();
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) throw new Error("Axis string value must be non-empty.");
    return normalized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Axis number value must be finite.");
    return value;
  }
  return value;
}

function flattenValue(value: unknown): AxisValue[] {
  if (Array.isArray(value)) return value.flatMap(flattenValue);
  if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [value];
  }
  if (value === null || value === undefined) return [];
  return [];
}

function normalizedLookup(value: AxisValue, type: AxisValueType): string {
  if (type === "date") return (value instanceof Date ? value.toISOString() : String(value)).toLowerCase();
  return String(value).trim().toLowerCase();
}

export function normalizeAxisValue(value: AxisValue): { readonly value: AxisValue; readonly type: AxisValueType; readonly normalizedValue: string } {
  const canonical = canonicalScalar(value);
  const type = scalarType(value);
  return { value: canonical, type, normalizedValue: normalizedLookup(canonical, type) };
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

/** Dedicated EAV repository; never shares the embedding engine database. */
export class AxisObservationStore {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private closed = false;
  private transactionDepth = 0;

  constructor(dbPath: string, options: { readonly readonly?: boolean; readonly readOnly?: boolean } = {}) {
    this.dbPath = dbPath;
    if (options.readonly === true || options.readOnly === true) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } else {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(CREATE_SCHEMA);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Axis observation store is closed.");
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

  /** Source signature of the markdown set used for the last reconciliation. */
  sourceSignature(): string | null {
    this.ensureOpen();
    const row = this.db.prepare("SELECT source_signature FROM axis_meta WHERE id = 1").get() as { source_signature?: string } | undefined;
    return row?.source_signature ?? null;
  }

  setSourceSignature(signature: string): void {
    this.ensureOpen();
    this.db.prepare("INSERT INTO axis_meta (id, source_signature) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET source_signature = excluded.source_signature").run(signature);
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
  }

  /** Delete stale observations when a markdown note is removed. */
  deleteNote(notePath: string): void {
    this.ensureOpen();
    this.db.prepare("DELETE FROM axis_observation WHERE note_path = ?").run(notePath);
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
  return path.resolve(vault, ".oms", "cache", "axes.sqlite");
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
  isExcluded: (notePath: string) => boolean,
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
      // Taxonomy-declared non-notes (template sources above all) never enter
      // the EAV scan: their frontmatter is intentionally not valid YAML.
      if (!isExcluded(notePath)) yield notePath;
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
    const isExcluded = await excludedNoteMatcher(vault);
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
