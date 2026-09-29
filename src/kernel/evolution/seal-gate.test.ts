import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import { appendLineageEvents, readLineage } from "../contract/lineage.js";
import { readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { readEvolutionEvents } from "./events.js";
import { writePolicy } from "./policy.js";
import { DAY_MS } from "./rate-limit.js";
import {
  createRequest, lineageTail, readRequest, REQUEST_TTL_MS, writeRequest, type RequestRecord, type VerdictRecord,
} from "./request-state.js";
import { quorumDecision, requestDirection, sealGate, tally, type SealGateDeps } from "./seal-gate.js";
import type { NoteJudge } from "./stage-mechanical.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
const FOREIGN = `sha256:${"f".repeat(64)}`;
let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const TIGHTER: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
const WIDER: VaultContract = { ...PARENT, properties: { status: status(["a", "b", "c"]) } };
const RENAMED: VaultContract = { ...TIGHTER, folders: { Projects: { meaning: "active work", searchExclude: false } } };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-gate-")));
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
async function issue(contract: VaultContract, extra: { state?: "open" | "awaiting-human"; kind?: "evolve" | "revert"; at?: number } = {}): Promise<RequestRecord> {
  const { tail } = await lineageTail(root, ID);
  const at = extra.at ?? NOW;
  return createRequest(root, ID, {
    kind: extra.kind ?? "evolve",
    contract,
    mutations: [],
    parent: tail,
    makerSessionId: "maker-1",
    ...(extra.state ? { state: extra.state } : {}),
    ...(extra.kind === "revert" ? { revertOf: FOREIGN as never } : {}),
  }, {
    now: () => at,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    newToken: () => (++counter).toString(16).padStart(32, "0"),
  });
}

function verdict(slot: number, value: "approve" | "reject"): VerdictRecord {
  return { slot, evaluatorSessionId: `eval-${slot}`, verdict: value, rubricScores: {}, reasons: [], at: NOW } as unknown as VerdictRecord;
}

async function withVerdicts(request: RequestRecord, values: readonly ("approve" | "reject")[]): Promise<RequestRecord> {
  const next = { ...request, verdicts: values.map((value, index) => verdict(index, value)), usedSlots: request.slots.slice(0, values.length) };
  await writeRequest(root, ID, next);
  return next;
}

async function autonomousOn(): Promise<void> {
  await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
}

const run = (request: RequestRecord, mode: "autonomous" | "human" = "autonomous", deps: Partial<SealGateDeps> = {}) =>
  sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: request.requestId, mode }, { now: () => NOW, ...deps });

const kinds = async (): Promise<string[]> => (await readEvolutionEvents(root, ID)).events.map(event => event.kind);
const stateOf = async (request: RequestRecord): Promise<string | undefined> => (await readRequest(root, ID, request.requestId))?.state;

describe("tally and quorumDecision", () => {
  it("counts approvals, rejections and open slots", () => {
    expect(tally([])).toEqual({ approve: 0, reject: 0, pending: 3 });
    expect(quorumDecision(tally([verdict(0, "approve"), verdict(1, "reject")]))).toBe("pending");
    expect(quorumDecision(tally([verdict(0, "approve"), verdict(1, "approve")]))).toBe("pending");
    expect(quorumDecision(tally([verdict(0, "approve"), verdict(1, "approve"), verdict(2, "reject")]))).toBe("approve");
    expect(quorumDecision(tally([verdict(0, "reject"), verdict(1, "approve"), verdict(2, "reject")]))).toBe("reject");
  });
});

describe("requestDirection", () => {
  it("reads loosening from the contracts and a revert's direction from what changes", async () => {
    const evolve = await issue(TIGHTER);
    expect(requestDirection(evolve, PARENT, WIDER)).toBe("loosening");
    expect(requestDirection(evolve, PARENT, TIGHTER)).toBe("neutral");
    const revert = await issue(TIGHTER, { kind: "revert" });
    expect(requestDirection(revert, PARENT, TIGHTER)).toBe("tightening");
    expect(requestDirection(revert, PARENT, PARENT)).toBe("neutral");
  });
});

