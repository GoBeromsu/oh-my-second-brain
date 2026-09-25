import { insideApplyFolder, normalizePath, singleValued } from "./judge.js";
import { patternRefusal } from "./pattern.js";
import type { FieldType, JsonScalar, PropertyContract, Rule, TemplateContract, VaultContract } from "./types.js";

/**
 * Monotonic reseal check for a contract sealed without a terminal: the next contract
 * may add entries and tighten folder and property rules, never loosen or change a sealed
 * template (not even to make it stricter). Each change names a field path and a kind only,
 * never a value, so it can be shown to an agent.
 */

export type LooseningKind =
  | "axis-opened"
  | "removed"
  | "search-exclude-dropped"
  | "type-changed"
  | "required-dropped"
  | "rule-removed"
  | "allowed-widened"
  | "fixed-changed"
  | "pattern-changed"
  | "range-widened"
  | "heading-dropped"
  | "apply-folder-changed"
  | "apply-folder-overlap"
  | "pattern-unsafe"
  | "template-tightened";

export interface LooseningChange {
  readonly field: string;
  readonly kind: LooseningKind;
}

function sameScalar(left: JsonScalar, right: JsonScalar): boolean {
  if (typeof left === "string" && typeof right === "string") return left.normalize("NFC") === right.normalize("NFC");
  return left === right;
}

/** A next bound is at least as strict when it exists, has the same type and does not reach past the sealed one. */
function boundHolds(sealed: number | string | undefined, next: number | string | undefined, lower: boolean): boolean {
  if (sealed === undefined) return true;
  if (next === undefined || typeof next !== typeof sealed) return false;
  return lower ? next >= sealed : next <= sealed;
}

/**
 * True when every value that passes `next` also passes `sealed`. The judge needs every
 * member of a list allowed but only some member fixed, so a fixed value and an allowed
 * list imply each other only when `single` says the value is never a list.
 */
function implies(next: Rule, sealed: Rule, single: boolean): boolean {
  if (sealed.kind === "allowed" && next.kind === "allowed") return next.values.every(value => sealed.values.some(known => sameScalar(known, value)));
  if (sealed.kind === "allowed" && next.kind === "fixed") return single && sealed.values.some(known => sameScalar(known, next.value));
  if (sealed.kind === "fixed" && next.kind === "fixed") return sameScalar(sealed.value, next.value);
  if (sealed.kind === "fixed" && next.kind === "allowed") return single && next.values.length > 0 && next.values.every(value => sameScalar(sealed.value, value));
  if (sealed.kind === "pattern" && next.kind === "pattern") return sealed.regex === next.regex;
  if (sealed.kind === "range" && next.kind === "range") return boundHolds(sealed.min, next.min, true) && boundHolds(sealed.max, next.max, false);
  return false;
}

const WIDENED: Readonly<Record<Rule["kind"], LooseningKind>> = {
  allowed: "allowed-widened",
  fixed: "fixed-changed",
  pattern: "pattern-changed",
  range: "range-widened",
};

/** `type` is the field's type under `next`, which the judge checks before any rule. */
function ruleChanges(field: string, sealed: readonly Rule[], next: readonly Rule[], type: FieldType | null): LooseningChange[] {
  const changes: LooseningChange[] = [];
  for (const rule of sealed) {
    if (next.some(candidate => implies(candidate, rule, singleValued(type)))) continue;
    const kind = next.some(candidate => candidate.kind === rule.kind) ? WIDENED[rule.kind] : "rule-removed";
    if (!changes.some(change => change.kind === kind)) changes.push({ field, kind });
  }
  return changes;
}

function propertyChanges(name: string, sealed: PropertyContract, next: PropertyContract | undefined): LooseningChange[] {
  const field = `properties.${name}`;
  if (next === undefined) return [{ field, kind: "removed" }];
  const changes: LooseningChange[] = [];
  if (next.type !== sealed.type) changes.push({ field, kind: "type-changed" });
  if (sealed.required && !next.required) changes.push({ field, kind: "required-dropped" });
  return [...changes, ...ruleChanges(field, sealed.rules, next.rules, next.type)];
}

