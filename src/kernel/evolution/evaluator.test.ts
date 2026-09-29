import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existingStateDir } from "../contract/state-dir.js";
import { judge } from "../contract/judge.js";
import type { Mutation } from "../contract/mutation.js";
import { sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { anchorContract, evaluateCandidate, routeOf } from "./evaluator.js";
import type { MechanicalResult, NoteJudge } from "./stage-mechanical.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const modify = (values: string[]): Mutation => ({ op: "MODIFY", axis: "rule", key: "status", before: { kind: "allowed", values: ["a", "b"] }, after: { kind: "allowed", values } });

let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evaluator-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await writeFile(join(vault, "Projects", "a.md"), "---\nstatus: a\n---\n");
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

describe("evaluateCandidate", () => {
  it("routes a tightening list that adds no warning to the quorum", async () => {
    const result = await evaluateCandidate({ vault, parent: PARENT, mutations: [modify(["a"])] });
    expect(result.candidate.properties?.status?.rules).toEqual([{ kind: "allowed", values: ["a"] }]);
    expect(result).toMatchObject({ direction: "tightening", route: "consensus", stage1: { newRefusals: 0, warningDelta: 0, passed: true }, stage2: { passed: true } });
  });

  it("routes rising warnings to the owner", async () => {
    await writeFile(join(vault, "Projects", "b.md"), "---\nstatus: b\n---\n");
    const result = await evaluateCandidate({ vault, parent: PARENT, mutations: [modify(["a"])] });
    expect(result).toMatchObject({ direction: "tightening", route: "awaiting-human", stage1: { warningDelta: 1 } });
  });

  it("routes a loosening list to the owner even when it clears warnings", async () => {
    await writeFile(join(vault, "Projects", "c.md"), "---\nstatus: c\n---\n");
    const result = await evaluateCandidate({ vault, parent: PARENT, mutations: [modify(["a", "b", "c"])] });
    expect(result).toMatchObject({ direction: "loosening", route: "awaiting-human", stage1: { warningDelta: -1 } });
  });

  it("rejects a candidate that makes the judge refuse a note", async () => {
    const refusing: NoteJudge = (input, view) => view.state === "sealed" && view.contract !== PARENT
      ? { ...judge(input, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(input, view);
    const result = await evaluateCandidate({ vault, parent: PARENT, mutations: [modify(["a"])] }, { judge: refusing });
    expect(result).toMatchObject({ route: "reject", stage1: { newRefusals: 1, passed: false } });
  });

  it("measures drift from the anchor with the injected similarity, advisory only", async () => {
    const anchor: VaultContract = { folders: { Projects: { meaning: "something else entirely", searchExclude: false } }, properties: PARENT.properties };
    const result = await evaluateCandidate({ vault, parent: PARENT, mutations: [modify(["a"])], anchor }, { similarity: () => 0 });
    expect(result.stage2).toMatchObject({ passed: false });
    expect(result.route).toBe("consensus");
  });

  it("throws the conflict of a list that does not apply", async () => {
    const stale: Mutation = { op: "MODIFY", axis: "rule", key: "status", before: { kind: "allowed", values: ["x"] }, after: { kind: "allowed", values: ["a"] } };
    await expect(evaluateCandidate({ vault, parent: PARENT, mutations: [stale] })).rejects.toThrow();
  });
});

describe("routeOf", () => {
  const stage1 = (newRefusals: number, warningDelta: number) => ({ newRefusals, warningDelta, passed: newRefusals === 0 }) as MechanicalResult;
  it.each([
    [stage1(1, -3), "tightening", "reject"],
    [stage1(1, 0), "loosening", "reject"],
    [stage1(0, 1), "neutral", "awaiting-human"],
    [stage1(0, -1), "loosening", "awaiting-human"],
    [stage1(0, 0), "neutral", "consensus"],
    [stage1(0, -2), "tightening", "consensus"],
  ] as const)("routes %o %s to %s", (result, direction, route) => {
    expect(routeOf(result, direction)).toBe(route);
  });
});

describe("anchorContract", () => {
  it("is undefined for an empty lineage", async () => {
    expect(await anchorContract(root, ID)).toBeUndefined();
  });

  it("reads the first sealed generation from its snapshot, and gives up when it is gone", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT }, root);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: { ...PARENT, properties: { status: status(["a"]) } } }, root);
    expect(await anchorContract(root, ID)).toEqual(PARENT);
    await rm((await existingStateDir(root, ID, "generations"))!, { recursive: true });
    expect(await anchorContract(root, ID)).toBeUndefined();
  });
});
