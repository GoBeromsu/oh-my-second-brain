import { describe, expect, it } from "vitest";
import type { VaultContract } from "../contract/types.js";
import { semanticStage, tokenJaccard } from "./stage-semantic.js";

const folder = (meaning: string) => ({ meaning, searchExclude: false });
const property = (meaning: string) => ({ meaning, type: "text", default: null, required: false, rules: [] });

function contract(folders: Record<string, string>, properties: Record<string, string> = {}): VaultContract {
  return {
    folders: Object.fromEntries(Object.entries(folders).map(([key, meaning]) => [key, folder(meaning)])),
    properties: Object.fromEntries(Object.entries(properties).map(([key, meaning]) => [key, property(meaning)])),
  } as unknown as VaultContract;
}

const ANCHOR = contract({ Projects: "active work with a deadline" }, { status: "lifecycle stage of a note" });

describe("tokenJaccard", () => {
  it("scores shared lowercase tokens and treats two empty meanings as identical", () => {
    expect(tokenJaccard("Active Work", "active work")).toBe(1);
    expect(tokenJaccard("a b", "b c")).toBeCloseTo(1 / 3);
    expect(tokenJaccard("", "  ")).toBe(1);
    expect(tokenJaccard("", "x")).toBe(0);
  });
});

describe("semanticStage", () => {
  it("passes an unchanged contract with zero drift", () => {
    expect(semanticStage(ANCHOR, ANCHOR, ANCHOR)).toEqual({ overlaps: [], drift: 0, passed: true });
  });

  it("fails MECE when an added entry duplicates an existing meaning on purpose", () => {
    const candidate = contract({ Projects: "active work with a deadline", Work: "Active work with a deadline" }, { status: "lifecycle stage of a note" });
    const result = semanticStage(ANCHOR, ANCHOR, candidate);
    expect(result).toMatchObject({ passed: false, reason: "mece-overlap" });
    expect(result.overlaps).toEqual([{ axis: "folder", keys: ["Projects", "Work"], similarity: 1 }]);
  });

  it("ignores an overlap already sealed in the parent", () => {
    const both = contract({ A: "same words", B: "same words" });
    expect(semanticStage(both, both, both).passed).toBe(true);
  });

  it("compares meanings per axis only", () => {
    const candidate = contract({ Projects: "active work with a deadline" }, { status: "lifecycle stage of a note", phase: "active work with a deadline" });
    expect(semanticStage(ANCHOR, ANCHOR, candidate).overlaps).toEqual([]);
  });

  it("rejects drift 0.31 and accepts drift 0.3", () => {
    const anchor = contract({ Projects: "old" });
    const candidate = contract({ Projects: "new" });
    const rejected = semanticStage(anchor, anchor, candidate, { similarity: () => 0.69 });
    expect(rejected.drift).toBeCloseTo(0.31);
    expect(rejected).toMatchObject({ passed: false, reason: "drift" });
    expect(semanticStage(anchor, anchor, candidate, { similarity: () => 0.7 }).passed).toBe(true);
  });

  it("counts a removed anchor entry as full drift and an empty anchor as none", () => {
    const candidate = contract({ Projects: "active work with a deadline" });
    expect(semanticStage(ANCHOR, ANCHOR, candidate)).toMatchObject({ drift: 0.5, passed: false, reason: "drift" });
    const empty = contract({});
    expect(semanticStage(empty, empty, candidate)).toMatchObject({ drift: 0, passed: true });
  });

  it("treats null axes as empty", () => {
    const open = { folders: null, properties: null } as VaultContract;
    expect(semanticStage(open, open, open)).toEqual({ overlaps: [], drift: 0, passed: true });
  });
});
