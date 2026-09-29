import { canonicalJson } from "../conventions/canonical.js";
import { lineageAppender, LineageGap } from "../contract/lineage.js";
import { isNonLoosening } from "../contract/loosening.js";
import { readStore, sealContract, type SealDeps } from "../contract/store.js";
import type { VaultContract } from "../contract/types.js";
import { assertNotStalled, autonomousRun, isStalled } from "./convergence.js";
import { appendEvolutionEvent, readEvolutionEvents } from "./events.js";
import { withEvolutionLock, type LockDeps } from "./evolution-lock.js";
import { classifyAll, type Direction } from "./mutation-direction.js";
import { readPolicy } from "./policy.js";
import { autonomousSeals, checkRateLimit } from "./rate-limit.js";
import {
  lineageTail,
  listRequests,
  QUORUM,
  readPinnedCandidate,
  readRequest,
  RequestClosed,
  settleRequest,
  transition,
  writeRequest,
  type RequestRecord,
  type SealMode,
  type VerdictRecord,
} from "./request-state.js";
import { mechanicalStage, type MechanicalResult, type NoteJudge } from "./stage-mechanical.js";

/**
 * The one path from an evolution request to a sealed contract. It is the only evolution
 * module that calls `sealContract`, and it seals exactly the bytes pinned in the request.
 *
 * Autonomous mode, in order:
 *   1. the request is open (a derived expiry, supersede or seal is persisted and refused);
 *   2. a loosening candidate moves to awaiting-human, whatever the policy says;
 *   3. the autonomous policy is on (else EVOLUTION_POLICY_OFF; the request stays open), and
 *      evolution has not stalled (EVOLUTION_STALLED after 3 autonomous generations in a row);
 *   4. stage 1: a new refusal rejects, a rising warning count moves to awaiting-human;
 *   5. the quorum: all 3 bound verdicts arrived and 2 of 3 approve (2 rejects reject);
 *   6. the rate limit, counted from the lineage;
 *   7. the pinned bytes verify; the seal attempt is recorded; then the seal, refusing a
 *      lineage gap instead of re-anchoring it.
 * An autonomous rejection is reported and journalled, never persisted as a terminal state:
 * only a human rejects a request for good.
 *
 * Human mode (the owner approved in a terminal) needs the request awaiting-human and is
 * exempt from the policy, the quorum, the TTL and the rate limit, but not from stage 1: a
 * candidate that adds a refusal is rejected. A lineage gap is re-anchored.
 *
 * Seal failures map to EVOLUTION_* codes and are journalled; a stale seal lock is never
 * reclaimed here (the owner runs `oms setup`). The evolution lock is taken before the seal lock.
 */

class SealGateError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SealGateError";
  }
}

export interface Tally {
  readonly approve: number;
  readonly reject: number;
  readonly pending: number;
}

export type QuorumDecision = "approve" | "reject" | "pending";

const MAJORITY = Math.floor(QUORUM / 2) + 1;

export function tally(verdicts: readonly VerdictRecord[]): Tally {
  const approve = verdicts.filter(verdict => verdict.verdict === "approve").length;
  const reject = verdicts.length - approve;
  return { approve, reject, pending: Math.max(0, QUORUM - verdicts.length) };
}

export function quorumDecision(count: Tally): QuorumDecision {
  if (count.pending > 0) return "pending";
  // All three arrived, so a minority of approvals is a majority of rejections.
  return count.approve >= MAJORITY ? "approve" : "reject";
}

/** Which way the candidate moves from the parent; see mutation-direction.ts. */
export function requestDirection(request: RequestRecord, parent: VaultContract, candidate: VaultContract): Direction {
  if (!isNonLoosening(parent, candidate)) return "loosening";
  if (request.kind === "revert") return canonicalJson(parent) === canonicalJson(candidate) ? "neutral" : "tightening";
  return classifyAll(request.mutations, parent).direction;
}

export interface SealGateInput {
  readonly root: string;
  readonly vaultId: string;
  readonly vaultRealPath: string;
  readonly requestId: string;
  readonly mode: SealMode;
}

export interface SealGateDeps {
  readonly now: () => number;
  readonly judge?: NoteJudge;
  readonly lockDeps?: Partial<LockDeps>;
  /** Never carries `confirmStaleReclaim`: the seal-gate does not reclaim a seal lock. */
  readonly sealDeps?: Partial<Omit<SealDeps, "confirmStaleReclaim">>;
  /** Runs after every check and before the seal, holding the evolution lock (tests only). */
  readonly beforeSeal?: () => Promise<void>;
}

