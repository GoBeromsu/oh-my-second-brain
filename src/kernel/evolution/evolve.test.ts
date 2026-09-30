import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordGaps, type GapInput } from "../contract/gap-ledger.js";
import { judge } from "../contract/judge.js";
import { readLineage } from "../contract/lineage.js";
import { readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { readEvolutionEvents } from "./events.js";
import { evolve } from "./evolve.js";
import { listRequests, readPinnedCandidate } from "./request-state.js";
import type { NoteJudge } from "./stage-mechanical.js";
import type { Similarity } from "./stage-semantic.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
const REV = `sha256:${"0".repeat(64)}` as GapInput["noteRevision"];
const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const NARROW: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a"]) } };

let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evolve-")));
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

let counter = 0;
const deps = (extra: { judge?: NoteJudge; similarity?: Similarity } = {}) => ({
  now: () => NOW,
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
  ...extra,
});
const seal = async (contract: VaultContract) => (await sealContract({ vaultRealPath: vault, vaultId: ID, contract }, root)).digest;
const gap = (field: string, value: string, axis: GapInput["axis"] = "value"): GapInput => ({
  notePath: "Projects/a.md", noteRevision: REV, contractRevision: REV, axis, kind: "kept", chosen: null, wanted: { field, value }, reason: "kept: not-allowed",
});
const run = (extra: { judge?: NoteJudge; similarity?: Similarity; makerSessionId?: string } = {}) => evolve(
  { root, vaultId: ID, vaultRealPath: vault, makerSessionId: extra.makerSessionId ?? "maker-1" },
  deps({ ...(extra.judge === undefined ? {} : { judge: extra.judge }), ...(extra.similarity === undefined ? {} : { similarity: extra.similarity }) }),
);

async function unchanged(action: () => Promise<unknown>, code: RegExp): Promise<void> {
  const store = await readStore(ID, root);
  const lineage = (await readLineage(root, ID, "display")).events;
  await expect(action()).rejects.toThrow(code);
  expect(await readStore(ID, root)).toEqual(store);
  expect((await readLineage(root, ID, "display")).events).toEqual(lineage);
  expect((await listRequests(root, ID)).records).toEqual([]);
}

describe("evolve", () => {
  it("drafts a loosening candidate from a value gap and leaves it for the owner", async () => {
    const parent = await seal(NARROW);
    const [recorded] = await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    const before = await readStore(ID, root);
    const result = await run({ makerSessionId: "maker-1" });
    expect(result.route).toBe("awaiting-human");
    expect(result.direction).toBe("loosening");
    expect(result.stage1.newRefusals).toBe(0);
    expect(result.request.state).toBe("awaiting-human");
    expect(result.request.kind).toBe("evolve");
    expect(result.request.makerSessionId).toBe("maker-1");
    expect(result.request.expectedParentDigest).toBe(parent);
    expect(result.evaluation.gaps).toEqual([recorded!.id]);
    expect(result.evaluation.candidateDigest).toBe(result.request.candidateDigest);
    const pinned = await readPinnedCandidate(root, ID, result.request);
    expect(pinned.contract.properties?.status?.rules[0]).toEqual({ kind: "allowed", values: ["a", "b"] });
    expect(await readStore(ID, root)).toEqual(before);
    const kinds = (await readEvolutionEvents(root, ID)).events.map(event => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["request.issued", "request.awaiting-human"]));
  });

  it("issues nothing without a maker session", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    const bare = { root, vaultId: ID, vaultRealPath: vault } as Parameters<typeof evolve>[0];
    await unchanged(() => evolve(bare, deps()), /^EVOLUTION_MAKER_SESSION_REQUIRED:/);
    await unchanged(() => run({ makerSessionId: "  " }), /^EVOLUTION_MAKER_SESSION_REQUIRED:/);
  });

  it("issues nothing when stage 2 finds drift past the threshold", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    await unchanged(() => run({ similarity: () => 0.69 }), /^EVOLUTION_STAGE2_REFUSED: the candidate drifts 0\.31/);
    expect((await run({ similarity: () => 0.7 })).stage2).toMatchObject({ passed: true });
  });

  it("issues nothing when the maker drafts no change", async () => {
    await seal(NARROW);
    await unchanged(() => run(), /EVOLUTION_NO_MUTATIONS/);
    await recordGaps(root, ID, [gap("status", "a")], { now: () => NOW, newId: () => "gap-1" });
    await unchanged(() => run(), /EVOLUTION_NO_MUTATIONS/);
  });

  it("issues nothing when stage 1 finds a new refusal", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    const refusing: NoteJudge = (noteInput, view) => view.state === "sealed"
      && (view.contract.properties?.status?.rules[0] as { values?: string[] } | undefined)?.values?.length === 2
      ? { ...judge(noteInput, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(noteInput, view);
    await unchanged(() => run({ judge: refusing }), /EVOLUTION_STAGE1_REFUSED/);
  });

  it("refuses a vault without a sealed contract", async () => {
    await expect(run()).rejects.toThrow(/EVOLUTION_NO_CONTRACT/);
    expect((await listRequests(root, ID)).records).toEqual([]);
  });
});
