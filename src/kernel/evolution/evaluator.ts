import { readLineage } from "../contract/lineage.js";
import { applyMutations, type Mutation } from "../contract/mutation.js";
import type { VaultContract } from "../contract/types.js";
import { classifyAll, type Direction } from "./mutation-direction.js";
import { readSnapshotContract } from "./snapshot-contract.js";
import { mechanicalStage, type MechanicalResult, type NoteJudge } from "./stage-mechanical.js";
import { semanticStage, type SemanticResult, type Similarity } from "./stage-semantic.js";

/**
 * The evaluator: stages 1 and 2 of the three-stage pipeline, plus the direction check.
 * It is read-only and runs without the writer's context — its input is the parent contract,
 * the maker's mutation list and the vault path. Stage 1 (no new refusals) and the direction
 * are the hard gates; the warning delta is the score and stage 2 is advisory. Stage 3 (the
 * host quorum) runs later against the request this result opens.
 */

export interface EvaluatorInput {
  /** The vault realpath whose notes stage 1 re-judges. */
  readonly vault: string;
  readonly parent: VaultContract;
  readonly mutations: readonly Mutation[];
  /** The first sealed generation, for drift; the parent when it cannot be read. */
  readonly anchor?: VaultContract;
}

export interface EvaluatorDeps {
  readonly judge?: NoteJudge;
  readonly similarity?: Similarity;
}

/**
 * Where the candidate goes next: `reject` when stage 1 finds a new refusal (nothing is
 * opened), `awaiting-human` when it loosens or raises warnings (it can never seal on the
 * quorum alone), otherwise `consensus`.
 */
export type EvaluationRoute = "reject" | "awaiting-human" | "consensus";

export interface Evaluation {
  readonly candidate: VaultContract;
  readonly stage1: MechanicalResult;
  readonly stage2: SemanticResult;
  readonly direction: Direction;
  readonly route: EvaluationRoute;
}

export function routeOf(stage1: MechanicalResult, direction: Direction): EvaluationRoute {
  if (!stage1.passed) return "reject";
  if (direction === "loosening" || stage1.warningDelta > 0) return "awaiting-human";
  return "consensus";
}

/** Evaluates a mutation list against its parent; a list that does not apply throws its MutationConflict. */
export async function evaluateCandidate(input: EvaluatorInput, deps: EvaluatorDeps = {}): Promise<Evaluation> {
  const candidate = applyMutations(input.parent, input.mutations);
  const stage1 = await mechanicalStage(input.vault, input.parent, candidate, deps.judge);
  const stage2 = semanticStage(input.anchor ?? input.parent, input.parent, candidate, deps.similarity === undefined ? {} : { similarity: deps.similarity });
  const direction = classifyAll(input.mutations, input.parent).direction;
  return { candidate, stage1, stage2, direction, route: routeOf(stage1, direction) };
}

/**
 * The drift anchor: the contract of the lineage's first event, read from its snapshot.
 * Undefined when the lineage is empty or that snapshot is missing or corrupt, so the
 * caller measures drift from the parent instead.
 */
export async function anchorContract(root: string, vaultId: string): Promise<VaultContract | undefined> {
  const first = (await readLineage(root, vaultId, "display")).events[0];
  if (first === undefined) return undefined;
  const read = await readSnapshotContract(root, vaultId, first.digest);
  return read.state === "ok" ? read.contract : undefined;
}
