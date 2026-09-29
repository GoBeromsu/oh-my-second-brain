import { isDeepStrictEqual } from "node:util";
import { type Document, isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import { propertyKinds, singleValued, stringTyped } from "../contract/judge.js";
import type { FieldType, JsonScalar, PropertyContract, VaultContract, Violation, ViolationKind } from "../contract/types.js";

/**
 * Lossless fixes: a warning is fixed only when the fixed value carries everything the
 * written value did and no other reading exists. Anything else is saved as written.
 *
 * - `type`: `"12"` → `12` for a number, `"true"`/`"false"` → a boolean, a scalar → a
 *   one-item list for a list type, `YYYY-MM-DDT00:00` → `YYYY-MM-DD` for a date, a number
 *   → its string for a text type.
 * - `not-allowed`: a value that NFC + trim + case-fold matches exactly one allowed value.
 * - `missing`: a required property whose rule fixes its only value, or an unconstrained
 *   date or datetime default on a new note.
 *
 * A fix is kept only when the judge no longer reports the kind it was made for. This
 * module never judges a whole note and never writes; the caller rejudges the result.
 */

export interface CoerceOptions {
  readonly contract: VaultContract;
  /** True when the target does not exist yet; only a new note gets a date default. */
  readonly isNew: boolean;
  /** The time a date default takes; without it no date is filled. */
  readonly now?: Date | undefined;
}

export interface CoerceResult {
  readonly content: string;
  /** One `{field, kind}` per fixed warning. */
  readonly fixes: readonly Violation[];
}

const FIXABLE: ReadonlySet<ViolationKind> = new Set(["type", "not-allowed", "missing"]);
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?$/;

type Fix = { readonly value: unknown } | null;

function fixed(value: unknown): Fix {
  return { value };
}

function scalar(value: unknown): value is JsonScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function fixType(value: unknown, written: unknown, type: FieldType): Fix {
  if (type === "number") return typeof value === "string" && String(Number(value)) === value && Number.isFinite(Number(value)) ? fixed(Number(value)) : null;
  if (type === "boolean" || type === "checkbox") return value === "true" || value === "false" ? fixed(value === "true") : null;
  if (type === "date") {
    const match = typeof value === "string" ? MIDNIGHT.exec(value) : null;
    return match === null ? null : fixed(match[1]);
  }
  // `written` is the source text of the value: a number fixes to text only when it spells no more than its value.
  if (stringTyped(type)) return typeof value === "number" && Number.isFinite(value) && typeof written === "number" ? fixed(String(value)) : null;
  if (!singleValued(type)) return value !== null && scalar(value) && isDeepStrictEqual(value, written) ? fixed([value]) : null;
  return null;
}

function spelling(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

/** The one allowed value a member spells, or undefined when none or several match. */
function allowedSpelling(member: unknown, allowed: readonly JsonScalar[]): JsonScalar | undefined {
  if (allowed.some(candidate => typeof member === "string" && typeof candidate === "string" ? member.normalize("NFC") === candidate.normalize("NFC") : member === candidate)) return member as JsonScalar;
  if (typeof member !== "string") return undefined;
  const matches = new Set(allowed.filter((candidate): candidate is string => typeof candidate === "string" && spelling(candidate) === spelling(member)));
  return matches.size === 1 ? [...matches][0] : undefined;
}

function fixAllowed(value: unknown, property: PropertyContract): Fix {
  let current = value;
  for (const rule of property.rules) {
    if (rule.kind !== "allowed") continue;
    const members = Array.isArray(current) ? current : [current];
    const spelled = members.map(member => allowedSpelling(member, rule.values));
    if (spelled.some(member => member === undefined)) return null;
    current = Array.isArray(current) ? spelled : spelled[0];
  }
  return current === value ? null : fixed(current);
}

function dateNow(type: FieldType, now: Date): string | null {
  const pad = (part: number) => String(part).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (type === "date") return date;
  if (type === "datetime") return `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return null;
}

function fixMissing(property: PropertyContract, options: CoerceOptions): Fix {
  const rule = property.rules.find(candidate => candidate.kind === "fixed");
  if (rule !== undefined) return fixed(listTyped(property.type) ? [rule.value] : rule.value);
  if (!options.isNew || options.now === undefined || !property.default || property.rules.length > 0) return null;
  const date = dateNow(property.type, options.now);
  return date === null ? null : fixed(date);
}

/** True only for a known list type; an untyped property takes a fixed value as a single value. */
export function listTyped(type: FieldType | null): boolean {
  return type !== null && !singleValued(type);
}

function fixFor(warning: Violation, value: unknown, written: unknown, property: PropertyContract, options: CoerceOptions): Fix {
  switch (warning.kind) {
    case "type": return fixType(value, written, property.type);
    case "not-allowed": return fixAllowed(value, property);
    case "missing": return fixMissing(property, options);
    default: return null;
  }
}

/** A filled value must meet every rule; a changed value must only clear the kind it was changed for. */
function clears(kind: ViolationKind, remaining: readonly ViolationKind[]): boolean {
  return kind === "missing" ? remaining.length === 0 : !remaining.includes(kind);
}

/** A written scalar a fix may replace in place: no tag, no anchor, not a block scalar. */
function spliceable(node: unknown): node is Scalar {
  return isScalar(node) && node.tag === undefined && node.anchor === undefined && node.range !== undefined && node.range !== null
    && (node.type === "PLAIN" || node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE");
}

/** True when `text` reads back as `value` in a block (`key: text`) or flow (`[text]`) position. */
function readsAs(text: string, value: unknown, flow: boolean): boolean {
  const document = parseDocument(flow ? `k: [${text}]` : `k: ${text}`);
  if (document.errors.length > 0) return false;
  const read = (document.toJS() as { k?: unknown } | null)?.k;
  return isDeepStrictEqual(flow ? (Array.isArray(read) && read.length === 1 ? read[0] : undefined) : read, value);
}

/** YAML text for a scalar: the written quote style for a string when it reads back, otherwise double quotes. */
function render(value: JsonScalar, style: Scalar["type"], flow: boolean): string | null {
  const candidates = typeof value !== "string" ? [String(value)]
    : style === "QUOTE_SINGLE" ? [`'${value.replace(/'/g, "''")}'`, JSON.stringify(value)]
    : style === "QUOTE_DOUBLE" ? [JSON.stringify(value)]
    : [value, JSON.stringify(value)];
  return candidates.find(text => readsAs(text, value, flow)) ?? null;
}

