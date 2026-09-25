import { compareCodePoints } from "../conventions/canonical.js";
import { parseNote } from "../conventions/frontmatter.js";
import { isControlPath, normalizeFolderPath } from "../vault/paths.js";
import { isObsidianTag } from "./obsidian.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { scanContractHeadings } from "./scan.js";
import type {
  ContractView, FieldType, JsonScalar, JudgeInput, PropertyContract, Rule,
  TemplateContract, VaultContract, Verdict, Violation, ViolationKind,
} from "./types.js";

/**
 * Pure judgement of a write against a vault's contract view. It never throws, writes,
 * repairs or renders. Each violation is `{field, kind}` only: no value, rule or template name.
 */

const STRING_TYPES = new Set<FieldType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<FieldType>(["list", "multitext", "multi", "tags", "aliases"]);
const VARIABLE = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/;
/** A longer value is never handed to a pattern; it fails the rule instead of running it. */
export const PATTERN_VALUE_LIMIT = 10_000;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function matchesType(value: unknown, type: FieldType): boolean {
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && validDate(value);
  if (type === "datetime") return typeof value === "string" && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!LIST_TYPES.has(type) || !Array.isArray(value)) return false;
  if (type === "list" || type === "multi") return true;
  if (!value.every(member => typeof member === "string")) return false;
  return type !== "tags" || value.every(member => isObsidianTag(member as string));
}

/** True when a value of this type always reaches the rules as one member, never a list. */
export function singleValued(type: FieldType | null): boolean {
  return type !== null && !LIST_TYPES.has(type);
}

function empty(value: unknown): boolean {
  return value == null || typeof value === "string" && value.trim() === "" || Array.isArray(value) && value.length === 0;
}

function sameScalar(left: unknown, right: JsonScalar): boolean {
  if (typeof left === "string" && typeof right === "string") return left.normalize("NFC") === right.normalize("NFC");
  return left === right;
}

