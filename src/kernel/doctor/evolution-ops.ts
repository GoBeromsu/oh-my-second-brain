import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { StateDirUnsafe, existingStateDir } from "../contract/state-dir.js";
import { currentSequence, readStore } from "../contract/store.js";
import { resolveSealState } from "../contract/vault-id.js";
import type { HumanDecision } from "../evolution/decision.js";
import { evolutionCounters, type EvolutionEventKind } from "../evolution/events.js";
import { EVOLUTION_LOCK_FILE, reclaimEvolutionLock, type LockDeps } from "../evolution/evolution-lock.js";
import { evolve } from "../evolution/evolve.js";
import { lineageTail, readPinnedCandidate, readRequest, type RequestDeps } from "../evolution/request-state.js";
import { proposeRevert } from "../evolution/revert.js";
import type { SealGateDeps } from "../evolution/seal-gate.js";
import { recordVerdict, type VerdictSubmission } from "../evolution/stage-consensus.js";
import type { NoteJudge } from "../evolution/stage-mechanical.js";

/**
 * The evolution doctor ops (`evolve`, `evolve-verdict`, `revert-propose`,
 * `reclaim-evolution-lock`). Each runs on an admitted, verified vault target and checks
 * its postcondition before answering. Nothing here prompts: a terminal passes `human`,
 * MCP never does, so the owner-only op is refused there (EVOLUTION_RECLAIM_REQUIRES_TTY).
 */

export type EvolutionOperation = "evolve" | "evolve-verdict" | "revert-propose" | "reclaim-evolution-lock";
export const EVOLUTION_OPERATIONS: readonly EvolutionOperation[] = ["evolve", "evolve-verdict", "revert-propose", "reclaim-evolution-lock"];

export function isEvolutionOperation(operation: string): operation is EvolutionOperation {
  return (EVOLUTION_OPERATIONS as readonly string[]).includes(operation);
}

/** The owner at a terminal; only the CLI builds one. */
export interface DoctorHuman {
  readonly interactive: boolean;
  /** Runs with no lock held; shown what the owner is approving. */
  readonly confirm: (subject: Readonly<Record<string, unknown>>) => Promise<HumanDecision>;
}

/** Seams for racing a concurrent writer against a readback postcondition; production never sets them. */
export interface EvolutionOpsTestHooks {
  /** Runs after a verdict seals and before the readback postcondition. */
  readonly afterSeal?: () => Promise<void>;
  /** Runs after a revert is proposed and before its readback postconditions. */
  readonly afterPropose?: (requestId: string) => Promise<void>;
}

export interface EvolutionOpsDeps extends RequestDeps, EvolutionOpsTestHooks {
  readonly judge?: NoteJudge;
  readonly lockDeps?: Partial<LockDeps>;
  readonly sealDeps?: SealGateDeps["sealDeps"];
}

export type EvolutionOpResult =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "completed"; readonly value: Record<string, unknown> };

const DEFAULT_DEPS: EvolutionOpsDeps = { now: Date.now, newId: randomUUID, newToken: () => randomBytes(16).toString("hex") };

class EvolutionOpError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EvolutionOpError";
  }
}

/**
 * A failed server-side postcondition. After a seal it names the sealed generation, so the host
 * knows the contract already moved and must not retry the seal.
 */
function postcondition(holds: boolean, detail: string, sealed?: { readonly seq: number; readonly digest: string; readonly eventSeq: number }): void {
  if (holds) return;
  if (sealed === undefined) throw new EvolutionOpError("EVOLUTION_POSTCONDITION_FAILED", `${detail}`);
  throw new EvolutionOpError(
    "EVOLUTION_POSTCONDITION_FAILED_AFTER_SEAL",
    `${detail}; the seal happened (digest ${sealed.digest}, seq ${sealed.seq}, eventSeq ${sealed.eventSeq}) — run \`oms doctor contract\` before retrying`,
  );
}

function text(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new EvolutionOpError("EVOLUTION_ARGUMENT_INVALID", `${key} must be a non-empty string`);
  return value;
}

async function sealedVaultId(vault: string, root: string): Promise<string> {
  const state = await resolveSealState(vault, root);
  if (state.row !== "sealed" || state.vaultId === null) throw new EvolutionOpError("EVOLUTION_NO_CONTRACT", "the vault has no readable sealed contract here; run `oms doctor contract`");
  return state.vaultId;
}

