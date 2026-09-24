import { scanContractHeadings, type ObservedHeading } from "./content-contract.js";
import type { EffectiveContractV5, EffectiveFieldV5, HeadingV5 } from "./contract-v5.js";
import type { ObsidianContractType } from "./types.js";

export type StructuralRule = "required" | "type" | "allowed-values" | "format" | "cardinality" | "range" | "tag-syntax" | "heading" | "binding";
export interface StructuralViolation {
  readonly field: string;
  readonly rule: StructuralRule;
  readonly message: string;
}
export interface StructuralContractResult {
  readonly valid: boolean;
  readonly structural: "pass" | "fail";
  readonly semantic: "not-evaluated";
  readonly violations: readonly StructuralViolation[];
}
const STRING_TYPES = new Set<ObsidianContractType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<ObsidianContractType>(["list", "multitext", "multi", "tags", "aliases"]);

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function matchesType(value: unknown, type: ObsidianContractType): boolean {
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && validDate(value);
  if (type === "datetime") return typeof value === "string" && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  return LIST_TYPES.has(type) && Array.isArray(value) && (type === "list" || type === "multi" || value.every(member => typeof member === "string"));
}
function empty(value: unknown): boolean {
  return value == null || typeof value === "string" && value.trim() === "" || Array.isArray(value) && value.length === 0;
}
function validUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}
/** Obsidian tags are unprefixed property values, not wikilinks; Unicode symbols are supported. */
export function isObsidianTag(value: string): boolean {
  return /^[\p{L}\p{M}\p{N}\p{S}_/-]+$/u.test(value) && /[^\p{N}]/u.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//");
}
function fieldViolations(name: string, field: EffectiveFieldV5, value: unknown): StructuralViolation[] {
  const violations: StructuralViolation[] = [];
  const add = (rule: StructuralRule, message: string): void => { violations.push({ field: name, rule, message }); };
  if (field.required && empty(value)) {
    add("required", `Field '${name}' is required.`);
    return violations;
  }
  if (value == null) return violations;
  if (!matchesType(value, field.type)) {
    add("type", `Field '${name}' must be ${field.type}.`);
    return violations;
  }
  if (field.valuePolicy === "closed") {
    const members = Array.isArray(value) ? value : [value];
    if (!members.every(member => typeof member === "string" && field.allowedValues?.includes(member))) add("allowed-values", `Field '${name}' contains a value outside its explicit allowed set.`);
  }
  if (field.format === "url" && (typeof value !== "string" || !validUrl(value))) add("format", `Field '${name}' must be an HTTP(S) URL.`);
  if (Array.isArray(value)) {
    if (field.minItems != null && value.length < field.minItems) add("cardinality", `Field '${name}' needs at least ${field.minItems} values.`);
    if (field.maxItems != null && value.length > field.maxItems) add("cardinality", `Field '${name}' allows at most ${field.maxItems} values.`);
    if (field.type === "tags" && !value.every(member => typeof member === "string" && isObsidianTag(member))) add("tag-syntax", `Field '${name}' contains an invalid Obsidian tag; use tag names, not wikilinks.`);
  }
  if (typeof value === "number") {
    if (field.minimum != null && value < field.minimum) add("range", `Field '${name}' must be at least ${field.minimum}.`);
    if (field.maximum != null && value > field.maximum) add("range", `Field '${name}' must be at most ${field.maximum}.`);
  }
  return violations;
}

