import { realpath } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";

import { readStore } from "../kernel/contract/store.js";
import { resolveSealState } from "../kernel/contract/vault-id.js";
import type { DoctorHuman } from "../kernel/doctor/service.js";
import { isInteractive, runHumanSession, type HumanLine, type HumanPromptIO } from "../kernel/evolution/human-approval.js";
import { classifyAll } from "../kernel/evolution/mutation-direction.js";
import { PolicyRequiresTty, readPolicy, writePolicy, type EvolutionPolicy } from "../kernel/evolution/policy.js";
import { effectiveState, lineageTail, listRequests, type RequestRecord } from "../kernel/evolution/request-state.js";
import { approveInTerminal, type HumanPrompt } from "../kernel/evolution/seal-gate-human.js";
import type { SealGateDeps } from "../kernel/evolution/seal-gate.js";

/**
 * The owner's terminal for contract evolution. This is the only module that imports the
 * prompt (human-approval) and the human seal (seal-gate-human): a pending candidate is
 * sealed only by a person answering here, never by an MCP host. It shows each candidate's
 * changes, marks the loosening ones, and asks for an explicit approve.
 */

/** The prompt types, re-exported so other CLI modules never import human-approval directly. */
export type { HumanLine, HumanPromptIO };

export interface TerminalPrompt {
  readonly io: HumanPromptIO;
  readonly close: () => void;
}

/** A prompt on the process terminal. The line reader opens on the first read, so a non-interactive run never touches stdin. */
export function terminalPromptIO(
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TerminalPrompt {
  let rl: Interface | null = null;
  let closed = false;
  const reader = (): Interface => {
    if (rl === null) {
      rl = createInterface({ input, output });
      rl.on("close", () => { closed = true; });
    }
    return rl;
  };
  const io: HumanPromptIO = {
    isTTY: input.isTTY,
    env,
    write: text => { output.write(text); },
    readLine: signal => new Promise<HumanLine>(resolve => {
      if (closed) {
        resolve({ kind: "eof" });
        return;
      }
      const lines = reader();
      const finish = (line: HumanLine): void => {
        lines.off("line", onLine);
        lines.off("close", onClose);
        lines.off("SIGINT", onInterrupt);
        signal.removeEventListener("abort", onAbort);
        resolve(line);
      };
      const onLine = (text: string): void => finish({ kind: "line", text });
      const onClose = (): void => finish({ kind: "eof" });
      const onInterrupt = (): void => finish({ kind: "interrupted" });
      const onAbort = (): void => finish({ kind: "interrupted" });
      lines.on("line", onLine);
      lines.on("close", onClose);
      lines.on("SIGINT", onInterrupt);
      signal.addEventListener("abort", onAbort);
    }),
    wait: (ms, signal) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
  };
  return { io, close: () => { if (rl !== null && !closed) rl.close(); } };
}

/** The owner as the doctor ops see them: owner-only ops ask here. */
export function doctorHuman(io: HumanPromptIO): DoctorHuman {
  return {
    interactive: isInteractive(io),
    confirm: async subject => (await runHumanSession(io, `Confirm this owner-only repair:\n${JSON.stringify(subject, null, 2)}`)).decision,
  };
}

function describeCandidate(prompt: HumanPrompt, request: RequestRecord, loosening: readonly boolean[]): string {
  const lines = request.mutations.map((mutation, index) => {
    const mark = loosening[index] === true ? "LOOSENING " : "";
    return `  ${mark}${mutation.op} ${mutation.axis} ${mutation.key}: ${JSON.stringify(mutation.before ?? null)} -> ${JSON.stringify(mutation.after ?? null)}`;
  });
  return [
    `Pending contract ${prompt.kind === "revert" ? "revert" : "change"} ${prompt.requestId} (${prompt.direction}).`,
    `  parent    ${prompt.parentDigest}`,
    `  candidate ${prompt.candidateDigest}`,
    ...(prompt.revertOf === undefined ? [] : [`  reverts to ${prompt.revertOf}`]),
    ...lines,
    ...(prompt.direction === "loosening" ? ["Items marked LOOSENING let notes through that the sealed contract refuses today."] : []),
  ].join("\n");
}

export type PendingApproval =
  | { readonly requestId: string; readonly decision: "approve"; readonly outcome: string }
  | { readonly requestId: string; readonly decision: "reject"; readonly reason: string; readonly state: string }
  | { readonly requestId: string; readonly error: string };

/**
 * Walks the awaiting-human candidates of a sealed vault, oldest first, and asks the owner
 * about each. Nothing runs without an interactive terminal.
 */
export async function approvePendingCandidates(
  { vault, root, io, now, deps = {} }: {
    readonly vault: string;
    readonly root: string;
    readonly io: HumanPromptIO;
    readonly now: () => number;
    readonly deps?: Omit<SealGateDeps, "now">;
  },
): Promise<PendingApproval[]> {
  if (!isInteractive(io)) return [];
  const state = await resolveSealState(vault, root);
  if (state.row !== "sealed" || state.vaultId === null) return [];
  const vaultId = state.vaultId;
  const vaultRealPath = await realpath(vault);
  const { records } = await listRequests(root, vaultId);
  const { events } = await lineageTail(root, vaultId);
  const pending = records.filter(request => effectiveState(request, events, now()) === "awaiting-human");
  const results: PendingApproval[] = [];
  for (const request of pending) {
    try {
      const parent = await readStore(vaultId, root);
      const each = parent.state === "ok" ? classifyAll(request.mutations, parent.contract).each : [];
      const result = await approveInTerminal({ root, vaultId, vaultRealPath, requestId: request.requestId }, {
        ...deps,
        now,
        ask: prompt => runHumanSession(io, describeCandidate(prompt, request, each.map(direction => direction === "loosening"))),
      });
      results.push(result.decision === "approve"
        ? { requestId: request.requestId, decision: "approve", outcome: result.gate.outcome }
        : { requestId: request.requestId, decision: "reject", reason: result.reason, state: result.state });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !/^(CONTRACT|EVOLUTION)_[A-Z_]+:/.test(error.message)) throw error;
      results.push({ requestId: request.requestId, error: error.message });
    }
  }
  return results;
}