async function linked(vaultId: string, root: string): Promise<{ readonly generation: unknown; readonly digest: string | null }> {
  const store = await readStore(vaultId, root);
  return { generation: await currentSequence(vaultId, root), digest: store.state === "ok" ? store.digest : null };
}

async function count(root: string, vaultId: string, kind: EvolutionEventKind): Promise<number> {
  return (await evolutionCounters(root, vaultId))[kind];
}

async function runEvolve(root: string, vaultId: string, vault: string, args: Record<string, unknown> | undefined, deps: EvolutionOpsDeps): Promise<Record<string, unknown>> {
  const makerSessionId = text(args, "makerSessionId");
  if (makerSessionId === undefined) {
    throw new EvolutionOpError("EVOLUTION_MAKER_SESSION_REQUIRED", "evolve needs the maker's session id (makerSessionId), so the maker can never evaluate its own candidate; nothing was issued");
  }
  const before = await linked(vaultId, root);
  const result = await evolve({ root, vaultId, vaultRealPath: vault, makerSessionId }, deps);
  const { request } = result;
  const stored = await readRequest(root, vaultId, request.requestId);
  postcondition(stored !== null && stored.state === request.state && (stored.state === "open" || stored.state === "awaiting-human"), "the issued request is not open or awaiting-human");
  postcondition((await readPinnedCandidate(root, vaultId, stored!)).digest === request.candidateDigest, "the pending candidate does not match its digest");
  const after = await linked(vaultId, root);
  postcondition(after.generation === before.generation && after.digest === before.digest, "the linked generation moved");
  return {
    op: "evolve", vaultId, requestId: request.requestId, nonce: request.nonce, expiresAt: request.expiresAt,
    candidateDigest: request.candidateDigest, parentDigest: request.expectedParentDigest, parentEventSeq: request.parentEventSeq,
    state: stored!.state, direction: result.direction, stage1: result.stage1, stage2: result.stage2, evaluation: result.evaluation,
  };
}

async function runVerdict(root: string, vaultId: string, vault: string, args: Record<string, unknown> | undefined, deps: EvolutionOpsDeps): Promise<Record<string, unknown>> {
  if (text(args, "requestId") === undefined || text(args, "slotToken") === undefined) {
    throw new EvolutionOpError("EVOLUTION_ARGUMENT_INVALID", "a verdict needs requestId and slotToken");
  }
  // Every other field is checked by the consensus stage, which journals a malformed verdict as discarded.
  const submission = args as unknown as VerdictSubmission;
  const receipt = await recordVerdict({ root, vaultId, vaultRealPath: vault }, submission, deps);
  const stored = await readRequest(root, vaultId, receipt.requestId);
  postcondition(stored !== null && stored.nonce === submission.nonce && stored.candidateDigest === submission.candidateDigest
    && stored.expectedParentDigest === submission.parentDigest && stored.slots[receipt.slot] === submission.slotToken, "the verdict does not bind to its request");
  postcondition(stored!.usedSlots.filter(token => token === submission.slotToken).length === 1, "the slot was not used exactly once");
  if (receipt.sealed !== undefined) {
    await deps.afterSeal?.();
    const store = await readStore(vaultId, root);
    postcondition(store.state === "ok" && store.digest === stored!.candidateDigest && receipt.sealed.digest === stored!.candidateDigest, "the linked digest is not the candidate", receipt.sealed);
    const { tail } = await lineageTail(root, vaultId);
    postcondition(tail.eventSeq === receipt.sealed.eventSeq && tail.digest === receipt.sealed.digest, "the lineage tail is not the sealed event", receipt.sealed);
  }
  return {
    op: "evolve-verdict", vaultId, requestId: receipt.requestId, slot: receipt.slot, accepted: receipt.accepted, quorum: receipt.quorum,
    ...(receipt.sealed === undefined ? {} : { sealed: receipt.sealed }),
    ...(receipt.gate === undefined ? {} : { gate: receipt.gate }),
  };
}

