import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import { axisValueEquals, deriveTemplateRetrievalAxes } from "./axes.js";
import type { TemplateFieldAxis, TemplateIdentityAxis, TemplateRetrievalAxes, TemplateRetrievalSource } from "./axes.js";
import { digestBytes } from "./canonical.js";
import { normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import type { Digest, JsonValue, TemplateId } from "./types.js";

export const TEMPLATE_NOTE_INDEX_VERSION = "oms.template-note-index.v4" as const;


export type TemplateNoteLayer = "default" | "template" | "unresolved";

export interface TemplateIndexedNote {
  readonly path: string;
  readonly signature: Digest;
  readonly layer: TemplateNoteLayer;
  readonly templateId: TemplateId | null;
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface TemplateNoteUnresolved {
  readonly path: string;
  readonly reason: "non-string" | "unknown" | "invalid-frontmatter";
}

export interface TemplateNoteDiagnostic {
  readonly path: string;
  readonly reason: "non-json-field";
  readonly field: string;
}

export interface TemplateNoteIndex {
  readonly version: typeof TEMPLATE_NOTE_INDEX_VERSION;
  readonly generationDigest: Digest;
  readonly axes: TemplateRetrievalAxes;
  readonly notes: readonly TemplateIndexedNote[];
  readonly unresolvedNotes: readonly TemplateNoteUnresolved[];
  readonly diagnostics: readonly TemplateNoteDiagnostic[];
}

export interface TemplateAxisQuery {
  /** Null selects the default layer. Any string selects that template only. */
  readonly templateId: TemplateId | null;
  readonly key: string;
  readonly value: JsonValue;
}

export interface LexicalNoteMatch {
  readonly path: string;
  readonly signature: Digest;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors?: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const active = ancestors ?? new Set<object>();
  if (active.has(value)) return false;
  active.add(value);
  const valid = Object.values(value).every(item => isJsonValue(item, active));
  active.delete(value);
  return valid;
}

function safeRecord<T>(entries: readonly (readonly [string, T])[] = []): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? undefined : descriptor.value as T;
}

function relativePath(root: string, target: string): string {
  const value = relative(root, target);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || value.startsWith("../") || isAbsolute(value)) {
    fail("TEMPLATE_SOURCE_UNSAFE", `${target} escapes vault root`);
  }
  return value.replaceAll("\\", "/").normalize("NFC");
}

/** Registered original sources are the only index exclusions; built-in globs belong to the walkers. */
function registeredSourcePaths(snapshot: TemplateRetrievalSource): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const sourcePath of snapshot.sourcePaths ?? []) {
    if (typeof sourcePath !== "string") fail("TEMPLATE_AXIS_UNDECLARED_FIELD", "sourcePaths must contain vault-relative strings");
    excluded.add(sourcePath.normalize("NFC"));
  }
  return excluded;
}

/**
 * Ordinary markdown walk. Names starting with "." — including `.oms` drafts —
 * are not notes. Symlinks are rejected by the shared source path guard.
 */
async function markdownPaths(vault: string, excluded: ReadonlySet<string>): Promise<readonly string[]> {
  const root = await realpath(vault);
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = resolve(directory, entry.name);
      const stat = await lstat(fullPath);
      const vaultPath = relativePath(root, fullPath);
      if (stat.isSymbolicLink()) {
        if (entry.name.endsWith(".md")) await verifyTemplateSourcePath(root, normalizeTemplateSourcePath(vaultPath));
        fail("TEMPLATE_SOURCE_UNSAFE", `symlink ${vaultPath} is not allowed`);
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!stat.isFile() || !entry.name.endsWith(".md")) continue;
      const verified = await verifyTemplateSourcePath(root, normalizeTemplateSourcePath(vaultPath), { expected: "existing-file" });
      if (excluded.has(verified.vaultRelativePath)) continue;
      paths.push(verified.vaultRelativePath);
    }
  }
  await walk(root);
  return paths.sort(compareText);
}

