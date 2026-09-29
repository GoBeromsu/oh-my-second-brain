import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import { readLineage } from "../contract/lineage.js";
import { existingStateDir } from "../contract/state-dir.js";
import { readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import type { HumanRejectReason, HumanSessionOutcome } from "./decision.js";
import { readEvolutionEvents } from "./events.js";
import { EVOLUTION_LOCK_FILE } from "./evolution-lock.js";
import { writePolicy } from "./policy.js";
import {
  CANDIDATE_DIR, createRequest, lineageTail, PENDING_DIR, readRequest, REQUEST_TTL_MS, writeRequest, type RequestRecord, type VerdictRecord,
} from "./request-state.js";
import { proposeRevert } from "./revert.js";
import { approveInTerminal, type HumanPrompt } from "./seal-gate-human.js";
import { sealGate } from "./seal-gate.js";
import { evaluationRequest, runConsensus, type VerdictProvider } from "./stage-consensus.js";
import type { NoteJudge } from "./stage-mechanical.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const TIGHTER: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
const WIDER: VaultContract = { ...PARENT, properties: { status: status(["a", "b", "c"]) } };
const RENAMED: VaultContract = { ...TIGHTER, folders: { Projects: { meaning: "active projects", searchExclude: false } } };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-human-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await writeFile(join(vault, "Projects", "ok.md"), "---\nstatus: a\n---\n");
  await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT }, root);
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
const ids = {
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
};

async function issue(contract: VaultContract, state: "open" | "awaiting-human" = "awaiting-human", at = NOW): Promise<RequestRecord> {
  const { tail } = await lineageTail(root, ID);
  return createRequest(root, ID, { kind: "evolve", contract, mutations: [], parent: tail, makerSessionId: "maker-1", state }, { now: () => at, ...ids });
}

function verdict(slot: number, value: "approve" | "reject"): VerdictRecord {
  return { slot, evaluatorSessionId: `eval-${slot}`, verdict: value, rubricScores: {}, reasons: [], at: NOW } as unknown as VerdictRecord;
}

async function withQuorum(request: RequestRecord): Promise<RequestRecord> {
  const next = { ...request, verdicts: [verdict(0, "approve"), verdict(1, "approve"), verdict(2, "reject")], usedSlots: request.slots.slice(0, 3) };
  await writeRequest(root, ID, next);
  return next;
}

const autonomousOn = () => writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });

const approve = async (): Promise<HumanSessionOutcome> => ({ decision: "approve" });
const rejectFor = (reason: HumanRejectReason) => async (): Promise<HumanSessionOutcome> => ({ decision: "reject", reason });

const human = (request: RequestRecord, ask: (prompt: HumanPrompt) => Promise<HumanSessionOutcome>, extra: { now?: number; judge?: NoteJudge } = {}) =>
  approveInTerminal(
    { root, vaultId: ID, vaultRealPath: vault, requestId: request.requestId },
    { now: () => extra.now ?? NOW, ask, ...(extra.judge ? { judge: extra.judge } : {}) },
  );

