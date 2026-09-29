import { posix } from "node:path";
import { canonicalJson, compareCodePoints } from "../conventions/canonical.js";
import type { GapRecord } from "../contract/gap-ledger.js";
import { applyMutations, type Mutation } from "../contract/mutation.js";
import type { FieldType, JsonScalar, PropertyContract, Rule, VaultContract } from "../contract/types.js";

/**
 * The maker: turns the open gap ledger into a draft of generation N+1 as a mutation list
 * against the parent contract. It is pure and deterministic — it reads no store, writes
 * nothing and cannot reach the seal API; the evaluator judges its draft and only the
 * seal-gate seals. Every gap gets a disposition, so nothing the writer hit is lost silently.
 *
 * What it drafts (axes only; there is no template axis):
 * - a `value` gap on a property with an `allowed` rule adds the wanted value(s) to that rule;
 * - a `folder` gap on a folder the contract does not register adds the folder;
 * - a `property` gap on a property the contract does not name adds it (not required, no rules).
 * A `template` gap and a `choice` gap are declined; anything else is deferred to the owner.
 */

export type GapDisposition = "applied" | "declined" | "deferred";

export interface GapDecision {
  readonly gapId: string;
  readonly disposition: GapDisposition;
  readonly reason: string;
  /** The mutation that answers the gap when it was applied. */
  readonly mutationIndex?: number;
}

export interface MakerInput {
  readonly parent: VaultContract;
  /** The store sequence of the parent generation. */
  readonly parentGeneration: number;
  readonly parentDigest: string;
  readonly gaps: readonly GapRecord[];
}

export interface MakerDraft {
  readonly generation: number;
  readonly parentDigest: string;
  readonly mutations: readonly Mutation[];
  readonly dispositions: readonly GapDecision[];
}

type Target = { readonly axis: "folder" | "property" | "value"; readonly key: string };

function isScalar(value: unknown): value is JsonScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function wantedValues(gap: GapRecord): JsonScalar[] {
  const value = gap.wanted.value;
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(isScalar);
}

function typeOf(gap: GapRecord): FieldType {
  const value = gap.wanted.value;
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  return "text";
}

function has<T>(record: Readonly<Record<string, T>> | null, key: string): boolean {
  return record !== null && Object.hasOwn(record, key);
}

function allowedRule(property: PropertyContract | undefined): Extract<Rule, { kind: "allowed" }> | undefined {
  return property?.rules.find((rule): rule is Extract<Rule, { kind: "allowed" }> => rule.kind === "allowed");
}

/** The target a gap asks to change, or the reason it is not the maker's to draft. */
function targetOf(gap: GapRecord, parent: VaultContract): Target | { readonly skip: GapDisposition; readonly reason: string } {
  if (gap.axis === "template") return { skip: "declined", reason: "no-template-axis" };
  if (gap.kind === "choice") return { skip: "declined", reason: "writer-chose-inside-frame" };
  if (gap.axis === "folder") {
    const folder = posix.dirname(gap.notePath);
    if (folder === "." || folder === "") return { skip: "deferred", reason: "vault-root-note" };
    if (parent.folders === null || has(parent.folders, folder)) return { skip: "declined", reason: "folder-already-allowed" };
    return { axis: "folder", key: folder };
  }
  if (gap.axis === "property") {
    if (parent.properties === null) return { skip: "declined", reason: "property-axis-open" };
    if (has(parent.properties, gap.wanted.field)) return { skip: "deferred", reason: "property-exists" };
    return { axis: "property", key: gap.wanted.field };
  }
  const property = has(parent.properties, gap.wanted.field) ? parent.properties![gap.wanted.field] : undefined;
  const rule = allowedRule(property);
  if (rule === undefined) return { skip: "deferred", reason: "no-allowed-rule" };
  const known = new Set(rule.values.map(value => canonicalJson(value)));
  const values = wantedValues(gap);
  if (values.length === 0) return { skip: "deferred", reason: "no-wanted-value" };
  if (values.every(value => known.has(canonicalJson(value)))) return { skip: "declined", reason: "value-already-allowed" };
  return { axis: "value", key: gap.wanted.field };
}

function draftFor(target: Target, gaps: readonly GapRecord[], parent: VaultContract): Mutation {
  if (target.axis === "folder") {
    return { op: "ADD", axis: "folder", key: target.key, after: { meaning: `notes filed under ${target.key}`, searchExclude: false } };
  }
  if (target.axis === "property") {
    return { op: "ADD", axis: "property", key: target.key, after: { meaning: target.key, type: typeOf(gaps[0]!), default: false, required: false, rules: [] } };
  }
  const before = allowedRule(parent.properties![target.key])!;
  const values = [...before.values];
  const seen = new Set(values.map(value => canonicalJson(value)));
  for (const value of gaps.flatMap(wantedValues)) {
    const key = canonicalJson(value);
    if (!seen.has(key)) {
      seen.add(key);
      values.push(value);
    }
  }
  return { op: "MODIFY", axis: "rule", key: target.key, before, after: { kind: "allowed", values } };
}

/**
 * Drafts generation N+1 from the open gaps. Gaps are taken in (at, id) order and grouped
 * by target, so two notes wanting the same value yield one mutation. The draft is checked
 * against the parent with `applyMutations` before it is returned.
 */
export function draftEvolution(input: MakerInput): MakerDraft {
  const ordered = [...input.gaps].sort((left, right) => left.at - right.at || compareCodePoints(left.id, right.id));
  const groups = new Map<string, { target: Target; gaps: GapRecord[] }>();
  const decisions = new Map<string, Omit<GapDecision, "gapId"> | string>();
  for (const gap of ordered) {
    if (decisions.has(gap.id)) continue;
    const target = targetOf(gap, input.parent);
    if ("skip" in target) {
      decisions.set(gap.id, { disposition: target.skip, reason: target.reason });
      continue;
    }
    const key = `${target.axis}\u0000${target.key}`;
    const group = groups.get(key) ?? { target, gaps: [] };
    group.gaps.push(gap);
    groups.set(key, group);
    decisions.set(gap.id, key);
  }
  const mutations: Mutation[] = [];
  const indexOf = new Map<string, number>();
  for (const [key, group] of groups) {
    indexOf.set(key, mutations.length);
    mutations.push(draftFor(group.target, group.gaps, input.parent));
  }
  applyMutations(input.parent, mutations);
  const dispositions = [...decisions].map(([gapId, decision]): GapDecision => typeof decision === "string"
    ? { gapId, disposition: "applied", reason: groups.get(decision)!.target.axis === "value" ? "value-added" : `${groups.get(decision)!.target.axis}-added`, mutationIndex: indexOf.get(decision)! }
    : { gapId, ...decision });
  return { generation: input.parentGeneration + 1, parentDigest: input.parentDigest, mutations, dispositions };
}