/** Known template identities, including a registration whose rules are unavailable. */
function templateIdentities(snapshot: TemplateRetrievalSource): ReadonlySet<string> {
  const ids = new Set<string>();
  if (snapshot.templates === null) return ids;
  for (const key of Object.keys(snapshot.templates)) {
    const templateId = key.normalize("NFC");
    if (ids.has(templateId)) fail("TEMPLATE_AXIS_UNDECLARED_FIELD", `${templateId}:templateId`);
    ids.add(templateId);
  }
  return ids;
}

export type NoteTemplateIdentity =
  | { readonly layer: "default"; readonly templateId: null }
  | { readonly layer: "template"; readonly templateId: TemplateId }
  | { readonly layer: "unresolved"; readonly templateId: null; readonly reason: TemplateNoteUnresolved["reason"] };

/** Classifies explicit identity only; it never judges the note's writing contract. */
export function classifyNoteTemplateIdentity(
  frontmatter: Readonly<Record<string, unknown>>,
  templateIds: ReadonlySet<string>,
  malformed = false,
): NoteTemplateIdentity {
  if (malformed) return { layer: "unresolved", templateId: null, reason: "invalid-frontmatter" };
  if (!Object.hasOwn(frontmatter, "template")) return { layer: "default", templateId: null };
  const value = frontmatter["template"];
  if (typeof value !== "string") return { layer: "unresolved", templateId: null, reason: "non-string" };
  const id = value.normalize("NFC");
  if (!templateIds.has(id)) return { layer: "unresolved", templateId: null, reason: "unknown" };
  return { layer: "template", templateId: id as TemplateId };
}

function validateIndex(index: unknown): TemplateNoteIndex {
  if (!isMapping(index) || index.version !== TEMPLATE_NOTE_INDEX_VERSION) {
    fail("TEMPLATE_NOTE_INDEX_STALE", "cache version is unknown or stale; rebuild the template note index explicitly");
  }
  const axes = index.axes;
  if (
    typeof index.generationDigest !== "string"
    || !isMapping(axes)
    || !Array.isArray(axes.defaultAxes)
    || !Array.isArray(axes.templates)
    || !Array.isArray(axes.globalAxes)
    || !Array.isArray(index.notes)
    || !Array.isArray(index.unresolvedNotes)
    || !Array.isArray(index.diagnostics)
  ) {
    fail("TEMPLATE_NOTE_INDEX_STALE", "cache payload is invalid; rebuild the template note index explicitly");
  }
  return index as unknown as TemplateNoteIndex;
}

function declaredAxis(axes: TemplateRetrievalAxes, query: TemplateAxisQuery): TemplateIdentityAxis | TemplateFieldAxis {
  if (query.templateId === null) {
    const axis = axes.defaultAxes.find(item => item.key === query.key);
    if (axis === undefined) fail("TEMPLATE_AXIS_UNDECLARED_FIELD", `default:${query.key}`);
    return axis;
  }
  const template = axes.templates.find(item => item.templateId === query.templateId);
  const axis = query.key === "template"
    ? template?.axes.find(item => item.kind === "identity")
    : template?.axes.find(item => item.kind === "field" && item.key === query.key);
  if (template === undefined || axis === undefined) fail("TEMPLATE_AXIS_UNDECLARED_FIELD", `${query.templateId}:${query.key}`);
  return axis;
}

/**
 * Explicit index construction. It reads note bytes and writes nothing.
 * Registered `source.path` values are the only source exclusions it applies.
 */
