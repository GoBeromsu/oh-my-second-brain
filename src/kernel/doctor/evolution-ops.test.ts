import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordGaps, type GapInput } from "../contract/gap-ledger.js";
import { readLineage } from "../contract/lineage.js";
import { readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { writePolicy } from "../evolution/policy.js";
import { listRequests, readRequest } from "../evolution/request-state.js";
import { serializeVaultSettings } from "../vault/settings.js";
import { evolutionCounters } from "../evolution/events.js";
import { isEvolutionOperation, runEvolutionOp, type DoctorHuman, type EvolutionOperation, type EvolutionOpsDeps } from "./evolution-ops.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
const REV = `sha256:${"0".repeat(64)}` as GapInput["noteRevision"];
const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const WIDE: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const NARROW: VaultContract = { ...WIDE, properties: { status: status(["a"]) } };

let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evolution-ops-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, ".oms"), { recursive: true });
  await writeFile(join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Projects", "a.md"), "---\nstatus: a\n---\n");
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
const deps = (extra: Partial<EvolutionOpsDeps> = {}): EvolutionOpsDeps => ({
  now: () => NOW,
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
  ...extra,
});
const seal = async (contract: VaultContract) => (await sealContract({ vaultRealPath: vault, vaultId: ID, contract }, root)).digest;
const gap = (field: string, value: string): GapInput => ({
  notePath: "Projects/a.md", noteRevision: REV, contractRevision: REV, axis: "value", kind: "kept", chosen: null, wanted: { field, value }, reason: "kept: not-allowed",
});
const run = (operation: EvolutionOperation, args?: Record<string, unknown>, human?: DoctorHuman, extra: Partial<EvolutionOpsDeps> = {}) =>
  runEvolutionOp({ operation, vault, root, args, ...(human === undefined ? {} : { human }), deps: deps(extra) });
const owner = (decision: "approve" | "reject" = "approve"): DoctorHuman & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return { interactive: true, seen, confirm: async subject => { seen.push(subject); return decision; } };
};
const lockFile = (): string => join(root, `.${ID}.state`, "evolution", "lock");
async function placeLock(): Promise<void> {
  await mkdir(join(root, `.${ID}.state`, "evolution"), { recursive: true, mode: 0o700 });
  await writeFile(lockFile(), JSON.stringify({ pid: 7, host: "here", startedAt: NOW - 5 }), { mode: 0o600 });
}
const deadOwner = { lockDeps: { host: "here", pid: 4242, isPidAlive: () => false } };

describe("isEvolutionOperation", () => {
  it("names exactly the four evolution ops", () => {
    for (const op of ["evolve", "evolve-verdict", "revert-propose", "reclaim-evolution-lock"]) expect(isEvolutionOperation(op)).toBe(true);
    for (const op of ["lineage-reanchor", "cleanup", "status"]) expect(isEvolutionOperation(op)).toBe(false);
  });
});

describe("runEvolutionOp evolve", () => {
  it("issues a request and answers with a receipt that matches the stored request", async () => {
    const parent = await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    const result = await run("evolve", { makerSessionId: "maker-1" });
    expect(result).toMatchObject({ kind: "completed", value: { op: "evolve", vaultId: ID, state: "awaiting-human", direction: "loosening", parentDigest: parent, parentEventSeq: 1 } });
    const value = (result as { value: Record<string, unknown> }).value;
    const stored = await readRequest(root, ID, value.requestId as string);
    expect(stored).toMatchObject({ nonce: value.nonce, candidateDigest: value.candidateDigest, makerSessionId: "maker-1", state: "awaiting-human" });
    expect(await readStore(ID, root)).toMatchObject({ digest: parent });
  });

  it("refuses an evolve that names no maker session and issues nothing", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    for (const args of [undefined, {}, { makerSessionId: "  " }]) {
      expect(await run("evolve", args)).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_MAKER_SESSION_REQUIRED:/) });
    }
    expect((await listRequests(root, ID)).records).toEqual([]);
  });

  it("refuses a malformed maker session and issues nothing", async () => {
    await seal(NARROW);
    expect(await run("evolve", { makerSessionId: 7 })).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_ARGUMENT_INVALID: makerSessionId/) });
    expect((await listRequests(root, ID)).records).toEqual([]);
  });

  it("maps an evolution refusal to an error result", async () => {
    await seal(NARROW);
    expect(await run("evolve", { makerSessionId: "maker-1" })).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_NO_MUTATIONS:/) });
  });

  it("refuses a vault with no sealed contract", async () => {
    for (const operation of ["evolve", "evolve-verdict", "revert-propose", "reclaim-evolution-lock"] as const) {
      expect(await run(operation, undefined, owner())).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_NO_CONTRACT:/) });
    }
  });

  it("names an unsafe store by its kind", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    await chmod(join(root, `.${ID}.state`), 0o777);
    try {
      expect(await run("evolve", { makerSessionId: "maker-1" })).toEqual({ kind: "error", message: "STATE_DIR_UNSAFE: the contract store holds an unsafe entry (shared-writable); it was left untouched" });
    } finally {
      await chmod(join(root, `.${ID}.state`), 0o700);
    }
  });

  it("rethrows a failure that is not an evolution refusal", async () => {
    await seal(NARROW);
    await recordGaps(root, ID, [gap("status", "b")], { now: () => NOW, newId: () => "gap-1" });
    await expect(run("evolve", { makerSessionId: "maker-1" }, undefined, { judge: () => { throw new Error("judge broke"); } })).rejects.toThrow("judge broke");
  });
});

