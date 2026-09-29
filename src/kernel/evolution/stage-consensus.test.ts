import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStore, sealContract } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { readEvolutionEvents } from "./events.js";
import { writePolicy } from "./policy.js";
import { createRequest, lineageTail, readRequest, REQUEST_TTL_MS, type RequestRecord } from "./request-state.js";
import {
  evaluationRequest, MAJORITY, recordVerdict, retryRequest, RUBRIC, runConsensus,
  type EvaluationRequest, type VerdictProvider, type VerdictSubmission,
} from "./stage-consensus.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_700_000_000_000;
let base: string;
let root: string;
let vault: string;
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const TIGHTER: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-consensus-")));
  root = join(base, "home", ".oms", "vaults");
  vault = join(base, "vault");
  process.env.HOME = join(base, "home");
  process.env.USERPROFILE = join(base, "home");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await writeFile(join(vault, "Projects", "ok.md"), "---\nstatus: a\n---\n");
  await sealContract({ vaultRealPath: vault, vaultId: ID, contract: PARENT }, root);
  await writePolicy(root, ID, { version: 1, autonomous: true, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
});
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
const ids = (at: number) => ({
  now: () => at,
  newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  newToken: () => (++counter).toString(16).padStart(32, "0"),
});

async function issue(contract: VaultContract = TIGHTER): Promise<RequestRecord> {
  const { tail } = await lineageTail(root, ID);
  return createRequest(root, ID, { kind: "evolve", contract, mutations: [], parent: tail, makerSessionId: "maker-1" }, ids(NOW));
}

function submission(request: RequestRecord | EvaluationRequest, slot: number, verdict: "approve" | "reject", extra: Partial<VerdictSubmission> = {}): VerdictSubmission {
  const parentDigest = "expectedParentDigest" in request ? request.expectedParentDigest : request.parentDigest;
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    slotToken: request.slots[slot] as string,
    candidateDigest: request.candidateDigest,
    parentDigest,
    evaluatorSessionId: `eval-${slot}`,
    verdict,
    rubricScores: { "intent-preserved": 1 },
    reasons: ["ok"],
    ...extra,
  };
}

const input = () => ({ root, vaultId: ID, vaultRealPath: vault });
const record = (value: VerdictSubmission, at = NOW) => recordVerdict(input(), value, { now: () => at });
const kinds = async (): Promise<string[]> => (await readEvolutionEvents(root, ID)).events.map(event => event.kind);
const discarded = async (): Promise<unknown[]> => (await readEvolutionEvents(root, ID)).events
  .filter(event => event.kind === "verdict.received" && event.detail?.accepted === false)
  .map(event => event.detail?.discarded);

function provider(build: (request: EvaluationRequest) => VerdictSubmission[], subagents = true): VerdictProvider & { calls: number } {
  const fake = {
    host: subagents ? "claude" : "hermes",
    subagents,
    calls: 0,
    async collect(request: EvaluationRequest) {
      fake.calls += 1;
      return build(request);
    },
  };
  return fake;
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = await readFile(path, "utf8");
  }
  return out;
}

describe("evaluationRequest", () => {
  it("carries the bindings, the rubric and the 2/3 quorum", async () => {
    const request = await issue();
    expect(evaluationRequest(request, ["gap-1"])).toEqual({
      requestId: request.requestId, nonce: request.nonce, issuedAt: NOW, expiresAt: NOW + REQUEST_TTL_MS,
      parentDigest: request.expectedParentDigest, candidateDigest: request.candidateDigest, contractDiff: [],
      gaps: ["gap-1"], rubric: RUBRIC, quorum: 3, majority: MAJORITY, slots: request.slots,
    });
    expect(evaluationRequest(request).gaps).toEqual([]);
  });
});

