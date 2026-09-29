import { describe, expect, it } from "vitest";
import { applyMutations, MutationConflict, type Mutation, type MutationConflictKind } from "./mutation.js";
import type { PropertyContract, Rule, TemplateContract, VaultContract } from "./types.js";

const HASH = `sha256:${"a".repeat(64)}`;

function property(rules: readonly Rule[] = []): PropertyContract {
  return { meaning: "", type: "text", default: false, required: false, rules };
}

const TEMPLATE: TemplateContract = { source: "Templates/Meeting.md", sourceHash: HASH, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
const ALLOWED: Rule = { kind: "allowed", values: ["open", "done"] };
const COUNT: Rule = { kind: "count", max: 3 };

const BASE: VaultContract = {
  folders: { Inbox: { meaning: "inbox", searchExclude: false } },
  properties: { status: property([ALLOWED]) },
  templates: { Meeting: TEMPLATE },
};

function conflict(contract: VaultContract, list: readonly Mutation[]): { index: number; axis: string; key: string; kind: MutationConflictKind } {
  try {
    applyMutations(contract, list);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(MutationConflict);
    const refused = error as MutationConflict;
    expect(refused.code).toBe("CONTRACT_MUTATION_CONFLICT");
    expect(refused.message).not.toContain("inbox");
    return { index: refused.index, axis: refused.axis, key: refused.key, kind: refused.kind };
  }
  throw new Error("expected a MutationConflict");
}

describe("applyMutations", () => {
  it("returns the same contract for an empty list", () => {
    expect(applyMutations(BASE, [])).toBe(BASE);
  });

  it("adds, modifies and removes on the folder and property axes without changing the input", () => {
    const snapshot = JSON.stringify(BASE);
    const archive = { meaning: "archive", searchExclude: true };
    const next = applyMutations(BASE, [
      { op: "ADD", axis: "folder", key: "Archive", after: archive },
      { op: "MODIFY", axis: "folder", key: "Inbox", before: BASE.folders!["Inbox"]!, after: { meaning: "in", searchExclude: false } },
      { op: "ADD", axis: "property", key: "mood", after: property() },
      { op: "REMOVE", axis: "property", key: "status", before: property([ALLOWED]) },
    ]);
    expect(next).toEqual({
      folders: { Inbox: { meaning: "in", searchExclude: false }, Archive: archive },
      properties: { mood: property() },
      templates: { Meeting: TEMPLATE },
    });
    expect(JSON.stringify(BASE)).toBe(snapshot);
  });

  it("starts an open (null) axis empty on ADD", () => {
    const open: VaultContract = { folders: null, properties: null, templates: {} };
    expect(applyMutations(open, [
      { op: "ADD", axis: "folder", key: "Inbox", after: { meaning: "", searchExclude: false } },
      { op: "ADD", axis: "property", key: "status", after: property() },
    ])).toEqual({ folders: { Inbox: { meaning: "", searchExclude: false } }, properties: { status: property() }, templates: {} });
    expect(conflict(open, [{ op: "REMOVE", axis: "folder", key: "Inbox", before: { meaning: "", searchExclude: false } }])).toMatchObject({ kind: "missing" });
  });

  it("compares before canonically, so key order does not matter", () => {
    const reordered = { searchExclude: false, meaning: "inbox" };
    expect(applyMutations(BASE, [{ op: "REMOVE", axis: "folder", key: "Inbox", before: reordered }]).folders).toEqual({});
  });

  it("adds, modifies and removes a single rule on a property", () => {
    const added = applyMutations(BASE, [{ op: "ADD", axis: "rule", key: "status", after: COUNT }]);
    expect(added.properties!["status"]!.rules).toEqual([ALLOWED, COUNT]);
    const modified = applyMutations(added, [{ op: "MODIFY", axis: "rule", key: "status", before: COUNT, after: { kind: "count", max: 2 } }]);
    expect(modified.properties!["status"]!.rules).toEqual([ALLOWED, { kind: "count", max: 2 }]);
    const removed = applyMutations(modified, [{ op: "REMOVE", axis: "rule", key: "status", before: ALLOWED }]);
    expect(removed.properties!["status"]!.rules).toEqual([{ kind: "count", max: 2 }]);
  });

  it("refuses the whole list at the first conflict with its index, axis, key and kind", () => {
    const inbox = BASE.folders!["Inbox"]!;
    const cases: Array<[Mutation, MutationConflictKind]> = [
      [{ op: "ADD", axis: "folder", key: "Inbox", after: inbox }, "exists"],
      [{ op: "ADD", axis: "folder", key: "New", before: inbox, after: inbox }, "malformed"],
      [{ op: "ADD", axis: "folder", key: "New" }, "malformed"],
      [{ op: "MODIFY", axis: "folder", key: "Inbox", after: inbox }, "malformed"],
      [{ op: "MODIFY", axis: "folder", key: "Inbox", before: inbox }, "malformed"],
      [{ op: "REMOVE", axis: "folder", key: "Inbox", before: inbox, after: inbox }, "malformed"],
      [{ op: "REMOVE", axis: "folder", key: "Gone", before: inbox }, "missing"],
      [{ op: "MODIFY", axis: "property", key: "status", before: property(), after: property() }, "before-mismatch"],
      [{ op: "ADD", axis: "rule", key: "status", after: ALLOWED }, "exists"],
      [{ op: "ADD", axis: "rule", key: "nobody", after: COUNT }, "missing"],
      [{ op: "REMOVE", axis: "rule", key: "status", before: COUNT }, "missing"],
      [{ op: "REMOVE", axis: "rule", key: "status" }, "malformed"],
    ];
    for (const [mutation, kind] of cases) {
      const valid: Mutation = { op: "ADD", axis: "property", key: "mood", after: property() };
      expect(conflict(BASE, [valid, mutation])).toEqual({ index: 1, axis: mutation.axis, key: mutation.key, kind });
    }
  });

  it("applies later mutations to the result of earlier ones", () => {
    expect(conflict(BASE, [
      { op: "REMOVE", axis: "property", key: "status", before: property([ALLOWED]) },
      { op: "ADD", axis: "rule", key: "status", after: COUNT },
    ])).toEqual({ index: 1, axis: "rule", key: "status", kind: "missing" });
  });
});