async function runRevert(root: string, vaultId: string, vault: string, args: Record<string, unknown> | undefined, deps: EvolutionOpsDeps): Promise<Record<string, unknown>> {
  const targetDigest = text(args, "targetDigest");
  if (targetDigest === undefined) throw new EvolutionOpError("EVOLUTION_ARGUMENT_INVALID", "revert-propose needs targetDigest");
  const before = await linked(vaultId, root);
  const proposal = await proposeRevert({ root, vaultId, vaultRealPath: vault, targetDigest }, deps);
  await deps.afterPropose?.(proposal.requestId);
  const stored = await readRequest(root, vaultId, proposal.requestId);
  postcondition(stored !== null && stored.state === "awaiting-human", "the revert request is not awaiting the owner");
  postcondition(proposal.candidateDigest === proposal.targetDigest && (await readPinnedCandidate(root, vaultId, stored!)).digest === proposal.candidateDigest, "the pending candidate is not the target");
  postcondition((await lineageTail(root, vaultId)).events.some(event => event.digest === proposal.targetDigest), "the target has no lineage event");
  const after = await linked(vaultId, root);
  postcondition(after.generation === before.generation && after.digest === before.digest, "the linked generation moved");
  return {
    op: "revert-propose", vaultId, requestId: proposal.requestId, targetDigest: proposal.targetDigest, candidateDigest: proposal.candidateDigest,
    parentDigest: proposal.parentDigest, parentEventSeq: proposal.parentEventSeq, direction: proposal.direction, state: proposal.state,
  };
}

async function lockPresent(root: string, vaultId: string): Promise<boolean> {
  const directory = await existingStateDir(root, vaultId, "evolution");
  if (directory === null) return false;
  try {
    await realpath(join(directory, EVOLUTION_LOCK_FILE));
    return true;
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

async function runReclaim(root: string, vaultId: string, human: DoctorHuman | undefined, deps: EvolutionOpsDeps): Promise<Record<string, unknown>> {
  const before = await count(root, vaultId, "lock.reclaimed");
  const result = await reclaimEvolutionLock(root, vaultId, {
    interactive: human?.interactive === true,
    confirm: owner => human!.confirm({ op: "reclaim-evolution-lock", owner }),
    deps: { now: deps.now, ...deps.lockDeps },
  });
  postcondition(!await lockPresent(root, vaultId), "the evolution lock is still present");
  postcondition(await count(root, vaultId, "lock.reclaimed") === before + (result.removed ? 1 : 0), "lock.reclaimed was not journalled exactly once");
  return { op: "reclaim-evolution-lock", vaultId, removedOwner: result.removedOwner, removed: result.removed, decision: result.decision };
}

function errorMessage(error: unknown): string | null {
  if (error instanceof StateDirUnsafe) return `STATE_DIR_UNSAFE: the contract store holds an unsafe entry (${error.kind}); it was left untouched`;
  if (error instanceof Error && /^(CONTRACT|EVOLUTION)_[A-Z_]+:/.test(error.message)) return error.message;
  return null;
}

/** Runs one evolution op on an admitted target; `vault` is the verified vault path. */
async function dispatch(
  operation: EvolutionOperation,
  root: string,
  vaultId: string,
  vault: string,
  args: Record<string, unknown> | undefined,
  human: DoctorHuman | undefined,
  deps: EvolutionOpsDeps,
): Promise<Record<string, unknown>> {
  switch (operation) {
    case "evolve": return runEvolve(root, vaultId, vault, args, deps);
    case "evolve-verdict": return runVerdict(root, vaultId, vault, args, deps);
    case "revert-propose": return runRevert(root, vaultId, vault, args, deps);
    case "reclaim-evolution-lock": return runReclaim(root, vaultId, human, deps);
  }
}

export async function runEvolutionOp(
  { operation, vault, root, args, human, deps = DEFAULT_DEPS }: {
    readonly operation: EvolutionOperation;
    readonly vault: string;
    readonly root: string;
    readonly args: Record<string, unknown> | undefined;
    readonly human?: DoctorHuman;
    readonly deps?: EvolutionOpsDeps;
  },
): Promise<EvolutionOpResult> {
  try {
    const vaultId = await sealedVaultId(vault, root);
    const vaultRealPath = await realpath(vault);
    return { kind: "completed", value: await dispatch(operation, root, vaultId, vaultRealPath, args, human, deps) };
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message === null) throw error;
    return { kind: "error", message };
  }
}