describe("runConsensus with a fake provider", () => {
  it("seals when two of three verdicts approve", async () => {
    const request = await issue();
    const fake = provider(req => [submission(req, 0, "approve"), submission(req, 1, "reject"), submission(req, 2, "approve")]);
    const result = await runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW });
    expect(result.refused).toEqual([]);
    expect(result.receipts.map(receipt => receipt.quorum)).toEqual([
      { approve: 1, reject: 0, pending: 2 }, { approve: 1, reject: 1, pending: 1 }, { approve: 2, reject: 1, pending: 0 },
    ]);
    expect(result.receipts[0]?.sealed).toBeUndefined();
    expect(result.receipts[2]).toMatchObject({ slot: 2, accepted: true, sealed: { seq: 2, digest: request.candidateDigest }, gate: { outcome: "sealed" } });
    const store = await readStore(ID, root);
    expect(store.state === "ok" && store.digest).toBe(request.candidateDigest);
  });

  it("rejects when only one verdict approves", async () => {
    const request = await issue();
    const fake = provider(req => [submission(req, 0, "reject"), submission(req, 1, "approve"), submission(req, 2, "reject")]);
    const result = await runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW });
    expect(result.receipts[2]).toMatchObject({ quorum: { approve: 1, reject: 2, pending: 0 }, gate: { outcome: "rejected", reason: "quorum-rejected" } });
    expect(result.receipts[2]?.sealed).toBeUndefined();
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "request.rejected", detail: { reason: "quorum-rejected" } });
    const store = await readStore(ID, root);
    expect(store.state === "ok" && store.digest).not.toBe(request.candidateDigest);
  });

  it("holds with only two verdicts and seals nothing", async () => {
    const request = await issue();
    const fake = provider(req => [submission(req, 0, "approve"), submission(req, 1, "approve")]);
    const result = await runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW });
    expect(result.receipts.at(-1)).toMatchObject({ quorum: { approve: 2, reject: 0, pending: 1 } });
    expect(result.receipts.at(-1)?.gate).toBeUndefined();
    expect((await readRequest(root, ID, request.requestId))?.state).toBe("open");
    expect(await kinds()).not.toContain("seal.autonomous");
  });

  it("reports a gate refusal without losing the verdicts", async () => {
    await writePolicy(root, ID, { version: 1, autonomous: false, limits: { perDay: 1, perWeek: 3 } }, { interactive: true });
    const request = await issue();
    const fake = provider(req => [0, 1, 2].map(slot => submission(req, slot, "approve")));
    const result = await runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW });
    expect(result.receipts[2]?.gate).toMatchObject({ outcome: "refused", code: "EVOLUTION_POLICY_OFF" });
    expect((await readRequest(root, ID, request.requestId))?.verdicts).toHaveLength(3);
  });

  it("collects refused verdicts alongside accepted ones", async () => {
    const request = await issue();
    const fake = provider(req => [submission(req, 0, "approve"), submission(req, 0, "approve", { evaluatorSessionId: "other" })]);
    const result = await runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW });
    expect(result.receipts).toHaveLength(1);
    expect(result.refused).toEqual([{ slotToken: request.slots[0], message: expect.stringMatching(/^EVOLUTION_VERDICT_REFUSED: .*slot-reused/) }]);
  });

  it("fails loudly on a host without subagents and leaves the store unchanged", async () => {
    const request = await issue();
    const before = await snapshot(join(base, "home"));
    const fake = provider(() => [], false);
    await expect(runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW }))
      .rejects.toThrow(/^EVALUATOR_CONSENSUS_UNAVAILABLE: .*Claude Code or Codex/);
    expect(fake.calls).toBe(0);
    expect(await snapshot(join(base, "home"))).toEqual(before);
  });

  it("rethrows an error that is not an evolution refusal", async () => {
    const request = await issue();
    const fake = provider(() => { throw new Error("host crashed"); });
    await expect(runConsensus(fake, input(), evaluationRequest(request), { now: () => NOW })).rejects.toThrow("host crashed");
  });
});

