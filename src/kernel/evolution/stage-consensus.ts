import type { Digest } from "../conventions/canonical.js";
import type { Mutation } from "../contract/mutation.js";
import { appendEvolutionEvent } from "./events.js";
import { withEvolutionLock, type LockDeps } from "./evolution-lock.js";
import {
  createRequest,
  lineageTail,
  QUORUM,
  readPinnedCandidate,
  readRequest,
  RequestClosed,
  settleRequest,
  writeRequest,
  type RequestDeps,
  type RequestRecord,
  type VerdictRecord,
} from "./request-state.js";
import { sealGate, tally, type SealGateDeps, type SealGateOutcome, type Tally } from "./seal-gate.js";

/**
 * Stage 3: a host-attested quorum. OMS owns no model key; the host (Claude Code, Codex)
 * runs three independent subagents, each of which submits one verdict bound to the
 * request by its requestId, nonce, one single-use slot token, the candidate digest and
 * the parent digest. A verdict that does not match every binding, reuses a slot, repeats
 * an evaluator session or comes from the maker's session is discarded and journalled.
 * Nothing seals before the quorum: the third accepted verdict runs the seal-gate.
 *
 * The quorum is unverified (the host reports the session ids); it is safe only because a
 * loosening candidate never seals autonomously. A host without subagents fails loudly with
 * EVALUATOR_CONSENSUS_UNAVAILABLE and nothing is written.
 */

export const RUBRIC = ["intent-preserved", "mece", "no-hidden-loosening", "minimal-change"] as const;
export const MAJORITY = "2/3";

class ConsensusError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ConsensusError";
  }
}

export interface EvaluationRequest {
  readonly requestId: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly parentDigest: string;
  readonly candidateDigest: Digest;
  readonly contractDiff: readonly Mutation[];
  readonly gaps: readonly string[];
  readonly rubric: readonly string[];
  readonly quorum: number;
  readonly majority: string;
  readonly slots: readonly string[];
}

export function evaluationRequest(request: RequestRecord, gaps: readonly string[] = []): EvaluationRequest {
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    parentDigest: request.expectedParentDigest,
    candidateDigest: request.candidateDigest,
    contractDiff: request.mutations,
    gaps,
    rubric: RUBRIC,
    quorum: QUORUM,
    majority: MAJORITY,
    slots: request.slots,
  };
}

