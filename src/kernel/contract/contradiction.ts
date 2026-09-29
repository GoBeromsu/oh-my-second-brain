import { compareCodePoints } from "../conventions/canonical.js";
import type { JsonScalar, Rule, VaultContract } from "./types.js";

/**
 * Contradictions inside a sealed contract: rules no note can ever satisfy. They are the
 * fourth kind of write ambiguity. A write cannot fix them, so it is refused as usual and
 * nothing is recorded as a gap; `oms doctor gaps` reports them for the owner to fix
 * through the interview. Every finding names a field and a kind, never a value.
 */

export type ContradictionKind =
  /** A `count` rule whose min is above its max. */
  | "count-bounds"
  /** A `range` rule whose min is above its max. */
  | "range-bounds"
  /** An `allowed` rule with no values. */
  | "allowed-empty"
  /** A `fixed` value that an `allowed` rule on the same property excludes. */
  | "fixed-not-allowed";

export interface Contradiction {
  /** A property name. */
  readonly field: string;
  readonly kind: ContradictionKind;
}

function above(min: number | string | undefined, max: number | string | undefined): boolean {
  if (min === undefined || max === undefined || typeof min !== typeof max) return false;
  return typeof min === "number" ? min > (max as number) : compareCodePoints(min as string, max as string) > 0;
}

function sameScalar(left: JsonScalar, right: JsonScalar): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ruleContradictions(field: string, rules: readonly Rule[]): Contradiction[] {
  const found: Contradiction[] = [];
  for (const rule of rules) {
    if (rule.kind === "count" && above(rule.min, rule.max)) found.push({ field, kind: "count-bounds" });
    if (rule.kind === "range" && above(rule.min, rule.max)) found.push({ field, kind: "range-bounds" });
    if (rule.kind === "allowed" && rule.values.length === 0) found.push({ field, kind: "allowed-empty" });
  }
  for (const fixed of rules) {
    if (fixed.kind !== "fixed") continue;
    const excluded = rules.some(rule => rule.kind === "allowed" && rule.values.length > 0 && !rule.values.some(value => sameScalar(value, fixed.value)));
    if (excluded) found.push({ field, kind: "fixed-not-allowed" });
  }
  return found;
}

/**
 * Every contradiction in `contract`, sorted by field then kind; empty for a consistent
 * contract. Only property rules count: templates scaffold notes and add no rule.
 */
export function contractContradictions(contract: VaultContract): readonly Contradiction[] {
  const found: Contradiction[] = [];
  for (const [name, property] of Object.entries(contract.properties ?? {})) found.push(...ruleContradictions(name, property.rules));
  const unique = new Map(found.map(entry => [`${entry.field}\u0000${entry.kind}`, entry]));
  return [...unique.values()].sort((left, right) => compareCodePoints(left.field, right.field) || compareCodePoints(left.kind, right.kind));
}
