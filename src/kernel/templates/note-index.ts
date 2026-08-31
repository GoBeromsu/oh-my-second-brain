import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import { axisValueEquals, deriveTemplateRetrievalAxes } from "./axes.js";
import type { Digest, JsonValue, ResolvedConvention, TemplateId } from "./types.js";

export const TEMPLATE_NOTE_INDEX_VERSION = "oms.template-note-index.v2" as const;

export interface TemplateIndexedNote {
  readonly path: string;
  readonly signature: Digest;
  readonly templateId: TemplateId;
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface TemplateNoteIndex {
  readonly version: typeof TEMPLATE_NOTE_INDEX_VERSION;
  readonly projectionSignature: Digest;
  readonly axes: Readonly<Record<string, readonly string[]>>;
  readonly notes: readonly TemplateIndexedNote[];
  readonly unresolvedNotes: readonly { readonly path: string; readonly reason: "missing" | "non-string" | "unknown" }[];
}

export interface TemplateAxisQuery {
  readonly templateId: TemplateId;
  readonly key: string;
  readonly value: JsonValue;
}

export interface LexicalNoteMatch {
  readonly path: string;
  readonly signature: Digest;
}

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}
function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
function relativePath(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/");
  if (value === "" || value === ".." || value.startsWith("../")) fail("TEMPLATE_NOTE_SOURCE_UNSAFE", `${path} is outside the vault`);
  return value;
}
async function markdownPaths(vault: string, excluded: ReadonlySet<string>): Promise<readonly string[]> {
  const root = await realpath(vault);
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = resolve(directory, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) fail("TEMPLATE_NOTE_SOURCE_UNSAFE", `symlink ${relativePath(root, fullPath)} is not indexable`);
      if (stat.isDirectory()) await walk(fullPath);
      else if (stat.isFile() && entry.name.endsWith(".md")) {
        const path = relativePath(root, fullPath);
        if (!excluded.has(path)) paths.push(path);
      }
    }
  }
  await walk(root);
  return paths.sort((left, right) => left.localeCompare(right));
}
function validateIndex(index: unknown): TemplateNoteIndex {
  if (typeof index !== "object" || index === null || (index as { readonly version?: unknown }).version !== TEMPLATE_NOTE_INDEX_VERSION) {
    fail("TEMPLATE_NOTE_INDEX_STALE", "cache version is unknown or stale; rebuild the template note index explicitly");
  }
  const candidate = index as { readonly projectionSignature?: unknown; readonly axes?: unknown; readonly notes?: unknown; readonly unresolvedNotes?: unknown };
  if (typeof candidate.projectionSignature !== "string" || typeof candidate.axes !== "object" || candidate.axes === null || Array.isArray(candidate.axes) || !Array.isArray(candidate.notes) || !Array.isArray(candidate.unresolvedNotes)) {
    fail("TEMPLATE_NOTE_INDEX_STALE", "cache payload is invalid; rebuild the template note index explicitly");
  }
  return index as TemplateNoteIndex;
}

/** Explicit index construction. It reads note bytes but never writes a cache or vault file. */
export async function buildTemplateNoteIndex(vault: string, convention: ResolvedConvention): Promise<TemplateNoteIndex> {
  const retrievalAxes = deriveTemplateRetrievalAxes(convention);
  const excluded = new Set<string>(convention.managedSourcePaths);
  const notes: TemplateIndexedNote[] = [];
  const unresolvedNotes: Array<{ path: string; reason: "missing" | "non-string" | "unknown" }> = [];
  for (const path of await markdownPaths(vault, excluded)) {
    const bytes = await readFile(resolve(vault, path));
    const parsed = parseNote(Buffer.from(bytes).toString("utf8"));
    if (parsed.diagnostics.length > 0) fail("TEMPLATE_NOTE_SOURCE_INVALID", `${path} has invalid frontmatter`);
    const identity = parsed.frontmatter["template"];
    if (identity === undefined) { unresolvedNotes.push({ path, reason: "missing" }); continue; }
    if (typeof identity !== "string") { unresolvedNotes.push({ path, reason: "non-string" }); continue; }
    if (!Object.hasOwn(convention.templates, identity)) { unresolvedNotes.push({ path, reason: "unknown" }); continue; }
    const templateId = identity as TemplateId;
    const fields: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (!isJsonValue(value)) fail("TEMPLATE_NOTE_SOURCE_INVALID", `${path}:${key} is not a JSON-compatible frontmatter value`);
      fields[key] = value;
    }
    notes.push({ path, signature: digest(bytes), templateId, fields });
  }
  const axes = Object.fromEntries(retrievalAxes.templates.map(template => [template.templateId, template.axes.map(axis => axis.key)]));
  return { version: TEMPLATE_NOTE_INDEX_VERSION, projectionSignature: convention.inputSignature, axes, notes, unresolvedNotes };
}

/** Typed retrieval never accepts a stale projection/cache pairing. */
export function queryTemplateAxis(index: unknown, projectionSignature: Digest, query: TemplateAxisQuery): readonly TemplateIndexedNote[] {
  const current = validateIndex(index);
  if (current.projectionSignature !== projectionSignature) fail("TEMPLATE_NOTE_INDEX_STALE", "cache projection signature differs from the current resolved projection");
  const declaredAxes = current.axes[query.templateId];
  if (declaredAxes === undefined || !declaredAxes.includes(query.key)) {
    fail("TEMPLATE_AXIS_UNDECLARED_FIELD", `${query.templateId}:${query.key}`);
  }
  return current.notes
    .filter(note => note.templateId === query.templateId && axisValueEquals(note.fields[query.key], query.value))
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Byte lexical retrieval is independent of a projection and never creates an index. */
export async function queryTemplateLexically(vault: string, query: string): Promise<readonly LexicalNoteMatch[]> {
  if (query === "") return [];
  const matches: LexicalNoteMatch[] = [];
  const isExcluded = await managedSourceExclusionMatcher(vault);
  for (const path of await markdownPaths(vault, new Set())) {
    if (await isExcluded(path)) continue;
    const bytes = await readFile(resolve(vault, path));
    if (Buffer.from(bytes).toString("utf8").includes(query)) matches.push({ path, signature: digest(bytes) });
  }
  return matches;
}