function members(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Null for a source the seal would refuse to compile (a hand-edited store), so it is never run. */
function fullMatch(regex: string, value: string): boolean | null {
  if (regex.length > PATTERN_SOURCE_LIMIT) return null;
  if (value.length > PATTERN_VALUE_LIMIT) return false;
  try {
    return new RegExp(`^(?:${regex})$`, "u").test(value);
  } catch {
    return null;
  }
}

function inRange(value: unknown, rule: Extract<Rule, { kind: "range" }>): boolean {
  for (const [limit, below] of [[rule.min, true], [rule.max, false]] as const) {
    if (limit === undefined) continue;
    if (typeof limit !== typeof value) return false;
    const current = value as number | string;
    if (below ? current < limit : current > limit) return false;
  }
  return true;
}

function ruleKind(rule: Rule, value: unknown): ViolationKind | null {
  switch (rule.kind) {
    case "allowed":
      return members(value).every(member => rule.values.some(allowed => sameScalar(member, allowed))) ? null : "not-allowed";
    case "fixed":
      return members(value).some(member => sameScalar(member, rule.value)) ? null : "not-fixed";
    case "pattern":
      return members(value).every(member => (typeof member === "string" || typeof member === "number" || typeof member === "boolean") && fullMatch(rule.regex, String(member)) === true) ? null : "pattern";
    case "range":
      return members(value).every(member => inRange(member, rule)) ? null : "range";
  }
}

function valueKinds(value: unknown, type: FieldType | null, rules: readonly Rule[]): ViolationKind[] {
  if (value == null) return [];
  if (type !== null && !matchesType(value, type)) return ["type"];
  const kinds: ViolationKind[] = [];
  for (const rule of rules) {
    const kind = ruleKind(rule, value);
    if (kind !== null) kinds.push(kind);
  }
  return kinds;
}

function hasVariable(value: unknown): boolean {
  if (typeof value === "string") return VARIABLE.test(value);
  if (Array.isArray(value)) return value.some(hasVariable);
  if (typeof value === "object" && value !== null) return Object.values(value).some(hasVariable);
  return false;
}

/** Separator- and NFC-normalized vault-relative path, as the judge compares apply folders. */
export function normalizePath(path: string): string {
  return path.normalize("NFC").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

/** Subfolders inherit: `Projects` covers `Projects/A/b.md`. */
export function insideApplyFolder(notePath: string, applyFolder: string): boolean {
  const folder = normalizePath(applyFolder);
  return folder === "" || normalizePath(notePath).startsWith(`${folder}/`);
}

class Collector {
  readonly violations: Violation[] = [];
  private readonly seen = new Set<string>();

  add(field: string, kind: ViolationKind): void {
    const key = `${kind}\u0000${field}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push({ field, kind });
  }
}

/** Control and unsafe paths, denied before any contract is consulted. */
export function basePathKind(path: string): ViolationKind | null {
  const normalized = normalizePath(path);
  if (isControlPath(normalized) || normalized.split("/")[0]?.toLowerCase() === ".oms") return "control-path";
  try {
    normalizeFolderPath(path);
    return null;
  } catch {
    return "path-unsafe";
  }
}

/** Nearest registered folder, walking up; the vault root is never a registered folder. */
function registered(path: string, folders: Readonly<Record<string, unknown>>): boolean {
  const parts = normalizePath(path).split("/").slice(0, -1);
  for (let length = parts.length; length > 0; length -= 1) {
    if (Object.hasOwn(folders, parts.slice(0, length).join("/"))) return true;
  }
  return false;
}

interface Note {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

function headings(body: string): readonly string[] | null {
  try {
    return scanContractHeadings(body, true).map(heading => heading.title.normalize("NFC"));
  } catch {
    return null;
  }
}

/** What a note lacks against one template. Empty means the note passes it. */
function templateViolations(template: TemplateContract, note: Note, properties: Readonly<Record<string, PropertyContract>> | null): Violation[] {
  const found = new Collector();
  for (const name of template.requiredProperties) {
    if (!Object.hasOwn(note.frontmatter, name) || empty(note.frontmatter[name])) found.add(name, "missing");
  }
  for (const [name, rules] of Object.entries(template.narrowedRules)) {
    if (!Object.hasOwn(note.frontmatter, name)) continue;
    const type = properties !== null && Object.hasOwn(properties, name) ? properties[name]!.type : null;
    for (const kind of valueKinds(note.frontmatter[name], type, rules)) found.add(name, kind);
  }
  const observed = headings(note.body);
  for (const heading of template.requiredHeadings) {
    if (observed === null || !observed.includes(heading.normalize("NFC"))) found.add(heading, "heading-missing");
  }
  for (const [name, value] of Object.entries(note.frontmatter)) {
    if (hasVariable(value)) found.add(name, "unsubstituted-variable");
  }
  if (VARIABLE.test(note.body)) found.add("content", "unsubstituted-variable");
  return found.violations;
}

/** Least-failing candidate; ties break by template name code point. */
function leastFailing(candidates: readonly (readonly [string, readonly Violation[]])[]): readonly Violation[] {
  const sorted = [...candidates].sort(([leftName, left], [rightName, right]) => left.length - right.length || compareCodePoints(leftName, rightName));
  return sorted[0]?.[1] ?? [];
}

function parsePrevious(content: string): Note | null {
  const parsed = parseNote(content);
  return parsed.diagnostics.length > 0 ? null : { frontmatter: parsed.frontmatter, body: parsed.body };
}

function templateAxis(input: JudgeInput, contract: VaultContract, selected: TemplateContract | undefined, previous: Note | null, found: Collector): void {
  const note: Note = { frontmatter: input.frontmatter, body: input.body };
  const candidates = Object.entries(contract.templates)
    .filter(([, template]) => template.applyFolder !== undefined && insideApplyFolder(input.path, template.applyFolder))
    .sort(([left], [right]) => compareCodePoints(left, right));
  const passedBefore = previous === null ? [] : candidates.filter(([, template]) => templateViolations(template, previous, contract.properties).length === 0);
  const passedNames = new Set(passedBefore.map(([name]) => name));

  if (input.selectedTemplate === undefined || selected === undefined) {
    if (passedBefore.length === 0) return;
    const results = passedBefore.map(([name, template]) => [name, templateViolations(template, note, contract.properties)] as const);
    if (results.some(([, violations]) => violations.length === 0)) return;
    for (const violation of leastFailing(results)) found.add(violation.field, violation.kind);
    return;
  }
  if (input.previousContent !== undefined && passedBefore.length > 0 && !passedNames.has(input.selectedTemplate)) {
    found.add("template", "template-mismatch");
    return;
  }
  for (const violation of templateViolations(selected, note, contract.properties)) found.add(violation.field, violation.kind);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A new note is checked in full. An edit is checked only for what it changes: a key it
 * adds, a required key it removes or empties, and a value it changes. A legacy note
 * that already carries an unregistered key or lacks a required one stays editable.
 */
function sealedJudge(input: JudgeInput, contract: VaultContract, found: Collector): string[] {
  if (contract.folders !== null && !registered(input.path, contract.folders)) found.add("path", "unregistered-folder");

  const previous = input.previousContent === undefined ? null : parsePrevious(input.previousContent);
  const before = previous?.frontmatter ?? null;
  const edit = input.previousContent !== undefined;
  const missingDefaults: string[] = [];
  const properties = contract.properties;
  if (properties !== null) {
    for (const name of Object.keys(input.frontmatter)) {
      if (Object.hasOwn(properties, name)) continue;
      if (!edit || before === null || !Object.hasOwn(before, name)) found.add(name, "unknown-property");
    }
    for (const [name, property] of Object.entries(properties).sort(([left], [right]) => compareCodePoints(left, right))) {
      const present = Object.hasOwn(input.frontmatter, name);
      const filledBefore = before !== null && Object.hasOwn(before, name) && !empty(before[name]);
      if (!present || empty(input.frontmatter[name])) {
        if (property.required && (!edit || before === null || filledBefore)) found.add(name, "missing");
        else if (!present && property.default) missingDefaults.push(name);
        continue;
      }
      if (edit && before !== null && Object.hasOwn(before, name) && sameValue(before[name], input.frontmatter[name])) continue;
      for (const kind of valueKinds(input.frontmatter[name], property.type, property.rules)) found.add(name, kind);
    }
  }

  let selected: TemplateContract | undefined;
  if (input.selectedTemplate !== undefined) {
    selected = Object.hasOwn(contract.templates, input.selectedTemplate) ? contract.templates[input.selectedTemplate] : undefined;
    if (selected === undefined) {
      found.add("template", "template-mismatch");
      return missingDefaults;
    }
    if (selected.applyFolder !== undefined && !insideApplyFolder(input.path, selected.applyFolder)) found.add("path", "folder-mismatch");
  }
  templateAxis(input, contract, selected, previous, found);
  return missingDefaults;
}

/** Rule order: base path rules → seal view → folders → properties → folder-mismatch → template axis. */
export function judge(input: JudgeInput, view: ContractView): Verdict {
  const found = new Collector();
  const pathKind = basePathKind(input.path);
  if (pathKind !== null) {
    found.add("path", pathKind);
    return { ok: false, violations: found.violations, missingDefaults: [] };
  }
  if (view.state === "open") return { ok: true, violations: [], missingDefaults: [] };
  if (view.state === "unreadable") {
    found.add("contract", "contract-unreadable");
    return { ok: false, violations: found.violations, missingDefaults: [] };
  }
  const missingDefaults = sealedJudge(input, view.contract, found);
  return { ok: found.violations.length === 0, violations: found.violations, missingDefaults };
}