function renderList(values: readonly unknown[]): string | null {
  const members = values.map(member => scalar(member) ? render(member, "PLAIN", true) : null);
  return members.some(member => member === null) ? null : `[${members.join(", ")}]`;
}

function renderValue(value: unknown, style: Scalar["type"]): string | null {
  if (Array.isArray(value)) return renderList(value);
  return scalar(value) ? render(value, style, false) : null;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The edits that set one field, or null when its written node cannot be replaced in place. */
function fieldEdits(document: Document, key: string, value: unknown): readonly Edit[] | null {
  const map = document.contents;
  const pair = isMap(map) ? map.items.find(item => isScalar(item.key) && item.key.value === key) : undefined;
  const node = pair?.value;
  if (isSeq(node) && Array.isArray(value) && node.items.length === value.length) {
    // A list whose members changed: each member is replaced where it is written.
    const edits: Edit[] = [];
    for (const [index, item] of node.items.entries()) {
      if (isDeepStrictEqual((item as { toJSON?: () => unknown }).toJSON?.(), value[index])) continue;
      if (!spliceable(item) || !scalar(value[index])) return null;
      const text = render(value[index], item.type, node.flow === true);
      if (text === null) return null;
      edits.push({ start: item.range![0], end: item.range![1], text });
    }
    return edits;
  }
  if (!spliceable(node)) return null;
  const text = renderValue(value, node.type);
  if (text === null) return null;
  const [start, end] = node.range!;
  // `key:` with nothing after it: the value goes after the colon.
  return [{ start, end, text: node.source === "" ? ` ${text}` : text }];
}

/** The line break an empty block (`---` straight after `---`) needs before its closing fence. */
export function closingBreak(content: string, end: number, eol: string): string {
  return /^\r?\n/.test(content.slice(end)) ? "" : eol;
}

function keyText(key: string): string {
  return readsAs(key, key, false) && !/[:#]/.test(key) ? key : JSON.stringify(key);
}

/**
 * `content` with each field set to its fixed value. Only the bytes of a fixed value (or
 * an added line for a missing key) change; every other key, the body and the line
 * endings stay byte for byte as written. A value that cannot be replaced in place (a tag,
 * an anchor, a block scalar) is left out of `applied`. Null when nothing applies or the
 * result would not read back as exactly the intended frontmatter.
 */
function setFrontmatter(content: string, values: ReadonlyMap<string, unknown>, written: Readonly<Record<string, unknown>>): { readonly content: string; readonly applied: ReadonlySet<string> } | null {
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return null;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const added: string[] = [];
  const edits: Edit[] = [];
  const applied = new Set(values.keys());
  const document = parseDocument(parsed.frontmatterRaw, { uniqueKeys: true });
  if (document.contents !== null && !isMap(document.contents)) return null;
  for (const [key, value] of values) {
    if (!Object.hasOwn(written, key)) {
      const text = renderValue(value, "PLAIN");
      if (text === null) return null;
      added.push(`${keyText(key)}: ${text}`);
      continue;
    }
    const fieldEdit = fieldEdits(document, key, value);
    if (fieldEdit === null) {
      // A tagged, anchored or block value is kept as written; the other fixes still apply.
      applied.delete(key);
      continue;
    }
    edits.push(...fieldEdit);
  }
  if (applied.size === 0) return null;
  let yaml = parsed.frontmatterRaw;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    yaml = `${yaml.slice(0, edit.start)}${edit.text}${yaml.slice(edit.end)}`;
  }
  if (added.length > 0) yaml = yaml.trim() === "" ? added.join(eol) : `${yaml}${eol}${added.join(eol)}`;
  const next = parsed.frontmatterRange === null
    ? `---${eol}${yaml}${eol}---${eol}${content}`
    : `${content.slice(0, parsed.frontmatterRange.start)}${yaml}${closingBreak(content, parsed.frontmatterRange.end, eol)}${content.slice(parsed.frontmatterRange.end)}`;
  const reread = parseNote(next);
  const expected = { ...written, ...Object.fromEntries([...values].filter(([key]) => applied.has(key))) };
  return reread.diagnostics.length === 0 && isDeepStrictEqual(reread.frontmatter, expected) ? { content: next, applied } : null;
}

/**
 * The frontmatter as written: a plain number whose source spells more than its value
 * (`01234`, `1.0`, `0x1F`, an integer past 2^53) is given as its source text, so a
 * recorded gap keeps what the writer wrote.
 */
export function writtenValues(content: string): Readonly<Record<string, unknown>> {
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return parsed.frontmatter;
  const document = parseDocument(parsed.frontmatterRaw, { uniqueKeys: true });
  const values: Record<string, unknown> = { ...parsed.frontmatter };
  if (!isMap(document.contents)) return values;
  for (const pair of document.contents.items) {
    const node = pair.value;
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isScalar(node) || typeof node.value !== "number") continue;
    if (node.type === "PLAIN" && typeof node.source === "string" && node.source !== String(node.value)) values[pair.key.value] = node.source;
  }
  return values;
}

