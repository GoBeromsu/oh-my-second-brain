import { parseNote } from "../conventions/frontmatter.js";
import { scanContractHeadings } from "../contract/scan.js";
import { listTyped } from "./coerce.js";
import type { TemplateSelection } from "./live-templates.js";
import type { ContractView, FieldType, PropertyContract } from "../contract/types.js";
import type { ConformChange } from "./receipt.js";

/**
 * Mechanical conformance before the judge: date and title variables, the live template's
 * scaffold for a new note (its frontmatter as defaults, its headings as the skeleton), and
 * date and fixed-rule defaults a new note leaves out. It never calls the judge and never
 * touches an existing value. The contract never makes it supply a required property, so a
 * missing required property is still reported after conform; the judge never checks headings.
 */

export interface ConformOptions {
  readonly view: ContractView;
  /** The live template chosen for the note (`selectTemplate`); only a new note is scaffolded. */
  readonly scaffold?: TemplateSelection | undefined;
  /** True when the target does not exist yet; defaults are only added to new notes. */
  readonly isNew: boolean;
  /** Substituted for `{{title}}`: the note's file name without `.md`. */
  readonly title: string;
  readonly now: Date;
}

export interface ConformResult {
  readonly content: string;
  readonly applied: readonly ConformChange[];
}

const FENCE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const VARIABLE = /\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi;
const FORMAT_TOKEN = /YYYY|MM|DD|HH|mm|ss/g;
const PLAIN_TITLE = /^[\p{L}\p{N} _.-]+$/u;
const PLAIN_KEY = /^[\p{L}\p{N}_-]+$/u;
const KEY_LINE = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*?))\s*:/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Only the date tokens it knows; any other letter leaves the variable for the judge. */
function formatDate(now: Date, format: string): string | null {
  const parts: Record<string, string> = {
    YYYY: String(now.getFullYear()), MM: pad(now.getMonth() + 1), DD: pad(now.getDate()),
    HH: pad(now.getHours()), mm: pad(now.getMinutes()), ss: pad(now.getSeconds()),
  };
  if (/[A-Za-z]/.test(format.replace(FORMAT_TOKEN, ""))) return null;
  return format.replace(FORMAT_TOKEN, token => parts[token]!);
}

function variableValue(name: string, format: string | undefined, options: ConformOptions): string | null {
  const kind = name.toLowerCase();
  if (kind === "title") return format === undefined ? options.title : null;
  if (kind === "time") return format === undefined ? formatDate(options.now, "HH:mm") : null;
  return formatDate(options.now, format === undefined ? "YYYY-MM-DD" : format.trim());
}

/** A title inside YAML keeps the quoting it sits in, or is quoted when it is not plain. */
function yamlText(value: string, before: string): string {
  if (before === "\"") return JSON.stringify(value).slice(1, -1);
  if (before === "'") return value.replaceAll("'", "''");
  return PLAIN_TITLE.test(value) ? value : JSON.stringify(value);
}

function substitute(text: string, options: ConformOptions, yaml: boolean): string {
  return text.replace(VARIABLE, (token, name: string, format: string | undefined, offset: number) => {
    const value = variableValue(name, format, options);
    if (value === null) return token;
    return yaml && name.toLowerCase() === "title" ? yamlText(value, text[offset - 1] ?? "") : value;
  });
}

function lineKey(line: string): string | null {
  const match = KEY_LINE.exec(line);
  return match === null ? null : (match[1] ?? match[2] ?? match[3] ?? null);
}

function substituteVariables(content: string, options: ConformOptions, applied: ConformChange[]): string {
  const fence = FENCE.exec(content);
  const yamlEnd = fence === null ? 0 : fence[0].length;
  const lines = content.slice(0, yamlEnd).split("\n");
  let key: string | null = null;
  const frontmatter = lines.map((line, index) => {
    if (index === 0) return line;
    key = /^\s/.test(line) || line.startsWith("-") ? key : lineKey(line);
    const next = substitute(line, options, true);
    if (next !== line) applied.push({ field: key ?? "content", action: "variable" });
    return next;
  }).join("\n");
  const body = content.slice(yamlEnd);
  const conformedBody = substitute(body, options, false);
  if (conformedBody !== body) applied.push({ field: "content", action: "variable" });
  return frontmatter + conformedBody;
}

