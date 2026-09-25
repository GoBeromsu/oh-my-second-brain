import { parseNote } from "../conventions/frontmatter.js";
import { isObsidianTag } from "../templates/contract-check.js";
import { scanContractHeadings } from "../templates/content-contract.js";
import type { FieldType, HiddenRule, JsonScalar, SealedField, SealedLayer, Violation, ViolationKind } from "./types.js";

/**
 * Pure judgement of a note against sealed layers. It returns a report and never
 * throws, repairs or renders. Extra properties are legal and heading order is free.
 * Each violation names a field (or a public heading) and a kind only.
 */

export interface JudgeInput {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** Vault-relative note path. */
  readonly notePath: string;
  readonly layers: readonly SealedLayer[];
}

const STRING_TYPES = new Set<FieldType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<FieldType>(["list", "multitext", "multi", "tags", "aliases"]);
const VARIABLE = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/;

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

function fullMatch(regex: string, value: string): boolean | null {
  try {
    return new RegExp(`^(?:${regex})$`, "u").test(value);
  } catch {
    return null;
  }
}

function inRange(value: unknown, rule: Extract<HiddenRule, { kind: "range" }>): boolean {
  for (const [limit, below] of [[rule.min, true], [rule.max, false]] as const) {
    if (limit === undefined) continue;
    if (typeof limit !== typeof value) return false;
    const current = value as number | string;
    if (below ? current < limit : current > limit) return false;
  }
  return true;
}

function ruleKind(rule: HiddenRule, value: unknown): ViolationKind | null {
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

function fieldKinds(field: SealedField, present: boolean, value: unknown): ViolationKind[] {
  if (field.required && (!present || empty(value))) return ["required"];
  if (!present || value == null) return [];
  if (!matchesType(value, field.type)) return ["type"];
  const kinds: ViolationKind[] = [];
  for (const rule of field.rules) {
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

function normalizePath(path: string): string {
  return path.normalize("NFC").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

export function insideApplyFolder(notePath: string, applyFolder: string): boolean {
  const folder = normalizePath(applyFolder);
  return folder === "" || normalizePath(notePath).startsWith(`${folder}/`);
}

export function judge(input: JudgeInput): Violation[] {
  const found: Violation[] = [];
  const seen = new Set<string>();
  const add = (field: string | null, kind: ViolationKind): void => {
    const key = `${kind}\u0000${field ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ field, kind });
  };
  let observed: readonly string[] | null;
  try {
    observed = scanContractHeadings(input.body, true).map(heading => heading.title);
  } catch {
    observed = null;
  }
  for (const layer of input.layers) {
    if (layer.applyFolder !== null && !insideApplyFolder(input.notePath, layer.applyFolder)) add(null, "outside-apply-folder");
    for (const field of layer.fields) {
      const present = Object.hasOwn(input.frontmatter, field.name);
      for (const kind of fieldKinds(field, present, present ? input.frontmatter[field.name] : undefined)) add(field.name, kind);
    }
    for (const heading of layer.requiredHeadings) {
      const title = heading.normalize("NFC");
      if (observed === null || !observed.includes(title)) add(heading, "heading-missing");
    }
  }
  for (const [name, value] of Object.entries(input.frontmatter)) {
    if (hasVariable(value)) add(name, "unsubstituted-variable");
  }
  if (VARIABLE.test(input.body)) add(null, "unsubstituted-variable");
  return found;
}

/** Parses the note first; malformed frontmatter is the only violation reported. */
export function judgeNote(input: { readonly content: string; readonly notePath: string; readonly layers: readonly SealedLayer[] }): Violation[] {
  const parsed = parseNote(input.content);
  if (parsed.diagnostics.length > 0) return [{ field: null, kind: "yaml-syntax" }];
  return judge({ frontmatter: parsed.frontmatter, body: parsed.body, notePath: input.notePath, layers: input.layers });
}