function typeOf(properties: VaultContract["properties"], name: string): FieldType | null {
  return properties !== null && Object.hasOwn(properties, name) ? properties[name]!.type : null;
}

/**
 * The judge enforces a scoped template on an edit only when the previous content passed
 * it, so a stricter template that existing notes fail stops being enforced for them.
 * A sealed template therefore stays exactly as strict: anything it drops is loosening
 * and anything it adds is `template-tightened`. Only a fixed value and an allowed list
 * that accept the same single value stand in for each other.
 */
function templateChanges(name: string, sealed: TemplateContract, next: TemplateContract | undefined, sealedProperties: VaultContract["properties"], properties: VaultContract["properties"]): LooseningChange[] {
  const field = `templates.${name}`;
  if (next === undefined) return [{ field, kind: "removed" }];
  const changes: LooseningChange[] = [];
  // Search exclusion is built from sealed sources, so a moved source exposes the old file.
  if (normalizePath(next.source) !== normalizePath(sealed.source)) changes.push({ field: `${field}.source`, kind: "removed" });
  for (const property of sealed.requiredProperties) {
    if (!next.requiredProperties.includes(property)) changes.push({ field: `${field}.requiredProperties.${property}`, kind: "required-dropped" });
  }
  for (const property of next.requiredProperties) {
    if (!sealed.requiredProperties.includes(property)) changes.push({ field: `${field}.requiredProperties.${property}`, kind: "template-tightened" });
  }
  const narrowed = [...new Set([...Object.keys(sealed.narrowedRules), ...Object.keys(next.narrowedRules)])];
  for (const property of narrowed) {
    const ruleField = `${field}.narrowedRules.${property}`;
    const type = typeOf(properties, property);
    const before = Object.hasOwn(sealed.narrowedRules, property) ? sealed.narrowedRules[property]! : undefined;
    const after = Object.hasOwn(next.narrowedRules, property) ? next.narrowedRules[property]! : undefined;
    if (before === undefined) {
      changes.push({ field: ruleField, kind: "template-tightened" });
      continue;
    }
    const dropped = ruleChanges(ruleField, before, after ?? [], type);
    // An empty rule list still checks the property's type, so dropping it loosens too.
    changes.push(...dropped.length === 0 && after === undefined ? [{ field: ruleField, kind: "rule-removed" as const }] : dropped);
    // A rule changed both ways is already reported as loosening.
    if (after === undefined || dropped.length > 0) continue;
    // The judge checks a narrowed value's type first, so a newly known type is stricter.
    const tightened = typeOf(sealedProperties, property) === null && type !== null
      || after.some(rule => !before.some(known => implies(known, rule, singleValued(type))));
    if (tightened) changes.push({ field: ruleField, kind: "template-tightened" });
  }
  const sealedHeadings = new Set(sealed.requiredHeadings.map(heading => heading.normalize("NFC")));
  const nextHeadings = new Set(next.requiredHeadings.map(heading => heading.normalize("NFC")));
  for (const heading of sealed.requiredHeadings) {
    if (!nextHeadings.has(heading.normalize("NFC"))) changes.push({ field: `${field}.requiredHeadings.${heading}`, kind: "heading-dropped" });
  }
  for (const heading of next.requiredHeadings) {
    if (!sealedHeadings.has(heading.normalize("NFC"))) changes.push({ field: `${field}.requiredHeadings.${heading}`, kind: "template-tightened" });
  }
  if (sealed.applyFolder !== undefined && (next.applyFolder === undefined || normalizePath(next.applyFolder) !== normalizePath(sealed.applyFolder))) changes.push({ field: `${field}.applyFolder`, kind: "apply-folder-changed" });
  return changes;
}

/** Two apply folders overlap when they are equal or one holds the other (the vault root holds every folder). */
function foldersOverlap(left: string, right: string): boolean {
  return insideApplyFolder(`${left}/_`, right) || insideApplyFolder(`${right}/_`, left);
}