export type SealGateOutcome =
  | {
    readonly outcome: "sealed";
    readonly seq: number;
    readonly digest: string;
    readonly eventSeq: number;
    readonly warnings: readonly string[];
    readonly direction: Direction;
    readonly stage1: MechanicalResult;
  }
  | { readonly outcome: "awaiting-human"; readonly reason: "loosening" | "warning-delta" | "already"; readonly direction?: Direction; readonly stage1?: MechanicalResult }
  | { readonly outcome: "rejected"; readonly reason: "stage1-refusal" | "quorum-rejected"; readonly stage1?: MechanicalResult }
  | { readonly outcome: "pending"; readonly quorum: Tally };

function stage1Summary(stage1: MechanicalResult): Record<string, number> {
  return { scannedNotes: stage1.scannedNotes, newRefusals: stage1.newRefusals, warningDelta: stage1.warningDelta };
}

async function toAwaitingHuman(input: SealGateInput, request: RequestRecord, now: number, reason: "loosening" | "warning-delta", detail: Record<string, unknown>): Promise<void> {
  await writeRequest(input.root, input.vaultId, transition(request, "awaiting-human"));
  if (reason === "loosening") await appendEvolutionEvent(input.root, input.vaultId, { kind: "seal.blocked-loosening", at: now, requestId: request.requestId, detail });
  await appendEvolutionEvent(input.root, input.vaultId, { kind: "request.awaiting-human", at: now, requestId: request.requestId, detail: { reason, ...detail } });
}

async function checkRate(input: SealGateInput, request: RequestRecord, now: number): Promise<void> {
  const policy = (await readPolicy(input.root, input.vaultId)).policy;
  const { events } = await lineageTail(input.root, input.vaultId);
  const requests = (await listRequests(input.root, input.vaultId)).records;
  const journal = (await readEvolutionEvents(input.root, input.vaultId)).events;
  const check = checkRateLimit(autonomousSeals(events, requests, journal), policy.limits, now);
  if (check.allowed) return;
  await appendEvolutionEvent(input.root, input.vaultId, { kind: "seal.rate-limited", at: now, requestId: request.requestId, detail: { day: check.day, week: check.week, limits: policy.limits } });
  throw new SealGateError("EVOLUTION_RATE_LIMITED", `${check.day} autonomous seal(s) in the last day and ${check.week} in the last week reach the limit of ${policy.limits.perDay}/day and ${policy.limits.perWeek}/week; try later or approve in a terminal`);
}

async function mapSealFailure(input: SealGateInput, request: RequestRecord, now: number, error: unknown): Promise<never> {
  const at = { at: now, requestId: request.requestId };
  if (error instanceof LineageGap) {
    await appendEvolutionEvent(input.root, input.vaultId, { kind: "lineage.gap-refused", ...at, detail: { tailDigest: error.tailDigest, parentDigest: error.parentDigest } });
    throw new SealGateError("EVOLUTION_LINEAGE_GAP", `the lineage ends at ${error.tailDigest} but the store holds ${error.parentDigest}; nothing was sealed. Run \`oms doctor lineage-reanchor\` in a terminal, then evolve again`);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("CONTRACT_SEAL_CHANGED:")) {
    await appendEvolutionEvent(input.root, input.vaultId, { kind: "seal.parent-moved", ...at, detail: { expectedParentDigest: request.expectedParentDigest } });
    throw new SealGateError("EVOLUTION_PARENT_MOVED", "the contract was sealed elsewhere meanwhile; nothing was sealed. Evolve again from the current contract");
  }
  if (message.startsWith("CONTRACT_SEAL_LOCK_STALE:")) {
    await appendEvolutionEvent(input.root, input.vaultId, { kind: "seal.lock-stale", ...at });
    throw new SealGateError("EVOLUTION_SEAL_LOCK_STALE", "a stale seal lock remains; run `oms setup` in a terminal to reclaim it, then try again");
  }
  if (message.startsWith("CONTRACT_SEAL_BUSY:")) throw new SealGateError("EVOLUTION_SEAL_BUSY", "another seal is in progress for this vault; try again later");
  throw error;
}