describe("sealGate autonomous", () => {
  it("seals a non-loosening candidate with a quorum, attributed as autonomous", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    const result = await run(request);
    expect(result).toMatchObject({ outcome: "sealed", seq: 2, direction: "neutral", stage1: { newRefusals: 0, warningDelta: 0 } });
    const store = await readStore(ID, root);
    expect(store.state === "ok" && store.digest).toBe(request.candidateDigest);
    const last = (await readLineage(root, ID, "strict")).events.at(-1);
    expect(last).toMatchObject({ kind: "sealed", digest: request.candidateDigest, requestId: request.requestId, autonomous: true, mode: "autonomous", proposer: "maker-1", evaluator: "eval-0,eval-1,eval-2" });
    expect(await readRequest(root, ID, request.requestId)).toMatchObject({ state: "sealed", sealAttempt: { mode: "autonomous", at: NOW, candidateDigest: request.candidateDigest } });
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.autonomous", requestId: request.requestId, detail: { eventSeq: last?.eventSeq } });
  });

  it("moves a loosening candidate to awaiting-human even when the policy is off", async () => {
    const request = await issue(WIDER);
    expect(await run(request)).toEqual({ outcome: "awaiting-human", reason: "loosening", direction: "loosening" });
    expect(await stateOf(request)).toBe("awaiting-human");
    expect(await kinds()).toEqual(["request.issued", "seal.blocked-loosening", "request.awaiting-human"]);
    expect(await run(request)).toEqual({ outcome: "awaiting-human", reason: "already" });
  });

  it("refuses when the autonomous policy is off and leaves the request open", async () => {
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    await expect(run(request)).rejects.toThrow(/^EVOLUTION_POLICY_OFF:/);
    expect(await stateOf(request)).toBe("open");
  });

  it("refuses after three autonomous generations in a row until an owner seals one", async () => {
    await autonomousOn();
    const autonomousSeal = async (): Promise<void> => {
      const { tail } = await lineageTail(root, ID);
      await appendLineageEvents(root, ID, [{ kind: "sealed", generation: null, parentDigest: tail.digest as never, digest: tail.digest as never, mutations: [], manifestDigests: {}, autonomous: true, mode: "autonomous" }], { expectTail: tail.digest as never });
    };
    for (let index = 0; index < 3; index += 1) await autonomousSeal();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    await expect(run(request)).rejects.toThrow(/^EVOLUTION_STALLED:/);
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.stalled", detail: { run: 3 } });
    expect(await stateOf(request)).toBe("open");
  });

  it("rejects a candidate that adds a refusal without closing the request", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    const refusing: NoteJudge = (input, view) => view.state === "sealed" && view.contract.properties.status?.rules[0]?.kind === "allowed" && (view.contract.properties.status.rules[0] as { values: string[] }).values.length === 1
      ? { ...judge(input, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(input, view);
    expect(await run(request, "autonomous", { judge: refusing })).toMatchObject({ outcome: "rejected", reason: "stage1-refusal", stage1: { newRefusals: 1 } });
    expect(await stateOf(request)).toBe("open");
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "request.rejected", detail: { reason: "stage1-refusal", mode: "autonomous" } });
  });

  it("moves a candidate that adds warnings to awaiting-human", async () => {
    await autonomousOn();
    await writeFile(join(vault, "Projects", "b.md"), "---\nstatus: b\n---\n");
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    expect(await run(request)).toMatchObject({ outcome: "awaiting-human", reason: "warning-delta", stage1: { warningDelta: 1 } });
    expect(await stateOf(request)).toBe("awaiting-human");
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "request.awaiting-human", detail: { reason: "warning-delta", warningDelta: 1 } });
  });

  it("waits for a quorum and reports a quorum rejection", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve"]);
    expect(await run(request)).toEqual({ outcome: "pending", quorum: { approve: 1, reject: 0, pending: 2 } });
    await withVerdicts(request, ["approve", "reject", "reject"]);
    expect(await run(request)).toMatchObject({ outcome: "rejected", reason: "quorum-rejected" });
    expect(await stateOf(request)).toBe("open");
  });

  it("refuses a second autonomous seal within a day", async () => {
    await autonomousOn();
    const first = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    await run(first);
    const second = await withVerdicts(await issue(RENAMED), ["approve", "approve", "reject"]);
    await expect(run(second)).rejects.toThrow(/^EVOLUTION_RATE_LIMITED:/);
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.rate-limited", detail: { day: 1 } });
    expect(await stateOf(second)).toBe("open");
  });

  it("refuses when the store moved since the request was issued", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: WIDER }, root);
    await expect(run(request)).rejects.toThrow(/^EVOLUTION_(PARENT_MOVED|REQUEST_CLOSED):/);
  });

  it("maps a parent moved during the seal to EVOLUTION_PARENT_MOVED", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    const beforeSeal = async (): Promise<void> => { await sealContract({ vaultRealPath: vault, vaultId: ID, contract: WIDER }, root); };
    await expect(run(request, "autonomous", { beforeSeal })).rejects.toThrow(/^EVOLUTION_PARENT_MOVED:/);
    expect(await kinds()).toContain("seal.parent-moved");
  });

  it("refuses a lineage gap instead of re-anchoring it, leaving the request open", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    const beforeSeal = async (): Promise<void> => {
      const { tail } = await lineageTail(root, ID);
      await appendLineageEvents(root, ID, [{ kind: "sealed", generation: null, parentDigest: tail.digest as never, digest: FOREIGN as never, mutations: [], manifestDigests: {} }], { expectTail: tail.digest as never });
    };
    await expect(run(request, "autonomous", { beforeSeal })).rejects.toThrow(/^EVOLUTION_LINEAGE_GAP:/);
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "lineage.gap-refused", detail: { tailDigest: FOREIGN } });
    const store = await readStore(ID, root);
    expect(store.state === "ok" && store.digest).toBe(request.expectedParentDigest);
  });

  it("maps a stale and a busy seal lock without reclaiming it", async () => {
    await autonomousOn();
    const request = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    const lock = join(root, `.${ID}.lock`);
    await writeFile(lock, JSON.stringify({ pid: 999_999, host: "here", startedAt: NOW }));
    await expect(run(request, "autonomous", { sealDeps: { now: () => NOW, host: "here", isPidAlive: () => false } })).rejects.toThrow(/^EVOLUTION_SEAL_LOCK_STALE:/);
    expect(await kinds()).toContain("seal.lock-stale");
    await expect(run(request, "autonomous", { sealDeps: { now: () => NOW, host: "here", isPidAlive: () => true } })).rejects.toThrow(/^EVOLUTION_SEAL_BUSY:/);
    expect(await stateOf(request)).toBe("open");
    await rm(lock);
    expect((await run(request)).outcome).toBe("sealed");
  });

  it("refuses an unknown, expired or superseded request", async () => {
    await expect(sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: "00000000-0000-4000-8000-999999999999", mode: "autonomous" }, { now: () => NOW })).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
    const expired = await issue(TIGHTER, { at: NOW - REQUEST_TTL_MS - 1 });
    await expect(run(expired)).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await stateOf(expired)).toBe("expired");
    const superseded = await issue(TIGHTER);
    await sealContract({ vaultRealPath: vault, vaultId: ID, contract: WIDER }, root);
    await expect(run(superseded)).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await stateOf(superseded)).toBe("superseded");
  });

  it("counts an autonomous seal from the journal time and allows one a day later", async () => {
    await autonomousOn();
    const first = await withVerdicts(await issue(TIGHTER), ["approve", "approve", "reject"]);
    await sealGate({ root, vaultId: ID, vaultRealPath: vault, requestId: first.requestId, mode: "autonomous" }, { now: () => NOW - DAY_MS });
    const second = await withVerdicts(await issue(RENAMED), ["approve", "approve", "reject"]);
    expect((await run(second)).outcome).toBe("sealed");
  });
});

