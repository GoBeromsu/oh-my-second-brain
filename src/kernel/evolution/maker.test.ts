import { describe, expect, it } from "vitest";
import type { GapRecord } from "../contract/gap-ledger.js";
import { applyMutations } from "../contract/mutation.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { draftEvolution } from "./maker.js";

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = {
  folders: { Projects: { meaning: "projects", searchExclude: false } },
  properties: { status: status(["a"]), title: { meaning: "title", type: "text", default: false, required: true, rules: [] } },
};

let seq = 0;
function gap(extra: Partial<GapRecord>): GapRecord {
  seq += 1;
  return {
    id: `gap-${String(seq).padStart(3, "0")}`,
    at: 1000 + seq,
    notePath: "Projects/n.md",
    noteRevision: "sha256:note",
    contractRevision: "sha256:parent",
    axis: "value",
    kind: "kept",
    chosen: null,
    wanted: { field: "status", value: "b" },
    reason: "kept: not-allowed",
    ...extra,
  } as GapRecord;
}

const draft = (gaps: GapRecord[], parent: VaultContract = PARENT) => draftEvolution({ parent, parentGeneration: 4, parentDigest: "sha256:parent", gaps });

describe("draftEvolution", () => {
  it("drafts generation N+1 against the parent digest", () => {
    const result = draft([]);
    expect(result).toEqual({ generation: 5, parentDigest: "sha256:parent", mutations: [], dispositions: [] });
  });

  it("adds a wanted value to the allowed rule and applies cleanly", () => {
    const one = gap({});
    const result = draft([one]);
    expect(result.mutations).toEqual([{ op: "MODIFY", axis: "rule", key: "status", before: { kind: "allowed", values: ["a"] }, after: { kind: "allowed", values: ["a", "b"] } }]);
    expect(result.dispositions).toEqual([{ gapId: one.id, disposition: "applied", reason: "value-added", mutationIndex: 0 }]);
    expect(applyMutations(PARENT, result.mutations).properties?.status?.rules).toEqual([{ kind: "allowed", values: ["a", "b"] }]);
  });

  it("merges gaps on one property into a single mutation, deduping values", () => {
    const first = gap({ kind: "no-fit", wanted: { field: "status", value: "b" } });
    const second = gap({ kind: "fixed", wanted: { field: "status", value: ["b", "c", "a"] } });
    const result = draft([second, first]);
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]).toMatchObject({ after: { kind: "allowed", values: ["a", "b", "c"] } });
    expect(result.dispositions.map(item => item.mutationIndex)).toEqual([0, 0]);
  });

  it("adds an unregistered folder and an unknown property", () => {
    const folder = gap({ axis: "folder", notePath: "Areas/Health/x.md", wanted: { field: "path" } });
    const numeric = gap({ axis: "property", wanted: { field: "score", value: 3 } });
    const flag = gap({ axis: "property", wanted: { field: "done", value: true } });
    const list = gap({ axis: "property", wanted: { field: "topics", value: ["x"] } });
    const plain = gap({ axis: "property", wanted: { field: "note" } });
    const result = draft([folder, numeric, flag, list, plain]);
    expect(result.mutations).toEqual([
      { op: "ADD", axis: "folder", key: "Areas/Health", after: { meaning: "notes filed under Areas/Health", searchExclude: false } },
      { op: "ADD", axis: "property", key: "score", after: { meaning: "score", type: "number", default: false, required: false, rules: [] } },
      { op: "ADD", axis: "property", key: "done", after: { meaning: "done", type: "checkbox", default: false, required: false, rules: [] } },
      { op: "ADD", axis: "property", key: "topics", after: { meaning: "topics", type: "list", default: false, required: false, rules: [] } },
      { op: "ADD", axis: "property", key: "note", after: { meaning: "note", type: "text", default: false, required: false, rules: [] } },
    ]);
    expect(result.dispositions.map(item => item.reason)).toEqual(["folder-added", "property-added", "property-added", "property-added", "property-added"]);
  });

  it.each([
    ["template axis", { axis: "template", kind: "choice", wanted: { field: "template", value: ["A", "B"] } }, "declined", "no-template-axis"],
    ["writer's choice", { axis: "value", kind: "choice" }, "declined", "writer-chose-inside-frame"],
    ["vault-root note", { axis: "folder", notePath: "x.md", wanted: { field: "path" } }, "deferred", "vault-root-note"],
    ["registered folder", { axis: "folder", notePath: "Projects/y.md", wanted: { field: "path" } }, "declined", "folder-already-allowed"],
    ["existing property", { axis: "property", wanted: { field: "title" } }, "deferred", "property-exists"],
    ["property without an allowed rule", { wanted: { field: "title", value: "x" } }, "deferred", "no-allowed-rule"],
    ["unknown property value", { wanted: { field: "nope", value: "x" } }, "deferred", "no-allowed-rule"],
    ["value gap without a value", { wanted: { field: "status" } }, "deferred", "no-wanted-value"],
    ["value already allowed", { wanted: { field: "status", value: "a" } }, "declined", "value-already-allowed"],
  ] as const)("does not draft a %s", (_name, extra, disposition, reason) => {
    const one = gap(extra as Partial<GapRecord>);
    const result = draft([one]);
    expect(result.mutations).toEqual([]);
    expect(result.dispositions).toEqual([{ gapId: one.id, disposition, reason }]);
  });

  it("declines folder and property gaps on an open axis", () => {
    const open: VaultContract = { folders: null, properties: null };
    const folder = gap({ axis: "folder", notePath: "New/x.md", wanted: { field: "path" } });
    const property = gap({ axis: "property", wanted: { field: "x" } });
    expect(draft([folder, property], open).dispositions.map(item => item.reason)).toEqual(["folder-already-allowed", "property-axis-open"]);
  });

  it("is deterministic in (at, id) order and answers a repeated gap id once", () => {
    const early = gap({ at: 1, wanted: { field: "status", value: "z" } });
    const late = gap({ at: 2, wanted: { field: "status", value: "y" } });
    const result = draft([late, early, early]);
    expect(result.mutations[0]).toMatchObject({ after: { values: ["a", "z", "y"] } });
    expect(result.dispositions.map(item => item.gapId)).toEqual([early.id, late.id]);
    expect(draft([early, late])).toEqual(result);
  });
});
