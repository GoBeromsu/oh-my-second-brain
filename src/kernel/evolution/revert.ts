import type { Digest } from "../conventions/canonical.js";
import { isDigest } from "../contract/digest.js";
import { bootstrapSnapshots, readStore } from "../contract/store.js";
import { appendEvolutionEvent } from "./events.js";
import { anchorContract } from "./evaluator.js";
import { withEvolutionLock, type LockDeps } from "./evolution-lock.js";
import type { Direction } from "./mutation-direction.js";
import { createRequest, lineageTail, type RequestDeps } from "./request-state.js";
import { requestDirection } from "./seal-gate.js";
import { readSnapshotContract } from "./snapshot-contract.js";
import { mechanicalStage, type MechanicalResult, type NoteJudge } from "./stage-mechanical.js";
import { semanticStage, type Similarity } from "./stage-semantic.js";

/**
 * Revert is forward-only: it proposes a sealed generation's contract, read back from its
 * snapshot (never from a retained store directory), as a new candidate on top of the current
 * tail. A revert has no maker, so no host quorum can ever be bound to it: every revert,
 * tightening, neutral or loosening, waits for the owner (`oms setup`) whatever the policy
 * says, and nothing is sealed here. Stage 1 runs at propose time (a new refusal proposes
 * nothing: EVOLUTION_REVERT_REFUSED), and so does stage 2 against the first sealed generation
 * (a MECE overlap or drift past 0.3 proposes nothing: EVOLUTION_STAGE2_REFUSED), because an
 * owner approving in a terminal is exempt from every later check but stage 1.
 *
 * The target must be named by a `sealed` or `recovered` lineage event — an orphan snapshot is
 * not a generation. A missing or corrupt snapshot fails closed: it is journalled and the
 * store, lineage and pending requests stay as they were.
 */

class RevertError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RevertError";
  }
}

export interface RevertInput {
  readonly root: string;
  readonly vaultId: string;
  readonly vaultRealPath: string;
  readonly targetDigest: string;
}

export interface RevertDeps extends RequestDeps {
  readonly judge?: NoteJudge;
  readonly lockDeps?: Partial<LockDeps>;
  /** Stage 2's meaning similarity; token Jaccard when absent. */
  readonly similarity?: Similarity;
}

export interface RevertProposal {
  readonly requestId: string;
  readonly targetDigest: Digest;
  readonly candidateDigest: Digest;
  readonly parentDigest: string;
  readonly parentEventSeq: number;
  readonly direction: Direction;
  readonly state: "awaiting-human";
  readonly stage1: MechanicalResult;
}

async function propose(input: RevertInput, deps: RevertDeps): Promise<RevertProposal> {
  const { root, vaultId, targetDigest } = input;
  const now = deps.now();
  await bootstrapSnapshots(root, vaultId);
  const { tail, events } = await lineageTail(root, vaultId);
  if (!isDigest(targetDigest) || !events.some(event => event.digest === targetDigest)) {
    throw new RevertError("EVOLUTION_REVERT_TARGET_UNSEALED", `no sealed or recovered lineage event names ${targetDigest}; only a sealed generation can be restored`);
  }
  const snapshot = await readSnapshotContract(root, vaultId, targetDigest);
  if (snapshot.state !== "ok") {
    const reason = snapshot.state === "missing" ? "snapshot-missing" : "snapshot-corrupt";
    await appendEvolutionEvent(root, vaultId, { kind: "revert.source-unavailable", at: now, detail: { targetDigest, reason } });
    throw new RevertError("EVOLUTION_REVERT_SOURCE_UNAVAILABLE", `${reason}: the snapshot of ${targetDigest} cannot be read; nothing was proposed`);
  }
  const parent = await readStore(vaultId, root);
  if (parent.state !== "ok") throw new RevertError("EVOLUTION_REVERT_NO_CONTRACT", "the vault has no readable sealed contract to revert from; run `oms doctor contract`");
  if (parent.digest === snapshot.digest) throw new RevertError("EVOLUTION_REVERT_NOOP", `${targetDigest} is already the sealed contract`);

  const direction = requestDirection({ kind: "revert", mutations: [] }, parent.contract, snapshot.contract);
  const stage1 = await mechanicalStage(input.vaultRealPath, parent.contract, snapshot.contract, deps.judge);
  if (!stage1.passed) {
    throw new RevertError("EVOLUTION_REVERT_REFUSED", `restoring ${targetDigest} would make the judge refuse ${stage1.newRefusals} note(s) it accepts today; nothing was proposed`);
  }
  const anchor = await anchorContract(root, vaultId);
  const stage2 = semanticStage(anchor ?? parent.contract, parent.contract, snapshot.contract, deps.similarity === undefined ? {} : { similarity: deps.similarity });
  if (!stage2.passed) {
    const found = stage2.reason === "drift"
      ? `drifts ${stage2.drift.toFixed(2)} from the first sealed generation (limit 0.3)`
      : `overlaps in meaning: ${stage2.overlaps.map(overlap => `${overlap.axis} ${overlap.keys.join(" ~ ")}`).join(", ")}`;
    throw new RevertError("EVOLUTION_STAGE2_REFUSED", `restoring ${targetDigest} ${found}; nothing was proposed`);
  }
  const state = "awaiting-human";
  const request = await createRequest(root, vaultId, {
    kind: "revert",
    contract: snapshot.contract,
    declined: snapshot.declined,
    mutations: [],
    parent: tail,
    revertOf: snapshot.digest,
    state,
  }, deps);
  await appendEvolutionEvent(root, vaultId, {
    kind: "revert.proposed",
    at: now,
    requestId: request.requestId,
    detail: { targetDigest, candidateDigest: request.candidateDigest, direction, state, warningDelta: stage1.warningDelta },
  });
  return {
    requestId: request.requestId,
    targetDigest: snapshot.digest,
    candidateDigest: request.candidateDigest,
    parentDigest: request.expectedParentDigest,
    parentEventSeq: request.parentEventSeq,
    direction,
    state,
    stage1,
  };
}

/** Proposes restoring a sealed generation, holding the evolution lock. */
export async function proposeRevert(input: RevertInput, deps: RevertDeps): Promise<RevertProposal> {
  return withEvolutionLock(input.root, input.vaultId, () => propose(input, deps), { now: deps.now, ...deps.lockDeps });
}
