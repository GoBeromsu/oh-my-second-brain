import { openGaps, readGapLedger } from "../contract/gap-ledger.js";
import { currentSequence, readDeclined, readStore } from "../contract/store.js";
import { anchorContract, evaluateCandidate, type EvaluationRoute } from "./evaluator.js";
import { withEvolutionLock, type LockDeps } from "./evolution-lock.js";
import { draftEvolution, type GapDecision } from "./maker.js";
import type { Direction } from "./mutation-direction.js";
import { createRequest, lineageTail, type RequestDeps, type RequestRecord } from "./request-state.js";
import { evaluationRequest, type EvaluationRequest } from "./stage-consensus.js";
import type { MechanicalResult, NoteJudge } from "./stage-mechanical.js";
import type { SemanticResult, Similarity } from "./stage-semantic.js";

/**
 * One evolution round (`doctor op: evolve`): under the evolution lock, the maker drafts
 * generation N+1 from the open gap ledger, the evaluator runs stages 1 and 2 and the
 * direction check, and a request pinning the candidate is issued. A new refusal in stage 1
 * issues nothing (EVOLUTION_STAGE1_REFUSED), and neither does a MECE overlap or drift past
 * the threshold in stage 2 (EVOLUTION_STAGE2_REFUSED); a loosening candidate or one that raises
 * warnings waits for the owner; anything else waits for the host quorum. Nothing is sealed
 * here — only the seal-gate seals.
 */

class EvolveError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EvolveError";
  }
}

export interface EvolveInput {
  readonly root: string;
  readonly vaultId: string;
  readonly vaultRealPath: string;
  /**
   * The maker's session, so it can never be counted as one of its own evaluators. Required:
   * without it the maker could fill its own quorum (EVOLUTION_MAKER_SESSION_REQUIRED).
   */
  readonly makerSessionId: string;
}

export interface EvolveDeps extends RequestDeps {
  readonly judge?: NoteJudge;
  readonly similarity?: Similarity;
  readonly lockDeps?: Partial<LockDeps>;
}

export interface EvolveResult {
  readonly request: RequestRecord;
  readonly evaluation: EvaluationRequest;
  readonly route: Exclude<EvaluationRoute, "reject">;
  readonly direction: Direction;
  readonly stage1: MechanicalResult;
  readonly stage2: SemanticResult;
  readonly dispositions: readonly GapDecision[];
}

async function evolveLocked(input: EvolveInput, deps: EvolveDeps): Promise<EvolveResult> {
  const { root, vaultId } = input;
  const parent = await readStore(vaultId, root);
  if (parent.state !== "ok") throw new EvolveError("EVOLUTION_NO_CONTRACT", "the vault has no readable sealed contract to evolve; run `oms doctor contract`");
  const generation = await currentSequence(vaultId, root);
  if (typeof generation !== "number") throw new EvolveError("EVOLUTION_NO_CONTRACT", "the linked generation cannot be read; run `oms doctor contract`");
  const { tail } = await lineageTail(root, vaultId);
  const gaps = openGaps((await readGapLedger(root, vaultId)).events);
  const draft = draftEvolution({ parent: parent.contract, parentGeneration: generation, parentDigest: parent.digest, gaps });
  if (draft.mutations.length === 0) {
    throw new EvolveError("EVOLUTION_NO_MUTATIONS", `the maker drafted no change from ${gaps.length} open gap(s); nothing was issued`);
  }
  const anchor = await anchorContract(root, vaultId);
  const evaluated = await evaluateCandidate(
    { vault: input.vaultRealPath, parent: parent.contract, mutations: draft.mutations, ...(anchor === undefined ? {} : { anchor }) },
    { ...(deps.judge === undefined ? {} : { judge: deps.judge }), ...(deps.similarity === undefined ? {} : { similarity: deps.similarity }) },
  );
  if (evaluated.route === "reject" && !evaluated.stage2.passed && evaluated.stage1.passed) {
    const found = evaluated.stage2.reason === "drift"
      ? `drifts ${evaluated.stage2.drift.toFixed(2)} from the first sealed generation (limit 0.3)`
      : `overlaps in meaning: ${evaluated.stage2.overlaps.map(overlap => `${overlap.axis} ${overlap.keys.join(" ~ ")}`).join(", ")}`;
    throw new EvolveError("EVOLUTION_STAGE2_REFUSED", `the candidate ${found}; nothing was issued`);
  }
  if (evaluated.route === "reject") {
    throw new EvolveError("EVOLUTION_STAGE1_REFUSED", `the candidate would make the judge refuse ${evaluated.stage1.newRefusals} note(s) it accepts today; nothing was issued`);
  }
  const request = await createRequest(root, vaultId, {
    kind: "evolve",
    contract: evaluated.candidate,
    declined: await readDeclined(vaultId, root),
    mutations: draft.mutations,
    parent: tail,
    makerSessionId: input.makerSessionId,
    state: evaluated.route === "awaiting-human" ? "awaiting-human" : "open",
  }, deps);
  const applied = draft.dispositions.filter(decision => decision.disposition === "applied").map(decision => decision.gapId);
  return {
    request,
    evaluation: evaluationRequest(request, applied),
    route: evaluated.route,
    direction: evaluated.direction,
    stage1: evaluated.stage1,
    stage2: evaluated.stage2,
    dispositions: draft.dispositions,
  };
}

function assertMakerSession(makerSessionId: unknown): void {
  if (typeof makerSessionId !== "string" || makerSessionId.trim() === "") {
    throw new EvolveError("EVOLUTION_MAKER_SESSION_REQUIRED", "evolve needs the maker's session id (makerSessionId), so the maker can never evaluate its own candidate; nothing was issued");
  }
}

/** Drafts, evaluates and issues one request, holding the evolution lock. */
export async function evolve(input: EvolveInput, deps: EvolveDeps): Promise<EvolveResult> {
  assertMakerSession(input.makerSessionId);
  return withEvolutionLock(input.root, input.vaultId, () => evolveLocked(input, deps), { now: deps.now, ...deps.lockDeps });
}
