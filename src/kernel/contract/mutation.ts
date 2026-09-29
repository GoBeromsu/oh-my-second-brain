import { canonicalJson } from "../conventions/canonical.js";
import type { FolderContract, PropertyContract, Rule, VaultContract } from "./types.js";

/**
 * A contract change expressed as data: add, modify or remove one folder, property or
 * property rule. `applyMutations` is pure and deterministic; it never touches
 * the store and never seals. Every MODIFY and REMOVE names the value it expects to
 * replace (`before`), and an ADD expects nothing there, so a list drafted against one
 * contract is refused against another instead of silently overwriting a newer change.
 *
 * `key` names a folder path or a property name. On the `rule` axis the
 * key is the property whose rule list changes, and `before`/`after` are single rules.
 */

export type MutationOp = "ADD" | "MODIFY" | "REMOVE";
export type MutationAxis = "folder" | "property" | "rule";

export type Mutation =
  | { readonly op: MutationOp; readonly axis: "folder"; readonly key: string; readonly before?: FolderContract; readonly after?: FolderContract }
  | { readonly op: MutationOp; readonly axis: "property"; readonly key: string; readonly before?: PropertyContract; readonly after?: PropertyContract }
  | { readonly op: MutationOp; readonly axis: "rule"; readonly key: string; readonly before?: Rule; readonly after?: Rule };

export type MutationConflictKind =
  /** ADD found an entry already there. */
  | "exists"
  /** MODIFY or REMOVE found no entry (or, on the rule axis, no property). */
  | "missing"
  /** The entry there is not the `before` the mutation was drafted against. */
  | "before-mismatch"
  /** The mutation itself is malformed: a missing `before`/`after`, or one that must be absent. */
  | "malformed";

/** Refusal of a mutation list; `index` is the position of the first mutation that failed. Never carries a value. */
export class MutationConflict extends Error {
  readonly code = "CONTRACT_MUTATION_CONFLICT";

  constructor(readonly index: number, readonly axis: MutationAxis, readonly key: string, readonly kind: MutationConflictKind) {
    super(`CONTRACT_MUTATION_CONFLICT: mutation ${index} (${axis} ${JSON.stringify(key)}) was refused: ${kind}`);
    this.name = "MutationConflict";
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Checks the op's shape and that the current entry is what the mutation expects. */
function expect(index: number, mutation: Mutation, current: unknown): void {
  const { op, axis, key, before, after } = mutation;
  const fail = (kind: MutationConflictKind): never => {
    throw new MutationConflict(index, axis, key, kind);
  };
  if (op === "ADD") {
    if (before !== undefined || after === undefined) fail("malformed");
    if (current !== undefined) fail("exists");
    return;
  }
  if (before === undefined || (op === "MODIFY") !== (after !== undefined)) fail("malformed");
  if (current === undefined) fail("missing");
  if (!same(current, before)) fail("before-mismatch");
}

function entry<T>(record: Readonly<Record<string, T>> | null, key: string): T | undefined {
  return record !== null && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A new record with `key` set to `value`, or removed when `value` is undefined. An open (null) axis starts empty. */
function put<T>(record: Readonly<Record<string, T>> | null, key: string, value: T | undefined): Record<string, T> {
  const next: Record<string, T> = { ...record ?? {} };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function applyOne(contract: VaultContract, mutation: Mutation, index: number): VaultContract {
  switch (mutation.axis) {
    case "folder":
      expect(index, mutation, entry(contract.folders, mutation.key));
      return { ...contract, folders: put(contract.folders, mutation.key, mutation.after) };
    case "property":
      expect(index, mutation, entry(contract.properties, mutation.key));
      return { ...contract, properties: put(contract.properties, mutation.key, mutation.after) };
    case "rule": {
      const property = entry(contract.properties, mutation.key);
      if (property === undefined) throw new MutationConflict(index, "rule", mutation.key, "missing");
      const target = mutation.op === "ADD" ? mutation.after : mutation.before;
      const position = target === undefined ? -1 : property.rules.findIndex(rule => same(rule, target));
      expect(index, mutation, position === -1 ? undefined : property.rules[position]);
      const rules = mutation.op === "ADD"
        ? [...property.rules, mutation.after!]
        : property.rules.flatMap((rule, at) => at !== position ? [rule] : mutation.after === undefined ? [] : [mutation.after]);
      return { ...contract, properties: put(contract.properties, mutation.key, { ...property, rules }) };
    }
  }
}

/**
 * Applies `list` in order and returns the resulting contract; `contract` is not changed.
 * The whole list is refused with the first MutationConflict, so a partial result is
 * never returned.
 */
export function applyMutations(contract: VaultContract, list: readonly Mutation[]): VaultContract {
  return list.reduce(applyOne, contract);
}