async function gate(input: SealGateInput, deps: SealGateDeps): Promise<SealGateOutcome> {
  const now = deps.now();
  const { root, vaultId } = input;
  const stored = await readRequest(root, vaultId, input.requestId);
  if (stored === null) throw new SealGateError("EVOLUTION_REQUEST_UNKNOWN", `request ${input.requestId} does not exist`);
  const { events } = await lineageTail(root, vaultId);
  const request = await settleRequest(root, vaultId, stored, events, now);
  const wanted = input.mode === "autonomous" ? "open" : "awaiting-human";
  if (input.mode === "autonomous" && request.state === "awaiting-human") return { outcome: "awaiting-human", reason: "already" };
  if (request.state !== wanted) throw new RequestClosed(request.requestId, request.state);

  const parent = await readStore(vaultId, root);
  if (parent.state !== "ok" || parent.digest !== request.expectedParentDigest) {
    await appendEvolutionEvent(root, vaultId, { kind: "seal.parent-moved", at: now, requestId: request.requestId, detail: { expectedParentDigest: request.expectedParentDigest } });
    throw new SealGateError("EVOLUTION_PARENT_MOVED", "the sealed contract is not the one this request was built on; evolve again from the current contract");
  }
  const candidate = await readPinnedCandidate(root, vaultId, request);
  const direction = requestDirection(request, parent.contract, candidate.contract);

  if (input.mode === "autonomous") {
    if (direction === "loosening") {
      await toAwaitingHuman(input, request, now, "loosening", { direction });
      return { outcome: "awaiting-human", reason: "loosening", direction };
    }
    if (!(await readPolicy(root, vaultId)).policy.autonomous) {
      throw new SealGateError("EVOLUTION_POLICY_OFF", "autonomous sealing is off for this vault; turn it on with `oms setup` in a terminal, or wait for an owner to approve");
    }
    if (isStalled(events)) {
      await appendEvolutionEvent(root, vaultId, { kind: "seal.stalled", at: now, requestId: request.requestId, detail: { run: autonomousRun(events) } });
      assertNotStalled(events);
    }
  }

  const stage1 = await mechanicalStage(input.vaultRealPath, parent.contract, candidate.contract, deps.judge);
  if (!stage1.passed) {
    await appendEvolutionEvent(root, vaultId, { kind: "request.rejected", at: now, requestId: request.requestId, detail: { reason: "stage1-refusal", mode: input.mode, ...stage1Summary(stage1) } });
    if (input.mode === "human") await writeRequest(root, vaultId, transition(request, "rejected", { rejectReason: "stage1-refusal" }));
    return { outcome: "rejected", reason: "stage1-refusal", stage1 };
  }

  if (input.mode === "autonomous") {
    if (stage1.warningDelta > 0) {
      await toAwaitingHuman(input, request, now, "warning-delta", { direction, ...stage1Summary(stage1) });
      return { outcome: "awaiting-human", reason: "warning-delta", direction, stage1 };
    }
    const count = tally(request.verdicts);
    const decision = quorumDecision(count);
    if (decision === "pending") return { outcome: "pending", quorum: count };
    if (decision === "reject") {
      await appendEvolutionEvent(root, vaultId, { kind: "request.rejected", at: now, requestId: request.requestId, detail: { reason: "quorum-rejected", mode: input.mode, approve: count.approve, reject: count.reject } });
      return { outcome: "rejected", reason: "quorum-rejected", stage1 };
    }
    await checkRate(input, request, now);
  }

  const attempting: RequestRecord = { ...request, sealAttempt: { requestId: request.requestId, parentEventSeq: request.parentEventSeq, candidateDigest: request.candidateDigest, mode: input.mode, at: now } };
  await writeRequest(root, vaultId, attempting);
  await deps.beforeSeal?.();
  const autonomous = input.mode === "autonomous";
  const evaluator = autonomous ? request.verdicts.map(verdict => verdict.evaluatorSessionId).join(",") : "human-cli";
  let sealed;
  try {
    sealed = await sealContract({
      vaultRealPath: input.vaultRealPath,
      vaultId,
      contract: candidate.contract,
      declined: candidate.declined,
      expectedParentDigest: request.expectedParentDigest,
      lineageGapPolicy: autonomous ? "refuse" : "reanchor",
      onSealed: lineageAppender({
        proposer: request.makerSessionId ?? "maker",
        evaluator,
        requestId: request.requestId,
        autonomous,
        mode: input.mode,
        mutations: request.mutations,
        ...(request.revertOf === undefined ? {} : { revertOf: request.revertOf }),
      }),
    }, root, deps.sealDeps ?? {});
  } catch (error: unknown) {
    return mapSealFailure(input, request, now, error);
  }
  await writeRequest(root, vaultId, transition(attempting, "sealed"));
  const tail = (await lineageTail(root, vaultId)).tail;
  await appendEvolutionEvent(root, vaultId, {
    kind: autonomous ? "seal.autonomous" : "seal.human-approved",
    at: now,
    requestId: request.requestId,
    detail: { seq: sealed.seq, digest: sealed.digest, eventSeq: tail.eventSeq, direction, ...stage1Summary(stage1) },
  });
  if (sealed.warnings.includes("lineage-gap-reanchored")) {
    await appendEvolutionEvent(root, vaultId, { kind: "lineage.reanchored", at: now, requestId: request.requestId, detail: { anchors: sealed.anchors.length } });
  }
  return { outcome: "sealed", seq: sealed.seq, digest: sealed.digest, eventSeq: tail.eventSeq, warnings: sealed.warnings, direction, stage1 };
}

/** Runs the gate holding the evolution lock. */
export async function sealGate(input: SealGateInput, deps: SealGateDeps): Promise<SealGateOutcome> {
  return withEvolutionLock(input.root, input.vaultId, () => gate(input, deps), { now: deps.now, ...deps.lockDeps });
}