describe("sealGate human", () => {
  it("seals an awaiting-human loosening candidate, exempt from policy, quorum and rate limit", async () => {
    const request = await issue(WIDER, { state: "awaiting-human" });
    const result = await run(request, "human");
    expect(result).toMatchObject({ outcome: "sealed", direction: "loosening" });
    const last = (await readLineage(root, ID, "strict")).events.at(-1);
    expect(last).toMatchObject({ kind: "sealed", requestId: request.requestId, autonomous: false, mode: "human", evaluator: "human-cli" });
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.human-approved", detail: { direction: "loosening" } });
    expect(await stateOf(request)).toBe("sealed");
  });

  it("rejects for good a candidate that adds a refusal", async () => {
    const request = await issue(WIDER, { state: "awaiting-human" });
    const refusing: NoteJudge = (input, view) => view.state === "sealed" && Object.keys(view.contract.properties).length > 0 && (view.contract.properties.status?.rules[0] as { values: string[] }).values.length === 3
      ? { ...judge(input, view), ok: false, refusals: [{ field: "path", kind: "control-path" }] }
      : judge(input, view);
    expect(await run(request, "human", { judge: refusing })).toMatchObject({ outcome: "rejected", reason: "stage1-refusal" });
    expect(await readRequest(root, ID, request.requestId)).toMatchObject({ state: "rejected", rejectReason: "stage1-refusal" });
  });

  it("re-anchors a lineage gap when the owner approves", async () => {
    const request = await issue(WIDER, { state: "awaiting-human" });
    const beforeSeal = async (): Promise<void> => {
      const { tail } = await lineageTail(root, ID);
      await appendLineageEvents(root, ID, [{ kind: "sealed", generation: null, parentDigest: tail.digest as never, digest: FOREIGN as never, mutations: [], manifestDigests: {} }], { expectTail: tail.digest as never });
    };
    const result = await run(request, "human", { beforeSeal });
    expect(result).toMatchObject({ outcome: "sealed", warnings: ["lineage-gap-reanchored"] });
    expect(await kinds()).toContain("lineage.reanchored");
  });

  it("refuses when the store no longer has the parent the owner was shown", async () => {
    const request = await issue(WIDER, { state: "awaiting-human" });
    const shown = await readStore(ID, root);
    const mismatch = { root, vaultId: ID, vaultRealPath: vault, requestId: request.requestId, mode: "human" as const, expectedParentDigest: FOREIGN };
    await expect(sealGate(mismatch, { now: () => NOW })).rejects.toThrow(/^EVOLUTION_PARENT_MOVED:/);
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "seal.parent-moved", detail: { expectedParentDigest: FOREIGN } });
    expect(await readStore(ID, root)).toEqual(shown);
    expect(await stateOf(request)).toBe("awaiting-human");
    const matching = { ...mismatch, expectedParentDigest: shown.state === "ok" ? shown.digest : "" };
    expect((await sealGate(matching, { now: () => NOW })).outcome).toBe("sealed");
  });

  it("refuses an open request and records nothing", async () => {
    const request = await issue(TIGHTER);
    await expect(run(request, "human")).rejects.toThrow(/^EVOLUTION_REQUEST_CLOSED:/);
    expect(await kinds()).toEqual(["request.issued"]);
  });
});