describe("recordVerdict refusals", () => {
  it("refuses a reused slot token", async () => {
    const request = await issue();
    await record(submission(request, 0, "approve"));
    await expect(record(submission(request, 0, "approve", { evaluatorSessionId: "eval-9" }))).rejects.toThrow(/slot-reused/);
    expect((await readRequest(root, ID, request.requestId))?.verdicts).toHaveLength(1);
  });

  it("refuses a second verdict from the same evaluator session", async () => {
    const request = await issue();
    await record(submission(request, 0, "approve"));
    await expect(record(submission(request, 1, "approve", { evaluatorSessionId: "eval-0" }))).rejects.toThrow(/session-duplicate/);
  });

  it("refuses a verdict from the maker's session", async () => {
    const request = await issue();
    await expect(record(submission(request, 0, "approve", { evaluatorSessionId: "maker-1" }))).rejects.toThrow(/session-is-maker/);
    expect((await readRequest(root, ID, request.requestId))?.verdicts).toEqual([]);
  });

  it.each([
    ["candidateDigest", "candidate-mismatch", { candidateDigest: `sha256:${"c".repeat(64)}` }],
    ["parentDigest", "parent-mismatch", { parentDigest: `sha256:${"d".repeat(64)}` }],
    ["nonce", "nonce-mismatch", { nonce: "e".repeat(32) }],
    ["slotToken", "slot-unknown", { slotToken: "a".repeat(32) }],
    ["requestId", "request-unknown", { requestId: "00000000-0000-4000-8000-999999999999" }],
    ["verdict schema", "invalid-verdict", { verdict: "maybe" as never }],
    ["empty session", "invalid-verdict", { evaluatorSessionId: "" }],
    ["rubric scores", "invalid-verdict", { rubricScores: { mece: "high" } as never }],
    ["reasons", "invalid-verdict", { reasons: [1] as never }],
  ])("discards a %s mismatch and journals the reason", async (_field, reason, extra) => {
    const request = await issue();
    await expect(record(submission(request, 0, "approve", extra))).rejects.toThrow(new RegExp(`^EVOLUTION_VERDICT_REFUSED: .*${reason}`));
    expect(await discarded()).toEqual([reason]);
    expect((await readRequest(root, ID, request.requestId))?.verdicts).toEqual([]);
  });

  it("refuses a verdict at 15:00 and accepts one at 14:59", async () => {
    const late = await issue();
    await expect(record(submission(late, 0, "approve"), NOW + REQUEST_TTL_MS)).rejects.toThrow(/EVOLUTION_REQUEST_CLOSED/);
    expect(await kinds()).toContain("request.expired");
    expect((await readRequest(root, ID, late.requestId))).toMatchObject({ state: "expired", verdicts: [] });
    const onTime = await issue();
    await expect(record(submission(onTime, 0, "approve"), NOW + REQUEST_TTL_MS - 60_000)).resolves.toMatchObject({ accepted: true, slot: 0 });
  });
});

describe("retryRequest", () => {
  it("re-issues an expired request with a new id and nonce and no verdicts", async () => {
    const old = await issue();
    await record(submission(old, 0, "approve"));
    const later = NOW + REQUEST_TTL_MS;
    const fresh = await retryRequest(input(), old.requestId, ids(later));
    expect(fresh.requestId).not.toBe(old.requestId);
    expect(fresh.nonce).not.toBe(old.nonce);
    expect(fresh).toMatchObject({ state: "open", verdicts: [], usedSlots: [], candidateDigest: old.candidateDigest, makerSessionId: "maker-1", issuedAt: later });
    expect((await readEvolutionEvents(root, ID)).events.at(-1)).toMatchObject({ kind: "request.retried", requestId: fresh.requestId, detail: { retryOf: old.requestId } });
    await expect(record(submission(old, 1, "approve"), later)).rejects.toThrow(/EVOLUTION_REQUEST_CLOSED/);
    await expect(record(submission(fresh, 0, "approve"), later)).resolves.toMatchObject({ quorum: { approve: 1, pending: 2 } });
  });

  it("refuses to retry an open or unknown request", async () => {
    const open = await issue();
    await expect(retryRequest(input(), open.requestId, ids(NOW))).rejects.toThrow(/EVOLUTION_REQUEST_CLOSED/);
    await expect(retryRequest(input(), "00000000-0000-4000-8000-999999999999", ids(NOW))).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN/);
  });
});
