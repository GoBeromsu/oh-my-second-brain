import type { Digest } from "../conventions/canonical.js";
import { isDigest } from "../contract/digest.js";
import { bootstrapSnapshots, readStore } from "../contract/store.js";
import { appendEvolutionEvent } from "./events.js";
import { withEvolutionLock, type LockDeps } from "./evolution-lock.js";
import type { Direction } from "./mutation-direction.js";
import { createRequest, lineageTail, type RequestDeps } from "./request-state.js";
import { requestDirection } from "./seal-gate.js";
import { readSnapshotContract } from "./snapshot-contract.js";
import { mechanicalStage, type MechanicalResult, type NoteJudge } from "./stage-mechanical.js";

/**
 * Revert is forward-only: it proposes a sealed generation's contract, read back from its
 * snapshot (never from a retained store directory), as a new candidate on top of the current
 * tail. The request then goes through the same seal-gate as any evolution: a loosening revert
 * or one that raises warnings waits for the owner, and nothing is sealed here.
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
}

export interface RevertProposal {
  readonly requestId: string;
  readonly targetDigest: Digest;
  readonly candidateDigest: Digest;
  readonly parentDigest: string;
  readonly parentEventSeq: number;
  readonly direction: Direction;
  readonly state: "open" | "awaiting-human";
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
  const state = direction === "loosening" || stage1.warningDelta > 0 ? "awaiting-human" : "open";
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