describe("runEvolutionOp revert-propose and evolve-verdict", () => {
  it("needs a target digest", async () => {
    await seal(NARROW);
    expect(await run("revert-propose")).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_ARGUMENT_INVALID: revert-propose needs targetDigest/) });
    expect(await run("revert-propose", { targetDigest: "" })).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_ARGUMENT_INVALID: targetDigest/) });
  });

  it("proposes a loosening revert for the owner", async () => {
    const wide = await seal(WIDE);
    const narrow = await seal(NARROW);
    const result = await run("revert-propose", { targetDigest: wide });
    expect(result).toMatchObject({ kind: "completed", value: { op: "revert-propose", targetDigest: wide, candidateDigest: wide, parentDigest: narrow, direction: "loosening", state: "awaiting-human" } });
    expect(await readStore(ID, root)).toMatchObject({ digest: narrow });
  });

  it("seals a tightening revert once the quorum approves through evolve-verdict", async () => {
    const narrow = await seal(NARROW);
    await seal(WIDE);
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    const proposed = await run("revert-propose", { targetDigest: narrow });
    expect(proposed).toMatchObject({ kind: "completed", value: { direction: "tightening", state: "open", parentEventSeq: 2 } });
    const request = (await readRequest(root, ID, (proposed as { value: { requestId: string } }).value.requestId))!;
    const verdict = (slot: number) => ({
      requestId: request.requestId, nonce: request.nonce, slotToken: request.slots[slot], candidateDigest: request.candidateDigest,
      parentDigest: request.expectedParentDigest, evaluatorSessionId: `eval-${slot}`, verdict: "approve", rubricScores: { "intent-preserved": 1 }, reasons: ["ok"],
    });
    const receipts = [];
    for (const slot of [0, 1, 2]) receipts.push(await run("evolve-verdict", verdict(slot)));
    expect(receipts[0]).toMatchObject({ kind: "completed", value: { op: "evolve-verdict", slot: 0, accepted: true } });
    expect((receipts[0] as { value: object }).value).not.toHaveProperty("sealed");
    const sealed = receipts.find(receipt => receipt.kind === "completed" && "sealed" in receipt.value);
    expect(sealed).toMatchObject({ value: { sealed: { digest: narrow }, gate: expect.anything() } });
    expect(await readStore(ID, root)).toMatchObject({ digest: narrow });
    expect((await readLineage(root, ID, "display")).events.at(-1)).toMatchObject({ digest: narrow, revertOf: narrow });
  });

  it("needs a request id and a slot token", async () => {
    await seal(NARROW);
    expect(await run("evolve-verdict", { requestId: "x" })).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_ARGUMENT_INVALID: a verdict needs/) });
    expect(await run("evolve-verdict", { slotToken: "x" })).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_ARGUMENT_INVALID: a verdict needs/) });
  });
});

describe("runEvolutionOp reclaim-evolution-lock", () => {
  it("is refused without the owner at a terminal and leaves the lock", async () => {
    await seal(NARROW);
    await placeLock();
    expect(await run("reclaim-evolution-lock", undefined, undefined, deadOwner)).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_RECLAIM_REQUIRES_TTY:/) });
    expect(await run("reclaim-evolution-lock", undefined, { interactive: false, confirm: async () => "approve" }, deadOwner)).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_RECLAIM_REQUIRES_TTY:/) });
    expect(await stat(lockFile())).toBeTruthy();
  });

  it("reports nothing removed when there is no lock", async () => {
    await seal(NARROW);
    const human = owner();
    expect(await run("reclaim-evolution-lock", undefined, human)).toEqual({ kind: "completed", value: { op: "reclaim-evolution-lock", vaultId: ID, removedOwner: null, removed: false, decision: "approve" } });
    expect(human.seen).toEqual([]);
  });

  it("removes an approved stale lock and journals it once", async () => {
    await seal(NARROW);
    await placeLock();
    const human = owner();
    const result = await run("reclaim-evolution-lock", undefined, human, deadOwner);
    const shown = { pid: 7, host: "here", startedAt: NOW - 5 };
    expect(result).toEqual({ kind: "completed", value: { op: "reclaim-evolution-lock", vaultId: ID, removedOwner: shown, removed: true, decision: "approve" } });
    expect(human.seen).toEqual([{ op: "reclaim-evolution-lock", owner: shown }]);
    await expect(stat(lockFile())).rejects.toMatchObject({ code: "ENOENT" });
    expect((await evolutionCounters(root, ID))["lock.reclaimed"]).toBe(1);
  });

  it("leaves the lock when the owner declines", async () => {
    await seal(NARROW);
    await placeLock();
    expect(await run("reclaim-evolution-lock", undefined, owner("reject"), deadOwner)).toEqual({ kind: "error", message: expect.stringMatching(/^EVOLUTION_RECLAIM_DECLINED:/) });
    expect(await stat(lockFile())).toBeTruthy();
  });
});