export interface BoundHeadingV5 extends HeadingV5 {
  readonly title: string;
}
export interface HeadingBindingResult {
  readonly headings: readonly BoundHeadingV5[];
  readonly violations: readonly StructuralViolation[];
}
/** Bind only slots explicitly present in the selected contract; callers persist this before writing. */
export function bindContractHeadings(contract: EffectiveContractV5, bindings: Readonly<Record<string, string>> = {}): HeadingBindingResult {
  const headings: BoundHeadingV5[] = [];
  const violations: StructuralViolation[] = [];
  const slots = new Set(contract.headings.flatMap(heading => heading.binding === undefined ? [] : [heading.binding]));
  for (const key of Object.keys(bindings)) {
    if (!slots.has(key)) violations.push({ field: `binding:${key}`, rule: "binding", message: `Binding '${key}' is not a declared heading slot.` });
  }
  for (const heading of contract.headings) {
    if (heading.binding === undefined) {
      headings.push({ ...heading, title: heading.title! });
      continue;
    }
    const value = Object.hasOwn(bindings, heading.binding) ? bindings[heading.binding] : undefined;
    if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f]/u.test(value)) {
      violations.push({ field: `body:${heading.headingId}`, rule: "binding", message: `Heading slot '${heading.binding}' needs a non-empty single-line value before writing.` });
      continue;
    }
    headings.push({ ...heading, title: value.trim() });
  }
  return { headings, violations };
}

function headingViolations(headings: readonly BoundHeadingV5[], observed: readonly ObservedHeading[], order: EffectiveContractV5["headingOrder"], additionalHeadings: EffectiveContractV5["additionalHeadings"]): StructuralViolation[] {
  const violations: StructuralViolation[] = [];
  const used = new Set<number>();
  const anchors = new Set<number>();
  let previous = -1;
  for (const heading of headings) {
    const title = heading.title.normalize("NFC");
    const candidates = observed.map((candidate, index) => ({ candidate, index })).filter(({ candidate, index }) => !used.has(index) && candidate.title === title);
    const correct = candidates.filter(({ candidate }) => candidate.level === heading.level);
    const selected = (order === "strict" ? correct.find(({ index }) => index > previous) : undefined) ?? correct[0];
    const field = `body:${heading.headingId}`;
    if (selected === undefined) {
      const wrong = candidates[0];
      if (wrong !== undefined) {
        used.add(wrong.index);
        violations.push({ field, rule: "heading", message: `Heading '${heading.title}' must be level ${heading.level}, not ${wrong.candidate.level}.` });
      } else if (heading.required !== false) {
        violations.push({ field, rule: "heading", message: `Required heading '${heading.title}' at level ${heading.level} is missing.` });
      }
      continue;
    }
    used.add(selected.index);
    anchors.add(selected.index);
    if (order === "strict" && selected.index < previous) violations.push({ field, rule: "heading", message: `Heading '${heading.title}' does not follow the declared order.` });
    previous = Math.max(previous, selected.index);
  }
  if (additionalHeadings === "allow" || headings.length === 0) return violations;
  const stack: number[] = [];
  for (const [index, observedHeading] of observed.entries()) {
    while (stack.length > 0 && stack[stack.length - 1]! >= observedHeading.level) stack.pop();
    if (anchors.has(index)) {
      stack.push(observedHeading.level);
      continue;
    }
    if (used.has(index)) continue;
    const parent = stack[stack.length - 1];
    if (parent === undefined || observedHeading.level <= parent || observedHeading.level > 6) {
      violations.push({ field: "body", rule: "heading", message: `Additional heading '${observedHeading.title}' at level ${observedHeading.level} is outside the subordinate range of the matched declared headings.` });
    }
  }
  return violations;
}

/** Structure only: never repairs frontmatter, rewrites body, renders a template or evaluates prose. */
export function evaluateContractV5(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
  contract: EffectiveContractV5,
  bindings: Readonly<Record<string, string>> = {},
): StructuralContractResult {
  if (typeof body !== "string") throw new TypeError("Complete saved note body is required");
  const violations: StructuralViolation[] = [];
  for (const [name, field] of Object.entries(contract.fields)) {
    violations.push(...fieldViolations(name, field, Object.hasOwn(frontmatter, name) ? frontmatter[name] : undefined));
  }
  const bound = bindContractHeadings(contract, bindings);
  violations.push(...bound.violations);
  violations.push(...headingViolations(bound.headings, scanContractHeadings(body, true), contract.headingOrder, contract.additionalHeadings));
  return { valid: violations.length === 0, structural: violations.length === 0 ? "pass" : "fail", semantic: "not-evaluated", violations };
}
