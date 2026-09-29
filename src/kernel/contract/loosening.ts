import { singleValued } from "./judge.js";
import { patternRefusal } from "./pattern.js";
import type { FieldType, JsonScalar, PropertyContract, Rule, VaultContract } from "./types.js";

/**
 * Monotonic reseal check for a contract sealed without a terminal: the next contract
 * may add entries and tighten folder and property rules, never loosen them. Templates
 * are not contract, so they never enter this check. Each change names a field path and a kind only,
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
  | "count-widened"
  | "pattern-unsafe";

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
export function implies(next: Rule, sealed: Rule, single: boolean): boolean {
  if (sealed.kind === "allowed" && next.kind === "allowed") return next.values.every(value => sealed.values.some(known => sameScalar(known, value)));
  if (sealed.kind === "allowed" && next.kind === "fixed") return single && sealed.values.some(known => sameScalar(known, next.value));
  if (sealed.kind === "fixed" && next.kind === "fixed") return sameScalar(sealed.value, next.value);
  if (sealed.kind === "fixed" && next.kind === "allowed") return single && next.values.length > 0 && next.values.every(value => sameScalar(sealed.value, value));
  if (sealed.kind === "pattern" && next.kind === "pattern") return sealed.regex === next.regex;
  if (sealed.kind === "range" && next.kind === "range") return boundHolds(sealed.min, next.min, true) && boundHolds(sealed.max, next.max, false);
  if (sealed.kind === "count" && next.kind === "count") return boundHolds(sealed.min, next.min, true) && boundHolds(sealed.max, next.max, false);
  return false;
}

const WIDENED: Readonly<Record<Rule["kind"], LooseningKind>> = {
  allowed: "allowed-widened",
  fixed: "fixed-changed",
  pattern: "pattern-changed",
  range: "range-widened",
  count: "count-widened",
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

/**
 * Sealed pattern rules the seal screen now refuses (for example a source over the length
 * cap sealed by an older release). The judge fails every value against such a rule, and
 * any replacement is looser, so only the owner at a terminal can replace it.
 */
export function unsafePatternChanges(contract: VaultContract): LooseningChange[] {
  return Object.entries(contract.properties ?? {})
    .map(([name, property]) => [`properties.${name}`, property.rules] as const)
    .filter(([, rules]) => rules.some(rule => rule.kind === "pattern" && patternRefusal(rule.regex) !== null))
    .map(([field]) => ({ field, kind: "pattern-unsafe" as const }));
}

/**
 * Every way `next` accepts a note or exposes a folder that `sealed` did not.
 * Tighter folder and property rules are not changes: a write records only the warnings
 * the note did not already have, so notes that fail a stricter rule are not blocked.
 * Adding a folder or a property is not a change either, although it widens a
 * closed axis by registering a new entry: that is the "add" in add-or-tighten. A changed
 * property type counts as loosening even when it would be narrower.
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
  return changes;
}

export function isNonLoosening(sealed: VaultContract, next: VaultContract): boolean {
  return looseningChanges(sealed, next).length === 0;
}