function defaultValue(type: FieldType, now: Date): string | null {
  if (type === "date") return formatDate(now, "YYYY-MM-DD");
  if (type === "datetime") return `${formatDate(now, "YYYY-MM-DD")}T${formatDate(now, "HH:mm:ss")}`;
  return null;
}

/** The one value a rule fixes, as YAML (JSON is YAML), or null when the rules leave a choice. */
function fixedDefault(property: PropertyContract): string | null {
  const [rule] = property.rules;
  if (property.rules.length !== 1 || rule?.kind !== "fixed") return null;
  return JSON.stringify(listTyped(property.type) ? [rule.value] : rule.value);
}

/**
 * New notes only: a missing unrequired default gets `now` when it is an unconstrained date
 * or datetime, or the value its only rule fixes.
 */
function addDefaults(content: string, options: ConformOptions, applied: ConformChange[]): string {
  if (!options.isNew || options.view.state !== "sealed") return content;
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines: string[] = [];
  for (const [name, property] of Object.entries(options.view.contract.properties ?? {})) {
    if (!property.default || property.required || Object.hasOwn(parsed.frontmatter, name)) continue;
    const value = property.rules.length > 0 ? fixedDefault(property) : defaultValue(property.type, options.now);
    if (value === null) continue;
    lines.push(`${PLAIN_KEY.test(name) ? name : JSON.stringify(name)}: ${value}`);
    applied.push({ field: name, action: "default" });
  }
  if (lines.length === 0) return content;
  if (parsed.frontmatterRange === null) return `---${eol}${lines.join(eol)}${eol}---${eol}${content}`;
  const end = parsed.frontmatterRange.end;
  return `${content.slice(0, end)}${eol}${lines.join(eol)}${content.slice(end)}`;
}

function observedHeadings(body: string): readonly string[] | null {
  try {
    return scanContractHeadings(body, true).map(heading => heading.title.normalize("NFC"));
  } catch {
    return null;
  }
}

/** Inserts `lines` at the end of the frontmatter, opening one when the note has none. */
function insertFrontmatter(content: string, lines: readonly string[]): string {
  if (lines.length === 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const parsed = parseNote(content);
  if (parsed.frontmatterRange === null) return `---${eol}${lines.join(eol)}${eol}---${eol}${content}`;
  const end = parsed.frontmatterRange.end;
  return `${content.slice(0, end)}${eol}${lines.join(eol)}${content.slice(end)}`;
}

/**
 * New notes only: the chosen template's keys the note leaves out, with its variables filled,
 * then each of its headings the note misses. A key whose value still holds a variable conform
 * cannot fill is left out rather than saved unfilled. A named template that is not in
 * `templateFolder` scaffolds nothing and is reported as `template-missing`.
 */
function addScaffold(content: string, options: ConformOptions, applied: ConformChange[]): string {
  const selection = options.scaffold;
  if (selection?.kind === "missing") {
    applied.push({ field: selection.name, action: "template-missing" });
    return content;
  }
  if (!options.isNew || selection?.kind !== "template") return content;
  const template = selection.template;
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return content;
  const lines: string[] = [];
  for (const field of template.fields) {
    if (Object.hasOwn(parsed.frontmatter, field.name)) continue;
    const text = substitute(field.text, options, true);
    if (/\{\{/.test(text)) continue;
    lines.push(text);
    applied.push({ field: field.name, action: "default" });
  }
  let next = insertFrontmatter(content, lines);
  const observed = observedHeadings(parseNote(next).body);
  if (observed === null) return next;
  const missing = template.headings.filter(heading => !observed.includes(heading.title));
  if (missing.length === 0) return next;
  for (const heading of missing) applied.push({ field: heading.title, action: "heading" });
  const separator = next === "" || next.endsWith("\n\n") ? "" : next.endsWith("\n") ? "\n" : "\n\n";
  next = `${next}${separator}${missing.map(heading => `${"#".repeat(heading.level)} ${heading.title}\n`).join("\n")}`;
  return next;
}

export function conform(content: string, options: ConformOptions): ConformResult {
  const applied: ConformChange[] = [];
  let next = substituteVariables(content, options, applied);
  next = addScaffold(next, options, applied);
  next = addDefaults(next, options, applied);
  return { content: next, applied };
}
