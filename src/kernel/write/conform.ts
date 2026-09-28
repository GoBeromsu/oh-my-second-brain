import { parseNote } from "../conventions/frontmatter.js";
import { scanContractHeadings } from "../contract/scan.js";
import type { ContractView, FieldType, TemplateContract } from "../contract/types.js";
import type { ConformChange } from "./receipt.js";

/**
 * Mechanical conformance before the judge: date and title variables, date defaults a new
 * note leaves out, and the chosen template's missing heading skeleton. It never calls the
 * judge, never touches an existing value and never writes a sealed value, so whatever the
 * judge refuses after conform it would have refused before.
 */

export interface ConformOptions {
  readonly view: ContractView;
  readonly template?: string | undefined;
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

function selectedTemplate(options: ConformOptions): TemplateContract | undefined {
  if (options.view.state !== "sealed" || options.template === undefined) return undefined;
  const { templates } = options.view.contract;
  return Object.hasOwn(templates, options.template) ? templates[options.template] : undefined;
}

function defaultValue(type: FieldType, now: Date): string | null {
  if (type === "date") return formatDate(now, "YYYY-MM-DD");
  if (type === "datetime") return formatDate(now, "YYYY-MM-DDTHH:mm:ss");
  return null;
}

/** New notes only: a missing unconstrained date or datetime default gets `now`. */
function addDefaults(content: string, options: ConformOptions, applied: ConformChange[]): string {
  if (!options.isNew || options.view.state !== "sealed") return content;
  const parsed = parseNote(content);
  if (parsed.diagnostics.length > 0) return content;
  const template = selectedTemplate(options);
  const lines: string[] = [];
  for (const [name, property] of Object.entries(options.view.contract.properties ?? {})) {
    if (!property.default || property.required || Object.hasOwn(parsed.frontmatter, name)) continue;
    if (property.rules.length > 0 || (template !== undefined && Object.hasOwn(template.narrowedRules, name))) continue;
    const value = defaultValue(property.type, options.now);
    if (value === null) continue;
    lines.push(`${PLAIN_KEY.test(name) ? name : JSON.stringify(name)}: ${value}`);
    applied.push({ field: name, action: "default" });
  }
  if (lines.length === 0) return content;
  if (parsed.frontmatterRange === null) return `---\n${lines.join("\n")}\n---\n${content}`;
  const end = parsed.frontmatterRange.end;
  return `${content.slice(0, end)}\n${lines.join("\n")}${content.slice(end)}`;
}

function observedHeadings(body: string): readonly string[] | null {
  try {
    return scanContractHeadings(body, true).map(heading => heading.title.normalize("NFC"));
  } catch {
    return null;
  }
}

/** Appends `## <heading>` for each required heading the chosen template misses. */
function addHeadings(content: string, options: ConformOptions, applied: ConformChange[]): string {
  const template = selectedTemplate(options);
  if (template === undefined || template.requiredHeadings.length === 0) return content;
  const parsed = parseNote(content);
  const observed = observedHeadings(parsed.body);
  if (observed === null) return content;
  const missing = template.requiredHeadings.filter(heading => !observed.includes(heading.normalize("NFC")));
  if (missing.length === 0) return content;
  for (const heading of missing) applied.push({ field: heading, action: "heading" });
  const separator = content === "" || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${missing.map(heading => `## ${heading}\n`).join("\n")}`;
}

export function conform(content: string, options: ConformOptions): ConformResult {
  const applied: ConformChange[] = [];
  let next = substituteVariables(content, options, applied);
  next = addDefaults(next, options, applied);
  next = addHeadings(next, options, applied);
  return { content: next, applied };
}
