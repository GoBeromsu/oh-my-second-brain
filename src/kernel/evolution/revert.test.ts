import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestHex } from "../contract/digest.js";
import { writeSnapshot } from "../contract/generation-snapshot.js";
import { judge } from "../contract/judge.js";
import { readLineage } from "../contract/lineage.js";
import { existingStateDir, stateDir } from "../contract/state-dir.js";
import { candidateManifest, readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { readEvolutionEvents } from "./events.js";
import { writePolicy } from "./policy.js";
import { listRequests, readRequest, type RequestRecord } from "./request-state.js";
import { proposeRevert } from "./revert.js";
import { sealGate } from "./seal-gate.js";
import { recordVerdict, type VerdictSubmission } from "./stage-consensus.js";
import type { NoteJudge } from "./stage-mechanical.js";
import type { Similarity } from "./stage-semantic.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const WIDE: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const NARROW: VaultContract = { ...WIDE, properties: { status: status(["a"]) } };

let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-revert-")));
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
const propose = (targetDigest: string, extra: { judge?: NoteJudge; similarity?: Similarity } = {}) => proposeRevert({ root, vaultId: ID, vaultRealPath: vault, targetDigest }, deps(extra));

function submission(request: RequestRecord, slot: number): VerdictSubmission {
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    slotToken: request.slots[slot] as string,
    candidateDigest: request.candidateDigest,
    parentDigest: request.expectedParentDigest,
    evaluatorSessionId: `eval-${slot}`,
    verdict: "approve",
    rubricScores: { "intent-preserved": 1 },
    reasons: ["ok"],
  };
}

async function unchanged<T>(action: () => Promise<T>): Promise<void> {
  const store = await readStore(ID, root);
  const lineage = (await readLineage(root, ID, "display")).events;
  const pending = (await listRequests(root, ID)).records;
  await expect(action()).rejects.toThrow();
  expect(await readStore(ID, root)).toEqual(store);
  expect((await readLineage(root, ID, "display")).events).toEqual(lineage);
  expect((await listRequests(root, ID)).records).toEqual(pending);
}

async function snapshotFile(digest: string): Promise<string> {
  const directory = join((await existingStateDir(root, ID, "generations"))!, digestHex(digest as never));
  const file = (await readdir(directory, { recursive: true, withFileTypes: true })).find(entry => entry.isFile() && entry.name !== "manifest.json")!;
  return join(file.parentPath, file.name);
}