/**
 * Applies every lossless fix `warnings` allow in one pass, or returns null when none
 * applies. `skip` names fields left as written (a contradicted contract has no value to fix toward).
 */
export function coerceFrontmatter(content: string, warnings: readonly Violation[], options: CoerceOptions, skip: ReadonlySet<string> = new Set()): CoerceResult | null {
  const properties = options.contract.properties;
  if (properties === null) return null;
  const { frontmatter, diagnostics } = parseNote(content);
  if (diagnostics.length > 0) return null;
  const written = writtenValues(content);
  const values = new Map<string, unknown>();
  const fixes: Violation[] = [];
  for (const warning of warnings) {
    if (!FIXABLE.has(warning.kind) || skip.has(warning.field) || values.has(warning.field) || !Object.hasOwn(properties, warning.field)) continue;
    const property = properties[warning.field]!;
    const fix = fixFor(warning, frontmatter[warning.field], written[warning.field], property, options);
    if (fix === null || !clears(warning.kind, propertyKinds(fix.value, property))) continue;
    values.set(warning.field, fix.value);
    fixes.push({ field: warning.field, kind: warning.kind });
  }
  if (fixes.length === 0) return null;
  const next = setFrontmatter(content, values, frontmatter);
  return next === null ? null : { content: next.content, fixes: fixes.filter(fix => next.applied.has(fix.field)) };
}