const kinds = async (): Promise<string[]> => (await readEvolutionEvents(root, ID)).events.map(event => event.kind);
const stateOf = async (request: RequestRecord): Promise<string | undefined> => (await readRequest(root, ID, request.requestId))?.state;
const storeDigest = async (): Promise<string | null> => {
  const store = await readStore(ID, root);
  return store.state === "ok" ? store.digest : null;
};
const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe("approveInTerminal", () => {
  it("seals a loosening revert with the policy off, as the owner and not autonomously", async () => {
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: TIGHTER }, root);
    const target = (await readLineage(root, ID, "strict")).events[0]!.digest;
    const proposal = await proposeRevert({ root, vaultId: ID, vaultRealPath: vault, targetDigest: target }, { now: () => NOW, ...ids });
    expect(proposal).toMatchObject({ direction: "loosening", state: "awaiting-human" });
    const request = (await readRequest(root, ID, proposal.requestId))!;
    const prompts: HumanPrompt[] = [];
    const result = await human(request, async prompt => { prompts.push(prompt); return { decision: "approve" }; });
    expect(prompts).toEqual([expect.objectContaining({ requestId: request.requestId, kind: "revert", direction: "loosening", candidateDigest: target, revertOf: target })]);
    expect(result).toMatchObject({ decision: "approve", gate: { outcome: "sealed", direction: "loosening" } });
    expect(await storeDigest()).toBe(target);
    expect((await readLineage(root, ID, "strict")).events.at(-1)).toMatchObject({ kind: "sealed", revertOf: target, mode: "human", autonomous: false, evaluator: "human-cli" });
    expect(await kinds()).toContain("seal.human-approved");
  });

  it("is exempt from the TTL: an approve sixteen minutes after issue still seals", async () => {
    const later = NOW + 16 * 60_000;
    expect(later - NOW).toBeGreaterThan(REQUEST_TTL_MS);
    const awaiting = await issue(WIDER);
    expect(await human(awaiting, approve, { now: later })).toMatchObject({ decision: "approve", gate: { outcome: "sealed" } });
    await autonomousOn();
    const open = await withQuorum(await issue(TIGHTER, "open"));
    await expect(sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: open.requestId, mode: "autonomous" }, { now: () => later })).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await stateOf(open)).toBe("expired");
  });

  it("is exempt from the rate limit and consumes no autonomous budget", async () => {
    await autonomousOn();
    const autonomous = await withQuorum(await issue(TIGHTER, "open"));
    const gate = (request: RequestRecord) => sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: request.requestId, mode: "autonomous" }, { now: () => NOW });
    expect((await gate(autonomous)).outcome).toBe("sealed");
    const owner = await issue(WIDER);
    expect(await human(owner, approve)).toMatchObject({ decision: "approve", gate: { outcome: "sealed" } });
    const budget = (await kinds()).filter(kind => kind === "seal.autonomous").length;
    expect(budget).toBe(1);
    const next = await withQuorum(await issue(RENAMED, "open"));
    await expect(gate(next)).rejects.toThrow(/^EVOLUTION_RATE_LIMITED:/);
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.rate-limited", detail: { day: 1 } });
    expect((await kinds()).filter(kind => kind === "seal.autonomous")).toHaveLength(budget);
  });

  it("keeps stage 1 a hard gate: a new refusal rejects the request and leaves the store", async () => {
    const request = await issue(WIDER);
    const before = await storeDigest();
    const refusing: NoteJudge = (input, view) => view.state === "sealed" && (view.contract.properties.status?.rules[0] as { values: string[] } | undefined)?.values.length === 3
      ? { ...judge(input, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(input, view);
    expect(await human(request, approve, { judge: refusing })).toMatchObject({ decision: "approve", gate: { outcome: "rejected", reason: "stage1-refusal" } });
    expect(await readRequest(root, ID, request.requestId)).toMatchObject({ state: "rejected", rejectReason: "stage1-refusal" });
    expect(await storeDigest()).toBe(before);
  });

  it("refuses tampered pinned bytes before asking", async () => {
    const request = await issue(WIDER);
    const candidate = join((await existingStateDir(root, ID, "evolution"))!, PENDING_DIR, request.requestId, CANDIDATE_DIR);
    const file = (await readdir(candidate, { recursive: true, withFileTypes: true })).find(entry => entry.isFile())!;
    await appendFile(join(file.parentPath, file.name), " ");
    let asked = false;
    await expect(human(request, async () => { asked = true; return { decision: "approve" }; })).rejects.toThrow(/^EVOLUTION_CANDIDATE_MISMATCH:/);
    expect(asked).toBe(false);
    expect(await stateOf(request)).toBe("awaiting-human");
  });

  it("refuses with EVOLUTION_PARENT_MOVED when a seal lands while the owner answers", async () => {
    const request = await issue(WIDER);
    let moved: string | null = null;
    const ask = async (): Promise<HumanSessionOutcome> => {
      moved = (await sealContract({ vaultRealPath: vault, vaultId: ID, contract: RENAMED }, root)).digest;
      return { decision: "approve" };
    };
    await expect(human(request, ask)).rejects.toThrow(/^EVOLUTION_PARENT_MOVED:/);
    expect(await storeDigest()).toBe(moved);
    expect(await kinds()).toContain("seal.parent-moved");
    expect((await readLineage(root, ID, "strict")).events.some(event => event.digest === request.candidateDigest)).toBe(false);
  });

  it("still seals through the owner on a host without evaluator subagents", async () => {
    const request = await issue(WIDER, "open");
    const hermes: VerdictProvider = { host: "hermes", subagents: false, collect: async () => { throw new Error("never asked"); } };
    await expect(runConsensus(hermes, { root, vaultId: ID, vaultRealPath: vault }, evaluationRequest(request), { now: () => NOW })).rejects.toThrow(/^EVALUATOR_CONSENSUS_UNAVAILABLE:/);
    expect(await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: request.requestId, mode: "autonomous" }, { now: () => NOW })).toMatchObject({ outcome: "awaiting-human", reason: "loosening" });
    expect(await human(request, approve)).toMatchObject({ decision: "approve", gate: { outcome: "sealed", direction: "loosening" } });
    expect(await storeDigest()).toBe(request.candidateDigest);
  });

  it("ends only the session on a timeout, so a later approve seals", async () => {
    const request = await issue(WIDER);
    expect(await human(request, rejectFor("timeout"))).toEqual({ decision: "reject", reason: "timeout", state: "awaiting-human" });
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.human-rejected", requestId: request.requestId, detail: { reason: "timeout", state: "awaiting-human" } });
    expect(await stateOf(request)).toBe("awaiting-human");
    expect(await human(request, approve)).toMatchObject({ decision: "approve", gate: { outcome: "sealed" } });
  });

  it("rejects for good on an explicit reject", async () => {
    const request = await issue(WIDER);
    const before = await storeDigest();
    expect(await human(request, rejectFor("explicit"))).toEqual({ decision: "reject", reason: "explicit", state: "rejected" });
    expect(await readRequest(root, ID, request.requestId)).toMatchObject({ state: "rejected", rejectReason: "explicit" });
    await expect(human(request, approve)).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await storeDigest()).toBe(before);
  });

  it.each(["eof", "non-tty", "unknown-input", "interrupted"] as const)("journals %s and keeps the request awaiting the owner", async reason => {
    const request = await issue(WIDER);
    expect(await human(request, rejectFor(reason))).toEqual({ decision: "reject", reason, state: "awaiting-human" });
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.human-rejected", detail: { reason, state: "awaiting-human" } });
    expect(await stateOf(request)).toBe("awaiting-human");
  });

  it("records the derived state when a reject arrives after the request was superseded", async () => {
    const request = await issue(WIDER);
    const ask = async (): Promise<HumanSessionOutcome> => {
      await sealContract({ vaultRealPath: vault, vaultId: ID, contract: RENAMED }, root);
      return { decision: "reject", reason: "explicit" };
    };
    expect(await human(request, ask)).toEqual({ decision: "reject", reason: "explicit", state: "superseded" });
    expect(await stateOf(request)).toBe("superseded");
  });

  it("refuses a request superseded by a seal made elsewhere, without asking", async () => {
    const request = await issue(WIDER);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: RENAMED }, root);
    let asked = false;
    await expect(human(request, async () => { asked = true; return { decision: "approve" }; })).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(asked).toBe(false);
  });

  it("refuses an open request without asking", async () => {
    const request = await issue(TIGHTER, "open");
    await expect(human(request, approve)).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await kinds()).toEqual(["request.issued"]);
  });

  it("holds neither the evolution lock nor the seal lock while the owner answers", async () => {
    const request = await issue(WIDER);
    const evolutionLock = join((await existingStateDir(root, ID, "evolution"))!, EVOLUTION_LOCK_FILE);
    const sealLock = join(root, `.${ID}.lock`);
    const held: boolean[] = [];
    await human(request, async () => {
      held.push(await exists(evolutionLock), await exists(sealLock));
      return { decision: "approve" };
    });
    expect(held).toEqual([false, false]);
  });

  it("refuses an unknown request and a vault without a readable store", async () => {
    const unknown = { requestId: "00000000-0000-4000-8000-999999999999" } as RequestRecord;
    await expect(human(unknown, approve)).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
    const request = await issue(WIDER);
    await rm(join(root, ID), { recursive: true, force: true });
    await expect(human(request, approve)).rejects.toThrow(/^EVOLUTION_PARENT_MOVED:/);
  });

  it("refuses to record a reject for a request that disappeared during the session", async () => {
    const request = await issue(WIDER);
    const ask = async (): Promise<HumanSessionOutcome> => {
      await rm(join((await existingStateDir(root, ID, "evolution"))!, PENDING_DIR, request.requestId), { recursive: true });
      return { decision: "reject", reason: "explicit" };
    };
    await expect(human(request, ask)).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
  });
});
