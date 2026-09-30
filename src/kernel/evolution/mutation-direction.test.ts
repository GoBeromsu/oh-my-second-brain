import { describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import { applyMutations, type Mutation } from "../contract/mutation.js";
import type { FolderContract, PropertyContract, Rule, VaultContract } from "../contract/types.js";
import { classify, classifyAll, type Direction } from "./mutation-direction.js";

const folder = (searchExclude = false, meaning = "projects"): FolderContract => ({ meaning, searchExclude });
const property = (over: Partial<PropertyContract> = {}): PropertyContract => ({ meaning: "status", type: "text", default: null, required: false, rules: [], ...over });
const allowed = (...values: string[]): Rule => ({ kind: "allowed", values });

const PARENT: VaultContract = {
  folders: { Projects: folder(), Archive: folder(true, "old") },
  properties: {
    status: property({ rules: [allowed("a", "b", "c")] }),
    tags: property({ type: "tags", rules: [{ kind: "count", min: 1, max: 3 }] }),
    title: property({ type: "text", required: true }),
  },
};
const OPEN: VaultContract = { folders: null, properties: null };

const CASES: ReadonlyArray<readonly [string, Mutation, VaultContract, Direction]> = [
  ["folder ADD on a closed axis widens scope", { op: "ADD", axis: "folder", key: "Inbox", after: folder() }, PARENT, "loosening"],
  ["folder ADD on an open axis closes it", { op: "ADD", axis: "folder", key: "Inbox", after: folder() }, OPEN, "tightening"],
  ["folder REMOVE", { op: "REMOVE", axis: "folder", key: "Projects", before: folder() }, PARENT, "loosening"],
  ["folder searchExclude true→false", { op: "MODIFY", axis: "folder", key: "Archive", before: folder(true, "old"), after: folder(false, "old") }, PARENT, "loosening"],
  ["folder searchExclude false→true", { op: "MODIFY", axis: "folder", key: "Projects", before: folder(), after: folder(true) }, PARENT, "tightening"],
  ["folder meaning only", { op: "MODIFY", axis: "folder", key: "Projects", before: folder(), after: folder(false, "active work") }, PARENT, "neutral"],
  ["folder unknown field", { op: "MODIFY", axis: "folder", key: "Projects", before: folder(), after: { ...folder(), color: "red" } as unknown as FolderContract }, PARENT, "loosening"],
  ["property ADD on a closed axis", { op: "ADD", axis: "property", key: "due", after: property({ required: true }) }, PARENT, "loosening"],
  ["property ADD non-required on a closed axis", { op: "ADD", axis: "property", key: "due", after: property() }, PARENT, "loosening"],
  ["required property ADD on an open axis", { op: "ADD", axis: "property", key: "due", after: property({ required: true }) }, OPEN, "tightening"],
  ["property ADD with an unknown field", { op: "ADD", axis: "property", key: "due", after: { ...property(), extra: 1 } as unknown as PropertyContract }, OPEN, "loosening"],
  ["property REMOVE", { op: "REMOVE", axis: "property", key: "status", before: PARENT.properties!.status }, PARENT, "loosening"],
  ["required true→false", { op: "MODIFY", axis: "property", key: "title", before: PARENT.properties!.title, after: property({ type: "text", required: false }) }, PARENT, "loosening"],
  ["required false→true", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: property({ required: true, rules: [allowed("a", "b", "c")] }) }, PARENT, "tightening"],
  ["property type change", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: property({ type: "select", rules: [allowed("a", "b", "c")] }) }, PARENT, "loosening"],
  ["property meaning only", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: { ...PARENT.properties!.status!, meaning: "state" } }, PARENT, "neutral"],
  ["property default only", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: { ...PARENT.properties!.status!, default: "a" } }, PARENT, "neutral"],
  ["property rules narrowed", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: property({ rules: [allowed("a", "b")] }) }, PARENT, "tightening"],
  ["property rules widened", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: property({ rules: [allowed("a", "b", "c", "d")] }) }, PARENT, "loosening"],
  ["property rules with an unknown kind", { op: "MODIFY", axis: "property", key: "status", before: PARENT.properties!.status, after: property({ rules: [allowed("a"), { kind: "regex" } as unknown as Rule] }) }, PARENT, "loosening"],
  ["rule ADD", { op: "ADD", axis: "rule", key: "title", after: { kind: "pattern", regex: "[A-Z].*" } }, PARENT, "tightening"],
  ["rule ADD of an unknown kind", { op: "ADD", axis: "rule", key: "title", after: { kind: "shape" } as unknown as Rule }, PARENT, "loosening"],
  ["rule REMOVE", { op: "REMOVE", axis: "rule", key: "status", before: allowed("a", "b", "c") }, PARENT, "loosening"],
  ["allowed strict subset", { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a", "b") }, PARENT, "tightening"],
  ["allowed superset", { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a", "b", "c", "d") }, PARENT, "loosening"],
  ["allowed canonical-equal", { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a", "b", "c") }, PARENT, "neutral"],
  ["count.min lowered", { op: "MODIFY", axis: "rule", key: "tags", before: { kind: "count", min: 1, max: 3 }, after: { kind: "count", min: 0, max: 3 } }, PARENT, "loosening"],
  ["count.max raised", { op: "MODIFY", axis: "rule", key: "tags", before: { kind: "count", min: 1, max: 3 }, after: { kind: "count", min: 1, max: 5 } }, PARENT, "loosening"],
  ["count.max removed", { op: "MODIFY", axis: "rule", key: "tags", before: { kind: "count", min: 1, max: 3 }, after: { kind: "count", min: 1 } }, PARENT, "loosening"],
  ["count range narrowed", { op: "MODIFY", axis: "rule", key: "tags", before: { kind: "count", min: 1, max: 3 }, after: { kind: "count", min: 2, max: 2 } }, PARENT, "tightening"],
  ["pattern changed (incomparable)", { op: "MODIFY", axis: "rule", key: "title", before: { kind: "pattern", regex: "a+" }, after: { kind: "pattern", regex: "a" } }, PARENT, "loosening"],
  ["rule MODIFY on an unknown property", { op: "MODIFY", axis: "rule", key: "ghost", before: allowed("a"), after: allowed() }, PARENT, "loosening"],
  ["unknown op", { op: "RENAME", axis: "folder", key: "Projects", before: folder(), after: folder() } as unknown as Mutation, PARENT, "loosening"],
  ["unknown axis", { op: "ADD", axis: "template", key: "t", after: folder() } as unknown as Mutation, PARENT, "loosening"],
  ["not an object", null as unknown as Mutation, PARENT, "loosening"],
];

describe("classify", () => {
  it.each(CASES)("%s", (_name, mutation, parent, expected) => {
    expect(classify(mutation, parent)).toBe(expected);
  });

  it("an exception while classifying is loosening", () => {
    const hostile = { op: "MODIFY", axis: "rule", key: "status", get before(): Rule { throw new Error("boom"); } } as unknown as Mutation;
    expect(classify(hostile, PARENT)).toBe("loosening");
  });
});

describe("classifyAll", () => {
  it("is neutral for an empty list and for meaning-only changes", () => {
    expect(classifyAll([], PARENT)).toEqual({ direction: "neutral", each: [] });
    const meaning: Mutation = { op: "MODIFY", axis: "folder", key: "Projects", before: folder(), after: folder(false, "work") };
    expect(classifyAll([meaning], PARENT).direction).toBe("neutral");
  });

  it("is tightening when one mutation tightens and none loosen", () => {
    const list: Mutation[] = [
      { op: "MODIFY", axis: "folder", key: "Projects", before: folder(), after: folder(false, "work") },
      { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a") },
    ];
    expect(classifyAll(list, PARENT)).toEqual({ direction: "tightening", each: ["neutral", "tightening"] });
  });

  it("is loosening when any mutation loosens", () => {
    const list: Mutation[] = [
      { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a") },
      { op: "REMOVE", axis: "rule", key: "tags", before: { kind: "count", min: 1, max: 3 } },
    ];
    expect(classifyAll(list, PARENT)).toEqual({ direction: "loosening", each: ["tightening", "loosening"] });
  });

  it("classifies each mutation against the contract the earlier ones produced", () => {
    const list: Mutation[] = [
      { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b", "c"), after: allowed("a", "b") },
      { op: "MODIFY", axis: "rule", key: "status", before: allowed("a", "b"), after: allowed("a", "b", "c") },
    ];
    // Each step alone reads tightening then loosening; the list as a whole is loosening.
    expect(classifyAll(list, PARENT)).toEqual({ direction: "loosening", each: ["tightening", "loosening"] });
  });

  it("is loosening when the list does not apply", () => {
    const stale: Mutation = { op: "MODIFY", axis: "rule", key: "status", before: allowed("x"), after: allowed() };
    expect(classifyAll([stale], PARENT)).toEqual({ direction: "loosening", each: ["loosening"] });
  });
});

/**
 * Cross-check against the judge: under a tightening or neutral candidate, every note that
 * passes clean under the candidate also passed clean under the parent.
 */
describe("classifier agrees with the judge", () => {
  const values = [undefined, "a", "b", "c", "d", "", 3];
  const tagSets = [undefined, [], ["x"], ["x", "y"], ["x", "y", "z", "w"]];
  const folders = ["Projects/n.md", "Archive/n.md", "Inbox/n.md", "n.md"];
  const notes: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
  for (const path of folders) {
    for (const status of values) {
      for (const tags of tagSets) {
        for (const title of [undefined, "Title"]) {
          const frontmatter: Record<string, unknown> = {};
          if (status !== undefined) frontmatter.status = status;
          if (tags !== undefined) frontmatter.tags = tags;
          if (title !== undefined) frontmatter.title = title;
          notes.push({ path, frontmatter });
        }
      }
    }
    notes.push({ path, frontmatter: { due: "2026-01-01", title: "T" } });
  }
  const clean = (contract: VaultContract): Set<number> => new Set(notes.flatMap((note, index) =>
    judge({ ...note, body: "" }, { state: "sealed", contract }).warnings.length === 0 ? [index] : []));

  it.each(CASES.filter(([, mutation]) => mutation !== null))("%s", (_name, mutation, parent) => {
    let candidate: VaultContract;
    try {
      candidate = applyMutations(parent, [mutation]);
    } catch {
      expect(classifyAll([mutation], parent).direction).toBe("loosening");
      return;
    }
    const direction = classifyAll([mutation], parent).direction;
    if (direction === "loosening") return;
    const before = clean(parent);
    for (const index of clean(candidate)) expect(before.has(index), `${notes[index]!.path} ${JSON.stringify(notes[index]!.frontmatter)}`).toBe(true);
  });
});