export type AutonomyResult =
  | { readonly status: "updated"; readonly policy: EvolutionPolicy }
  | { readonly status: "unchanged"; readonly reason: string; readonly policy: EvolutionPolicy };

/**
 * Turns autonomous evolution on or off for a sealed vault. On needs the owner at a
 * terminal and an explicit approve; off needs neither. Limits are kept as stored.
 */
export async function setAutonomy(
  { vault, root, io, enable }: { readonly vault: string; readonly root: string; readonly io: HumanPromptIO; readonly enable: boolean },
): Promise<AutonomyResult> {
  const state = await resolveSealState(vault, root);
  if (state.row !== "sealed" || state.vaultId === null) {
    throw new Error("EVOLUTION_NO_CONTRACT: the vault has no readable sealed contract here; run `oms setup` first");
  }
  const vaultId = state.vaultId;
  const current = (await readPolicy(root, vaultId)).policy;
  if (enable) {
    if (!isInteractive(io)) throw new PolicyRequiresTty();
    const answer = await runHumanSession(io, [
      "Turn on autonomous contract evolution for this vault?",
      `  At most ${current.limits.perDay} seal(s) per 24 hours and ${current.limits.perWeek} per 7 days, only for a candidate`,
      "  with no new refusals, no rise in warnings, and nothing loosened. Loosening still needs you here.",
    ].join("\n"));
    if (answer.decision === "reject") return { status: "unchanged", reason: answer.reason, policy: current };
  }
  const policy = await writePolicy(root, vaultId, { ...current, autonomous: enable }, { interactive: isInteractive(io) });
  return { status: "updated", policy };
}