describe("proposeRevert", () => {
  it("routes a loosening revert to the owner, and the autonomous gate never seals it", async () => {
    const wide = await seal(WIDE);
    const narrow = await seal(NARROW);
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    const proposal = await propose(wide);
    expect(proposal).toMatchObject({ targetDigest: wide, candidateDigest: wide, parentDigest: narrow, direction: "loosening", state: "awaiting-human" });
    expect(await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: proposal.requestId, mode: "autonomous" }, { now: () => NOW })).toEqual({ outcome: "awaiting-human", reason: "already" });
    expect((await readStore(ID, root))).toMatchObject({ digest: narrow });
    const kinds = (await readEvolutionEvents(root, ID)).events.map(event => event.kind);
    expect(kinds).toEqual(["request.issued", "request.awaiting-human", "revert.proposed"]);
  });

  it("routes a tightening revert to the owner, never to a quorum, and seals it on the owner's approve", async () => {
    const narrow = await seal(NARROW);
    await seal(WIDE);
    await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    const proposal = await propose(narrow);
    expect(proposal).toMatchObject({ direction: "tightening", state: "awaiting-human", candidateDigest: narrow, parentEventSeq: 2 });
    const request = (await readRequest(root, ID, proposal.requestId))!;
    expect(request).toMatchObject({ kind: "revert", revertOf: narrow, mutations: [], state: "awaiting-human" });
    const input = { root, vaultId: ID, vaultRealPath: vault };
    await expect(recordVerdict(input, submission(request, 0), { now: () => NOW })).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED: request .+ is awaiting-human/);
    expect(await readStore(ID, root)).not.toMatchObject({ digest: narrow });
    expect(await sealGate({ ...input, requestId: proposal.requestId, mode: "human" }, { now: () => NOW })).toMatchObject({ outcome: "sealed", direction: "tightening" });
    expect(await readStore(ID, root)).toMatchObject({ digest: narrow });
    expect((await readLineage(root, ID, "display")).events.at(-1)).toMatchObject({
      kind: "sealed", generation: 3, digest: narrow, revertOf: narrow, requestId: proposal.requestId, mode: "human", autonomous: false, proposer: "owner",
    });
  });

  for (const autonomous of [false, true]) {
    it(`waits for the owner on a tightening and a neutral revert alike with the policy ${autonomous ? "on" : "off"}`, async () => {
      const declined = (await sealContract({ vaultRealPath: vault, vaultId: ID, contract: NARROW, declined: { folders: ["Archive"], properties: [] } }, root)).digest;
      const wide = await seal(WIDE);
      await writePolicy(root, ID, { version: 1, autonomous, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
      const tightening = await propose(declined);
      expect(tightening).toMatchObject({ direction: "tightening", state: "awaiting-human" });
      expect(await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: tightening.requestId, mode: "autonomous" }, { now: () => NOW })).toEqual({ outcome: "awaiting-human", reason: "already" });
      const pending = (await listRequests(root, ID)).records.filter(record => record.state === "awaiting-human").map(record => record.requestId);
      expect(pending).toEqual([tightening.requestId]);
      expect(await readStore(ID, root)).toMatchObject({ digest: wide });
      const plain = await seal(NARROW);
      const neutral = await propose(declined);
      expect(neutral).toMatchObject({ direction: "neutral", state: "awaiting-human", parentDigest: plain });
      expect(await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: neutral.requestId, mode: "autonomous" }, { now: () => NOW })).toEqual({ outcome: "awaiting-human", reason: "already" });
      expect(await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: neutral.requestId, mode: "human" }, { now: () => NOW })).toMatchObject({ outcome: "sealed", direction: "neutral" });
      expect(await readStore(ID, root)).toMatchObject({ digest: declined });
      expect((await readLineage(root, ID, "display")).events.at(-1)).toMatchObject({ revertOf: declined, mode: "human", autonomous: false, proposer: "owner" });
    });
  }

  it("refuses a revert whose generation drifts too far from the first sealed one, proposing nothing", async () => {
    await seal(WIDE);
    const drifted = await seal({ ...WIDE, folders: { Projects: { meaning: "archived client invoices", searchExclude: false } } });
    await seal(NARROW);
    await unchanged(() => propose(drifted));
    await expect(propose(drifted)).rejects.toThrow(/^EVOLUTION_STAGE2_REFUSED: restoring .+ drifts 0\.50 from the first sealed generation/);
    expect((await readEvolutionEvents(root, ID)).events.map(event => event.kind)).not.toContain("revert.proposed");
  });

  it("refuses a revert that stage 2 finds overlapping in meaning, with the similarity it is given", async () => {
    const wide = await seal({ ...WIDE, folders: { ...WIDE.folders, Areas: { meaning: "areas", searchExclude: false } } });
    await seal({ ...NARROW, folders: { Projects: { meaning: "projects", searchExclude: false } } });
    const same = (left: string, right: string) => (left === right ? 1 : 0.95);
    await unchanged(() => propose(wide, { similarity: same }));
    await expect(propose(wide, { similarity: same })).rejects.toThrow(/^EVOLUTION_STAGE2_REFUSED: restoring .+ overlaps in meaning: folder Areas ~ Projects/);
  });

  it("restores a generation whose store directory is gone, from its snapshot", async () => {
    await seal(WIDE);
    const target = await seal(NARROW);
    for (const meaning of ["project work", "active projects", "projects in flight"]) {
      await seal({ ...NARROW, folders: { Projects: { meaning, searchExclude: false } } });
    }
    expect(await readdir(join(root, ID))).not.toContain("2");
    const proposal = await propose(target);
    expect(proposal).toMatchObject({ candidateDigest: target, targetDigest: target, parentEventSeq: 5, state: "awaiting-human" });
    expect(proposal.direction).not.toBe("loosening");
  });

  it("fails closed on a corrupt snapshot and leaves the store, lineage and pending as they were", async () => {
    const wide = await seal(WIDE);
    await seal(NARROW);
    await appendFile(await snapshotFile(wide), " ");
    await unchanged(() => propose(wide));
    await expect(propose(wide)).rejects.toThrow(/EVOLUTION_REVERT_SOURCE_UNAVAILABLE: snapshot-corrupt/);
    const journal = (await readEvolutionEvents(root, ID)).events;
    expect(journal.at(-1)).toMatchObject({ kind: "revert.source-unavailable", detail: { targetDigest: wide, reason: "snapshot-corrupt" } });
  });

  it("fails closed on a missing snapshot of a generation the store no longer retains", async () => {
    const wide = await seal(WIDE);
    await seal(NARROW);
    await seal({ ...NARROW, folders: { Projects: { meaning: "project work", searchExclude: false } } });
    await seal({ ...NARROW, folders: { Projects: { meaning: "active projects", searchExclude: false } } });
    await rm(join((await existingStateDir(root, ID, "generations"))!, digestHex(wide as never)), { recursive: true });
    await unchanged(() => propose(wide));
    await expect(propose(wide)).rejects.toThrow(/EVOLUTION_REVERT_SOURCE_UNAVAILABLE: snapshot-missing/);
  });

  it("refuses an orphan snapshot or a non-digest that no lineage event names", async () => {
    await seal(WIDE);
    await seal(NARROW);
    const orphan = candidateManifest({ ...WIDE, folders: { ...WIDE.folders, Orphan: { meaning: "orphan", searchExclude: false } } });
    await writeSnapshot(root, ID, orphan.files, orphan.manifestText);
    await unchanged(() => propose(orphan.digest));
    await expect(propose(orphan.digest)).rejects.toThrow(/EVOLUTION_REVERT_TARGET_UNSEALED/);
    await expect(propose("none")).rejects.toThrow(/EVOLUTION_REVERT_TARGET_UNSEALED/);
  });

  it("reverts to a generation the bootstrap re-snapshotted", async () => {
    const wide = await seal(WIDE);
    await seal(NARROW);
    await rm(stateDir(root, ID), { recursive: true });
    const proposal = await propose(wide);
    expect(proposal).toMatchObject({ targetDigest: wide, direction: "loosening", state: "awaiting-human" });
    expect((await readLineage(root, ID, "display")).events.map(event => event.reason)).toEqual(["bootstrap", "bootstrap"]);
  });

  it("refuses to revert to the contract already sealed", async () => {
    await seal(WIDE);
    const narrow = await seal(NARROW);
    await expect(propose(narrow)).rejects.toThrow(/EVOLUTION_REVERT_NOOP/);
  });

  it("refuses a revert that stage 1 finds adds a refusal, opening nothing", async () => {
    const wide = await seal(WIDE);
    await seal(NARROW);
    const refusing: NoteJudge = (noteInput, view) => view.state === "sealed" && view.contract.properties?.status?.rules[0]?.kind === "allowed"
      && (view.contract.properties.status.rules[0] as { values: string[] }).values.length === 2
      ? { ...judge(noteInput, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(noteInput, view);
    await unchanged(() => propose(wide, { judge: refusing }));
    await expect(propose(wide, { judge: refusing })).rejects.toThrow(/EVOLUTION_REVERT_REFUSED/);
  });

  it("fails without a readable sealed contract", async () => {
    const wide = await seal(WIDE);
    await seal(NARROW);
    await rm(join(root, ID), { recursive: true, force: true });
    await rm(join(root, `${ID}.current`), { force: true });
    await expect(propose(wide)).rejects.toThrow(/EVOLUTION_REVERT_NO_CONTRACT/);
  });
});