export interface VerdictSubmission {
  readonly requestId: string;
  readonly nonce: string;
  readonly slotToken: string;
  readonly candidateDigest: string;
  readonly parentDigest: string;
  readonly evaluatorSessionId: string;
  readonly verdict: "approve" | "reject";
  readonly rubricScores: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

/** The host side of stage 3; tests inject a fake. */
export interface VerdictProvider {
  readonly host: string;
  /** False on a host that cannot run independent subagents (Hermes). */
  readonly subagents: boolean;
  collect(request: EvaluationRequest): Promise<readonly VerdictSubmission[]>;
}

export interface ConsensusInput {
  readonly root: string;
  readonly vaultId: string;
  readonly vaultRealPath: string;
}

export interface ConsensusDeps extends SealGateDeps {
  readonly lockDeps?: Partial<LockDeps>;
}

export interface VerdictReceipt {
  readonly requestId: string;
  readonly slot: number;
  readonly accepted: true;
  readonly quorum: Tally;
  readonly sealed?: { readonly seq: number; readonly digest: string; readonly eventSeq: number };
  /** The seal-gate's answer once the quorum is complete. */
  readonly gate?: SealGateOutcome | { readonly outcome: "refused"; readonly code: string; readonly message: string };
}

export type DiscardReason =
  | "invalid-verdict"
  | "request-unknown"
  | "nonce-mismatch"
  | "candidate-mismatch"
  | "parent-mismatch"
  | "slot-unknown"
  | "slot-reused"
  | "session-duplicate"
  | "session-is-maker"
  | "maker-unknown";

function validSubmission(input: VerdictSubmission): boolean {
  return typeof input.evaluatorSessionId === "string" && input.evaluatorSessionId.length > 0
    && (input.verdict === "approve" || input.verdict === "reject")
    && typeof input.rubricScores === "object" && input.rubricScores !== null && !Array.isArray(input.rubricScores)
    && Object.values(input.rubricScores).every(score => typeof score === "number" && Number.isFinite(score))
    && Array.isArray(input.reasons) && input.reasons.every(reason => typeof reason === "string");
}

/** Why the verdict cannot count, or null when it binds to the request. */
function discardReason(request: RequestRecord, input: VerdictSubmission): DiscardReason | null {
  if (!validSubmission(input)) return "invalid-verdict";
  if (input.nonce !== request.nonce) return "nonce-mismatch";
  if (input.candidateDigest !== request.candidateDigest) return "candidate-mismatch";
  if (input.parentDigest !== request.expectedParentDigest) return "parent-mismatch";
  if (!request.slots.includes(input.slotToken)) return "slot-unknown";
  if (request.usedSlots.includes(input.slotToken)) return "slot-reused";
  if (request.verdicts.some(verdict => verdict.evaluatorSessionId === input.evaluatorSessionId)) return "session-duplicate";
  // An evolve request always names its maker, so maker exclusion is unconditional; one without
  // (a record written before the maker session became required) cannot take a verdict.
  if (request.kind === "evolve" && request.makerSessionId === undefined) return "maker-unknown";
  if (input.evaluatorSessionId === request.makerSessionId) return "session-is-maker";
  return null;
}

async function discard(input: ConsensusInput, submission: VerdictSubmission, now: number, reason: DiscardReason): Promise<never> {
  await appendEvolutionEvent(input.root, input.vaultId, { kind: "verdict.received", at: now, requestId: submission.requestId, detail: { accepted: false, discarded: reason } });
  throw new ConsensusError("EVOLUTION_VERDICT_REFUSED", `the verdict was discarded (${reason}); nothing changed`);
}

/** Records one verdict under the evolution lock; the request must be open. */
async function accept(input: ConsensusInput, submission: VerdictSubmission, now: number): Promise<{ request: RequestRecord; slot: number }> {
  const stored = await readRequest(input.root, input.vaultId, submission.requestId);
  if (stored === null) return discard(input, submission, now, "request-unknown");
  const { events } = await lineageTail(input.root, input.vaultId);
  const request = await settleRequest(input.root, input.vaultId, stored, events, now);
  if (request.state !== "open") throw new RequestClosed(request.requestId, request.state);
  const reason = discardReason(request, submission);
  if (reason !== null) return discard(input, submission, now, reason);
  const slot = request.slots.indexOf(submission.slotToken);
  const verdict: VerdictRecord = {
    slot,
    evaluatorSessionId: submission.evaluatorSessionId,
    verdict: submission.verdict,
    rubricScores: { ...submission.rubricScores },
    reasons: [...submission.reasons],
    at: now,
  };
  const next: RequestRecord = { ...request, verdicts: [...request.verdicts, verdict], usedSlots: [...request.usedSlots, submission.slotToken] };
  await writeRequest(input.root, input.vaultId, next);
  await appendEvolutionEvent(input.root, input.vaultId, { kind: "verdict.received", at: now, requestId: request.requestId, detail: { accepted: true, slot, verdict: verdict.verdict } });
  return { request: next, slot };
}

function refusalCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("EVOLUTION_") ? code : null;
}

/**
 * Accepts one verdict (`doctor op: evolve-verdict`). When it completes the quorum, the
 * lock is released and the seal-gate runs in autonomous mode; its refusal (policy off,
 * rate limit, parent moved) is reported in `gate`, the verdict stays recorded.
 */
