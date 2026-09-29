import { canonicalJson } from "../conventions/canonical.js";
import { singleValued } from "../contract/judge.js";
import { implies, isNonLoosening, looseningChanges } from "../contract/loosening.js";
import { applyMutations, type Mutation } from "../contract/mutation.js";
import type { FolderContract, PropertyContract, Rule, VaultContract } from "../contract/types.js";

/**
 * Which way one contract mutation moves the set of notes the judge passes clean:
 *   - `tightening`: every note clean after it was clean before (fewer or equal clean notes);
 *   - `neutral`: the judge sees no difference (a meaning or default change);
 *   - `loosening`: some note may pass that did not, or the direction cannot be proven.
 *
 * Fail-closed: an unknown op, axis or field, values that cannot be compared (a changed
 * regex), a malformed mutation or any exception classifies as `loosening`. A mutation
 * only ever moves toward an autonomous seal when it is proven tightening or neutral.
 *
 * Registering a new folder or property on a closed axis accepts notes that the parent
 * warned about (`unregistered-folder`, `unknown-property`), so it is loosening even when
 * the new property is required. The same ADD on an open (null) axis closes the axis,
 * which only adds warnings, so it is tightening.
 */

export type Direction = "tightening" | "neutral" | "loosening";

const FOLDER_KEYS = new Set(["meaning", "searchExclude"]);
const PROPERTY_KEYS = new Set(["meaning", "type", "default", "required", "rules"]);
const RULE_KINDS = new Set(["allowed", "fixed", "pattern", "range", "count"]);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownShape(value: unknown, keys: ReadonlySet<string>): boolean {
  return record(value) && Object.keys(value).every(key => keys.has(key));
}

function knownRule(value: unknown): value is Rule {
  return record(value) && typeof value.kind === "string" && RULE_KINDS.has(value.kind);
}

function folderDirection(m: Extract<Mutation, { axis: "folder" }>, parent: VaultContract): Direction {
  if (m.op === "ADD") return knownShape(m.after, FOLDER_KEYS) && parent.folders === null ? "tightening" : "loosening";
  if (m.op !== "MODIFY") return "loosening";
  if (!knownShape(m.before, FOLDER_KEYS) || !knownShape(m.after, FOLDER_KEYS)) return "loosening";
  const before = m.before as FolderContract;
  const after = m.after as FolderContract;
  if (before.searchExclude === after.searchExclude) return "neutral";
  return after.searchExclude === true ? "tightening" : "loosening";
}

function propertyDirection(m: Extract<Mutation, { axis: "property" }>, parent: VaultContract): Direction {
  if (m.op === "ADD") {
    if (!knownShape(m.after, PROPERTY_KEYS)) return "loosening";
    return parent.properties === null ? "tightening" : "loosening";
  }
  if (m.op !== "MODIFY") return "loosening";
  if (!knownShape(m.before, PROPERTY_KEYS) || !knownShape(m.after, PROPERTY_KEYS)) return "loosening";
  const before = m.before as PropertyContract;
  const after = m.after as PropertyContract;
  if (!Array.isArray(after.rules) || !after.rules.every(knownRule)) return "loosening";
  const wrap = (property: PropertyContract): VaultContract => ({ folders: null, properties: { [m.key]: property } });
  if (looseningChanges(wrap(before), wrap(after)).length > 0) return "loosening";
  if (before.required !== after.required || !same(before.rules, after.rules)) return "tightening";
  return "neutral";
}

function ruleDirection(m: Extract<Mutation, { axis: "rule" }>, parent: VaultContract): Direction {
  if (m.op === "ADD") return knownRule(m.after) ? "tightening" : "loosening";
  if (m.op !== "MODIFY") return "loosening";
  if (!knownRule(m.before) || !knownRule(m.after)) return "loosening";
  if (same(m.before, m.after)) return "neutral";
  const property = parent.properties !== null && Object.hasOwn(parent.properties, m.key) ? parent.properties[m.key] : undefined;
  if (property === undefined) return "loosening";
  return implies(m.after, m.before, singleValued(property.type)) ? "tightening" : "loosening";
}

/** The direction of one mutation applied to `parent` (the contract just before it). */
export function classify(m: Mutation, parent: VaultContract): Direction {
  try {
    if (!record(m)) return "loosening";
    switch (m.axis) {
      case "folder": return folderDirection(m, parent);
      case "property": return propertyDirection(m, parent);
      case "rule": return ruleDirection(m, parent);
      default: return "loosening";
    }
  } catch {
    return "loosening";
  }
}

export interface ListDirection {
  readonly direction: Direction;
  /** One direction per mutation, each against the contract the earlier mutations produced. */
  readonly each: readonly Direction[];
}

/**
 * The direction of a whole list: loosening when any mutation is, when the list does not
 * apply, or when the result loosens the parent by the reseal check; otherwise tightening
 * when any mutation tightens; otherwise neutral.
 */
export function classifyAll(list: readonly Mutation[], parent: VaultContract): ListDirection {
  const each: Direction[] = [];
  let current = parent;
  let applied = 0;
  try {
    for (const mutation of list) {
      each.push(classify(mutation, current));
      current = applyMutations(current, [mutation]);
      applied += 1;
    }
    if (!isNonLoosening(parent, current)) return { direction: "loosening", each };
  } catch {
    // The mutation that failed to apply, and every one after it, cannot be proven.
    each.length = Math.min(each.length, applied);
    while (each.length < list.length) each.push("loosening");
    return { direction: "loosening", each };
  }
  if (each.includes("loosening")) return { direction: "loosening", each };
  return { direction: each.includes("tightening") ? "tightening" : "neutral", each };
}
