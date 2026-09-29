import { readStore } from "../contract/store.js";
import type { HumanRejectReason, HumanSessionOutcome } from "./decision.js";
import { appendEvolutionEvent } from "./events.js";
import { withEvolutionLock } from "./evolution-lock.js";
import type { Direction } from "./mutation-direction.js";
import {
  assertActive, lineageTail, readPinnedCandidate, readRequest, settleRequest, transition, writeRequest, type RequestKind, type RequestState,
} from "./request-state.js";
import { requestDirection, sealGate, type SealGateDeps, type SealGateInput, type SealGateOutcome } from "./seal-gate.js";

/**
 * The owner approves an awaiting-human request in a terminal. The order is fixed:
 *   1. the request is awaiting-human and not derived-superseded (read without any lock);
 *   2. the pinned bytes verify and the sealed parent is read; its digest is kept;
 *   3. the owner is asked, holding no lock at all, so a slow answer blocks nobody;
 *   4. on approve the seal-gate runs in human mode with the kept digest: it re-checks the
 *      bytes, re-runs stage 1, records the direction and seals. A seal that landed while the
 *      owner was answering is EVOLUTION_PARENT_MOVED.
 * Human mode is exempt from the opt-in policy, the quorum, the TTL and the rate limit, and
 * consumes no autonomous budget. Every reject is journalled with its reason; only an
 * explicit one moves the request to rejected, anything else just ends the session.
 */

class HumanApprovalError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "HumanApprovalError";
  }
}

/** What the owner is shown before answering. */
export interface HumanPrompt {
  readonly requestId: string;
  readonly kind: RequestKind;
  readonly direction: Direction;
  readonly parentDigest: string;
  readonly candidateDigest: string;
  readonly mutations: number;
  readonly revertOf?: string;
}

export type HumanApprovalInput = Omit<SealGateInput, "mode" | "expectedParentDigest">;

export interface HumanApprovalDeps extends SealGateDeps {
  /** The terminal session; it runs with no lock held. */
  readonly ask: (prompt: HumanPrompt) => Promise<HumanSessionOutcome>;
}

export type HumanApprovalResult =
  | { readonly decision: "approve"; readonly gate: SealGateOutcome }
  | { readonly decision: "reject"; readonly reason: HumanRejectReason; readonly state: RequestState };

async function prepare(input: HumanApprovalInput, now: number): Promise<HumanPrompt> {
  const { root, vaultId } = input;
  const request = await readRequest(root, vaultId, input.requestId);
  if (request === null) throw new HumanApprovalError("EVOLUTION_REQUEST_UNKNOWN", `request ${input.requestId} does not exist`);
  const { events } = await lineageTail(root, vaultId);
  assertActive(request, events, now, ["awaiting-human"]);
  const parent = await readStore(vaultId, root);
  if (parent.state !== "ok") throw new HumanApprovalError("EVOLUTION_PARENT_MOVED", "the vault has no readable sealed contract; run `oms doctor contract`");
  const candidate = await readPinnedCandidate(root, vaultId, request);
  return {
    requestId: request.requestId,
    kind: request.kind,
    direction: requestDirection(request, parent.contract, candidate.contract),
    parentDigest: parent.digest,
    candidateDigest: request.candidateDigest,
    mutations: request.mutations.length,
    ...(request.revertOf === undefined ? {} : { revertOf: request.revertOf }),
  };
}

async function recordReject(input: HumanApprovalInput, deps: HumanApprovalDeps, reason: HumanRejectReason): Promise<HumanApprovalResult> {
  const { root, vaultId } = input;
  return withEvolutionLock(root, vaultId, async () => {
    const now = deps.now();
    const stored = await readRequest(root, vaultId, input.requestId);
    if (stored === null) throw new HumanApprovalError("EVOLUTION_REQUEST_UNKNOWN", `request ${input.requestId} does not exist`);
    const request = await settleRequest(root, vaultId, stored, (await lineageTail(root, vaultId)).events, now);
    const reject = reason === "explicit" && request.state === "awaiting-human";
    if (reject) await writeRequest(root, vaultId, transition(request, "rejected", { rejectReason: "explicit" }));
    await appendEvolutionEvent(root, vaultId, { kind: "seal.human-rejected", at: now, requestId: request.requestId, detail: { reason, state: reject ? "rejected" : request.state } });
    return { decision: "reject", reason, state: reject ? "rejected" : request.state };
  }, { now: deps.now, ...deps.lockDeps });
}

/** Asks the owner, then seals in human mode or records the reject. */
export async function approveInTerminal(input: HumanApprovalInput, deps: HumanApprovalDeps): Promise<HumanApprovalResult> {
  const prompt = await prepare(input, deps.now());
  const outcome = await deps.ask(prompt);
  if (outcome.decision === "reject") return recordReject(input, deps, outcome.reason);
  const gate = await sealGate({ ...input, mode: "human", expectedParentDigest: prompt.parentDigest }, deps);
  return { decision: "approve", gate };
}