/**
 * A template newly scoped to a folder becomes a candidate on edits there, and the judge
 * passes an edit when any candidate passes, so it may not overlap a sealed scoped template.
 */
function overlapChanges(sealed: VaultContract, next: VaultContract): LooseningChange[] {
  const scoped = Object.values(sealed.templates).flatMap(template => template.applyFolder === undefined ? [] : [template.applyFolder]);
  const changes: LooseningChange[] = [];
  for (const [name, template] of Object.entries(next.templates)) {
    if (template.applyFolder === undefined) continue;
    const before = Object.hasOwn(sealed.templates, name) ? sealed.templates[name] : undefined;
    if (before?.applyFolder !== undefined) continue;
    if (scoped.some(folder => foldersOverlap(folder, template.applyFolder!))) changes.push({ field: `templates.${name}.applyFolder`, kind: "apply-folder-overlap" });
  }
  return changes;
}

/**
 * Sealed pattern rules the seal screen now refuses (for example a source over the length
 * cap sealed by an older release). The judge fails every value against such a rule, and
 * any replacement is looser, so only the owner at a terminal can replace it.
 */
export function unsafePatternChanges(contract: VaultContract): LooseningChange[] {
  const ruleSets: (readonly [string, readonly Rule[]])[] = [
    ...Object.entries(contract.properties ?? {}).map(([name, property]) => [`properties.${name}`, property.rules] as const),
    ...Object.entries(contract.templates).flatMap(([name, template]) =>
      Object.entries(template.narrowedRules).map(([property, rules]) => [`templates.${name}.narrowedRules.${property}`, rules] as const)),
  ];
  return ruleSets
    .filter(([, rules]) => rules.some(rule => rule.kind === "pattern" && patternRefusal(rule.regex) !== null))
    .map(([field]) => ({ field, kind: "pattern-unsafe" as const }));
}

/**
 * Every way `next` accepts a note or exposes a folder that `sealed` did not.
 * Tighter folder and property rules are not changes: the judge checks an edit's changed
 * values against the next rules and skips unchanged ones under either contract. Adding a
 * folder, a property or a template is not a change either, although it widens a closed
 * axis by registering a new entry: that is the "add" in add-or-tighten. A sealed template
 * must stay exactly as strict (see templateChanges). A newly scoped template that overlaps
 * a sealed scoped template's folder is a change, since it could pass an edit the sealed
 * one refuses. A changed property type counts as loosening even when it would be narrower.
 */
export function looseningChanges(sealed: VaultContract, next: VaultContract): LooseningChange[] {
  const changes: LooseningChange[] = [];
  if (sealed.folders !== null) {
    if (next.folders === null) changes.push({ field: "folders", kind: "axis-opened" });
    else {
      for (const [folder, entry] of Object.entries(sealed.folders)) {
        const after = Object.hasOwn(next.folders, folder) ? next.folders[folder] : undefined;
        if (after === undefined) changes.push({ field: `folders.${folder}`, kind: "removed" });
        else if (entry.searchExclude && !after.searchExclude) changes.push({ field: `folders.${folder}`, kind: "search-exclude-dropped" });
      }
    }
  }
  if (sealed.properties !== null) {
    if (next.properties === null) changes.push({ field: "properties", kind: "axis-opened" });
    else {
      for (const [name, entry] of Object.entries(sealed.properties)) {
        changes.push(...propertyChanges(name, entry, Object.hasOwn(next.properties, name) ? next.properties[name] : undefined));
      }
    }
  }
  for (const [name, entry] of Object.entries(sealed.templates)) {
    changes.push(...templateChanges(name, entry, Object.hasOwn(next.templates, name) ? next.templates[name] : undefined, sealed.properties, next.properties));
  }
  return [...changes, ...overlapChanges(sealed, next)];
}

export function isNonLoosening(sealed: VaultContract, next: VaultContract): boolean {
  return looseningChanges(sealed, next).length === 0;
}
