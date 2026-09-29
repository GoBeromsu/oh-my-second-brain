import { Document, isMap, parseDocument } from "yaml";
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

function fixType(value: unknown, type: FieldType): Fix {
  if (type === "number") return typeof value === "string" && String(Number(value)) === value && Number.isFinite(Number(value)) ? fixed(Number(value)) : null;
  if (type === "boolean" || type === "checkbox") return value === "true" || value === "false" ? fixed(value === "true") : null;
  if (type === "date") {
    const match = typeof value === "string" ? MIDNIGHT.exec(value) : null;
    return match === null ? null : fixed(match[1]);
  }
  if (stringTyped(type)) return typeof value === "number" && Number.isFinite(value) ? fixed(String(value)) : null;
  if (!singleValued(type)) return value !== null && scalar(value) ? fixed([value]) : null;
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
  if (rule !== undefined) return fixed(singleValued(property.type) ? rule.value : [rule.value]);
  if (!options.isNew || options.now === undefined || !property.default || property.rules.length > 0) return null;
  const date = dateNow(property.type, options.now);
  return date === null ? null : fixed(date);
}

function fixFor(warning: Violation, value: unknown, property: PropertyContract, options: CoerceOptions): Fix {
  switch (warning.kind) {
    case "type": return fixType(value, property.type);
    case "not-allowed": return fixAllowed(value, property);
    case "missing": return fixMissing(property, options);
    default: return null;
  }
}

/** A filled value must meet every rule; a changed value must only clear the kind it was changed for. */
function clears(kind: ViolationKind, remaining: readonly ViolationKind[]): boolean {
  return kind === "missing" ? remaining.length === 0 : !remaining.includes(kind);
}

/** `content` with each field set to its fixed value; the body and every other key stay as written. */
function setFrontmatter(content: string, values: ReadonlyMap<string, unknown>): string | null {
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return null;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (parsed.frontmatterRange === null) {
    const yaml = String(new Document(Object.fromEntries(values))).replace(/\r?\n/g, eol);
    return `---${eol}${yaml}---${eol}${content}`;
  }
  const written = parseDocument(parsed.frontmatterRaw, { uniqueKeys: true });
  // An empty block parses to no map; the fixes then make the whole block.
  const document = written.contents === null ? new Document({}) : written;
  if (!isMap(document.contents)) return null;
  for (const [key, value] of values) document.set(key, value);
  const yaml = String(document).replace(/\r?\n/g, eol);
  const head = content.slice(0, parsed.frontmatterRange.start);
  const tail = content.slice(parsed.frontmatterRange.end);
  return `${head}${yaml.endsWith("\n") ? yaml : `${yaml}${eol}`}${tail.replace(/^\r?\n/, "")}`;
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
  const values = new Map<string, unknown>();
  const fixes: Violation[] = [];
  for (const warning of warnings) {
    if (!FIXABLE.has(warning.kind) || skip.has(warning.field) || values.has(warning.field) || !Object.hasOwn(properties, warning.field)) continue;
    const property = properties[warning.field]!;
    const fix = fixFor(warning, frontmatter[warning.field], property, options);
    if (fix === null || !clears(warning.kind, propertyKinds(fix.value, property))) continue;
    values.set(warning.field, fix.value);
    fixes.push({ field: warning.field, kind: warning.kind });
  }
  if (fixes.length === 0) return null;
  const next = setFrontmatter(content, values);
  return next === null ? null : { content: next, fixes };
}
