import { compareCodePoints } from "../conventions/canonical.js";
import { isControlPath, normalizeFolderPath } from "../vault/paths.js";
import { isObsidianTag } from "./obsidian.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import type {
  ContractView, FieldType, JsonScalar, JudgeInput, Rule,
  VaultContract, Verdict, Violation, ViolationKind,
} from "./types.js";
import { verdictOf } from "./types.js";

/**
 * Pure judgement of a write against a vault's contract view. It never throws, writes,
 * repairs or renders. Each finding is `{field, kind}` only: no value or rule.
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
    case "count": {
      const count = members(value).length;
      return (rule.min === undefined || count >= rule.min) && (rule.max === undefined || count <= rule.max) ? null : "count";
    }
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

/**
 * Every call checks the whole note: the verdict depends only on the contract, the path and
 * the frontmatter. What an edit newly breaks is the caller's delta against the verdict on
 * the previous note, never the judge's.
 */
function sealedJudge(input: JudgeInput, contract: VaultContract, found: Collector): string[] {
  if (contract.folders !== null && !registered(input.path, contract.folders)) found.add("path", "unregistered-folder");

  const missingDefaults: string[] = [];
  const properties = contract.properties;
  if (properties !== null) {
    for (const name of Object.keys(input.frontmatter)) {
      if (!Object.hasOwn(properties, name)) found.add(name, "unknown-property");
    }
    for (const [name, property] of Object.entries(properties).sort(([left], [right]) => compareCodePoints(left, right))) {
      const present = Object.hasOwn(input.frontmatter, name);
      if (!present || empty(input.frontmatter[name])) {
        if (property.required) found.add(name, "missing");
        else if (!present && property.default) missingDefaults.push(name);
        continue;
      }
      for (const kind of valueKinds(input.frontmatter[name], property.type, property.rules)) found.add(name, kind);
    }
  }
  for (const [name, value] of Object.entries(input.frontmatter)) {
    if (hasVariable(value)) found.add(name, "unsubstituted-variable");
  }
  return missingDefaults;
}

/**
 * Rule order: base path rules → seal view → folder axis → property axis (value rules,
 * then unsubstituted variables). Every finding is collected, then split by severity: only a path rule or a
 * tampered seal refuses. An open or broken seal cannot judge the axes, so it adds one
 * warning and nothing else.
 */
export function judge(input: JudgeInput, view: ContractView): Verdict {
  const found = new Collector();
  const pathKind = basePathKind(input.path);
  if (pathKind !== null) {
    found.add("path", pathKind);
    return verdictOf(found.violations);
  }
  if (view.state === "open") {
    found.add("contract", "contract-open");
    return verdictOf(found.violations);
  }
  if (view.state === "unreadable") {
    found.add("contract", view.reason === "tampered" ? "contract-tampered" : "contract-unreadable");
    return verdictOf(found.violations);
  }
  const missingDefaults = sealedJudge(input, view.contract, found);
  return verdictOf(found.violations, missingDefaults);
}