export async function buildTemplateNoteIndex(vault: string, snapshot: TemplateRetrievalSource): Promise<TemplateNoteIndex> {
  const axes = deriveTemplateRetrievalAxes(snapshot);
  const excluded = registeredSourcePaths(snapshot);
  const templateIds = templateIdentities(snapshot);
  const notes: TemplateIndexedNote[] = [];
  const unresolvedNotes: TemplateNoteUnresolved[] = [];
  const diagnostics: TemplateNoteDiagnostic[] = [];
  for (const path of await markdownPaths(vault, excluded)) {
    const bytes = await readFile(resolve(vault, path));
    const parsed = parseNote(Buffer.from(bytes).toString("utf8"));
    const signature = digestBytes(bytes);
    const identity = classifyNoteTemplateIdentity(parsed.frontmatter, templateIds, parsed.diagnostics.length > 0);
    if (parsed.diagnostics.length > 0) {
      notes.push({ path, signature, layer: "unresolved", templateId: null, fields: safeRecord() });
      unresolvedNotes.push({ path, reason: "invalid-frontmatter" });
      continue;
    }
    const fields = safeRecord<JsonValue>();
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (!isJsonValue(value)) {
        diagnostics.push({ path, reason: "non-json-field", field: key });
        continue;
      }
      fields[key] = value;
    }
    notes.push({ path, signature, layer: identity.layer, templateId: identity.templateId, fields });
    if (identity.layer === "unresolved") unresolvedNotes.push({ path, reason: identity.reason });
  }
  const byRecord = (left: { readonly path: string; readonly field?: string; readonly reason: string }, right: { readonly path: string; readonly field?: string; readonly reason: string }): number =>
    compareText(left.path, right.path) || compareText(left.field ?? "", right.field ?? "") || compareText(left.reason, right.reason);
  return {
    version: TEMPLATE_NOTE_INDEX_VERSION,
    generationDigest: snapshot.generationDigest,
    axes,
    notes: notes.sort((left, right) => compareText(left.path, right.path)),
    unresolvedNotes: unresolvedNotes.sort(byRecord),
    diagnostics: diagnostics.sort(byRecord),
  };
}

/** Typed retrieval rejects a stale generation and any axis the resolved contracts did not declare. */
export function queryTemplateAxis(index: unknown, generationDigest: Digest, query: TemplateAxisQuery): readonly TemplateIndexedNote[] {
  const current = validateIndex(index);
  if (current.generationDigest !== generationDigest) {
    fail("TEMPLATE_NOTE_INDEX_STALE", "cache generation digest differs from the current resolved generation");
  }
  if (!isMapping(query) || typeof query.key !== "string" || !isJsonValue(query.value) || (query.templateId !== null && typeof query.templateId !== "string")) {
    fail("TEMPLATE_AXIS_UNDECLARED_FIELD", "query must name null or a template id, a declared key, and a JSON value");
  }
  const axis = declaredAxis(current.axes, query);
  return current.notes.filter(note => {
    if (query.templateId === null) return note.layer === "default" && axisValueEquals(ownValue(note.fields, query.key), query.value);
    if (note.layer !== "template" || note.templateId !== query.templateId) return false;
    if (axis.kind === "identity") return axisValueEquals(note.templateId, query.value);
    return axisValueEquals(ownValue(note.fields, query.key), query.value);
  }).sort((left, right) => compareText(left.path, right.path));
}

/**
 * Byte search is independent of the snapshot. An empty query matches nothing.
 * Source exclusion stays in managedSourceExclusionMatcher. Absent policy, invalid
 * policy, and a missing raw source do not block the search. Other helper and
 * filesystem failures propagate; this function does not switch backends.
 */
export async function queryTemplateLexically(vault: string, query: string): Promise<readonly LexicalNoteMatch[]> {
  if (query === "") return [];
  const matches: LexicalNoteMatch[] = [];
  const isExcluded = await managedSourceExclusionMatcher(vault);
  for (const path of await markdownPaths(vault, new Set())) {
    if (await isExcluded(path)) continue;
    const bytes = await readFile(resolve(vault, path));
    if (Buffer.from(bytes).toString("utf8").includes(query)) matches.push({ path, signature: digestBytes(bytes) });
  }
  return matches.sort((left, right) => compareText(left.path, right.path));
}