export async function recordVerdict(input: ConsensusInput, submission: VerdictSubmission, deps: ConsensusDeps): Promise<VerdictReceipt> {
  const now = deps.now();
  const { request, slot } = await withEvolutionLock(input.root, input.vaultId, () => accept(input, submission, now), { now: deps.now, ...deps.lockDeps });
  const quorum = tally(request.verdicts);
  const receipt = { requestId: request.requestId, slot, accepted: true as const, quorum };
  if (quorum.pending > 0) return receipt;
  let gate: SealGateOutcome;
  try {
    gate = await sealGate({ ...input, requestId: request.requestId, mode: "autonomous" }, deps);
  } catch (error: unknown) {
    const code = refusalCode(error);
    if (code === null) throw error;
    return { ...receipt, gate: { outcome: "refused", code, message: error instanceof Error ? error.message : String(error) } };
  }
  if (gate.outcome !== "sealed") return { ...receipt, gate };
  return { ...receipt, gate, sealed: { seq: gate.seq, digest: gate.digest, eventSeq: gate.eventSeq } };
}

export interface ConsensusResult {
  readonly receipts: readonly VerdictReceipt[];
  readonly refused: readonly { readonly slotToken: string; readonly message: string }[];
}

/**
 * Asks the provider for the three verdicts and records each. A host without subagents is
 * EVALUATOR_CONSENSUS_UNAVAILABLE before anything is asked or written.
 */
export async function runConsensus(provider: VerdictProvider, input: ConsensusInput, request: EvaluationRequest, deps: ConsensusDeps): Promise<ConsensusResult> {
  if (!provider.subagents) {
    throw new ConsensusError("EVALUATOR_CONSENSUS_UNAVAILABLE", `${provider.host} cannot run independent evaluator subagents; run the evolution from Claude Code or Codex, or approve in a terminal with \`oms doctor\``);
  }
  const receipts: VerdictReceipt[] = [];
  const refused: { slotToken: string; message: string }[] = [];
  for (const submission of await provider.collect(request)) {
    try {
      receipts.push(await recordVerdict(input, submission, deps));
    } catch (error: unknown) {
      if (refusalCode(error) === null) throw error;
      refused.push({ slotToken: submission.slotToken, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { receipts, refused };
}

/**
 * Re-issues an expired request: the same pinned candidate under a new requestId, nonce and
 * slot tokens, bound to the current tail; the old request's verdicts do not carry over.
 * Only an expired request is retried (a superseded one is evolved again from the new parent).
 */
export async function retryRequest(input: ConsensusInput, requestId: string, deps: RequestDeps & { readonly lockDeps?: Partial<LockDeps> }): Promise<RequestRecord> {
  return withEvolutionLock(input.root, input.vaultId, async () => {
    const now = deps.now();
    const stored = await readRequest(input.root, input.vaultId, requestId);
    if (stored === null) throw new ConsensusError("EVOLUTION_REQUEST_UNKNOWN", `request ${requestId} does not exist`);
    const { tail, events } = await lineageTail(input.root, input.vaultId);
    const old = await settleRequest(input.root, input.vaultId, stored, events, now);
    if (old.state !== "expired") throw new RequestClosed(old.requestId, old.state);
    const candidate = await readPinnedCandidate(input.root, input.vaultId, old);
    const fresh = await createRequest(input.root, input.vaultId, {
      kind: old.kind,
      contract: candidate.contract,
      declined: candidate.declined,
      mutations: old.mutations,
      parent: tail,
      ...(old.revertOf === undefined ? {} : { revertOf: old.revertOf }),
      ...(old.makerSessionId === undefined ? {} : { makerSessionId: old.makerSessionId }),
    }, deps);
    await appendEvolutionEvent(input.root, input.vaultId, { kind: "request.retried", at: now, requestId: fresh.requestId, detail: { retryOf: old.requestId } });
    return fresh;
  }, { now: deps.now, ...deps.lockDeps });
}
