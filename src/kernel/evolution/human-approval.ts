import type { HumanRejectReason, HumanSessionOutcome } from "./decision.js";

/**
 * The owner's terminal session for an evolution request, with every input injected: the
 * CLI supplies the real terminal, tests supply scripted lines and a fake clock. This module
 * only turns what the owner typed (or did not type) into an outcome; it seals nothing.
 *
 * Only `approve`, `y` and `yes` approve. `reject`, `n` and `no` are an explicit reject; an
 * empty line, anything else, or a parser failure is `unknown-input`. No terminal
 * (`isTTY !== true` or `OMS_NON_INTERACTIVE=1`) never prompts and is `non-tty`. No answer
 * within ten minutes is `timeout`; closed input is `eof`; Ctrl-C is `interrupted`.
 */

export type { HumanRejectReason, HumanSessionOutcome } from "./decision.js";

export const HUMAN_PROMPT_TIMEOUT_MS = 10 * 60_000;

/** What one read from the terminal produced. */
export type HumanLine =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "eof" }
  | { readonly kind: "interrupted" };

export interface HumanPromptIO {
  readonly isTTY: boolean | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: (text: string) => void;
  /** Reads one line; it stops reading when `signal` aborts. A rejection counts as interrupted. */
  readonly readLine: (signal: AbortSignal) => Promise<HumanLine>;
  /** Resolves after `ms` on the injected clock, or never once `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The answer parser; replaceable only so a parser failure can be exercised. */
  readonly parse?: (text: string) => HumanSessionOutcome;
}

const APPROVE: ReadonlySet<string> = new Set(["approve", "y", "yes"]);
const REJECT: ReadonlySet<string> = new Set(["reject", "n", "no"]);

export function parseHumanAnswer(text: string): HumanSessionOutcome {
  const answer = text.trim().toLowerCase();
  if (APPROVE.has(answer)) return { decision: "approve" };
  if (REJECT.has(answer)) return { decision: "reject", reason: "explicit" };
  return { decision: "reject", reason: "unknown-input" };
}

export function isInteractive(io: Pick<HumanPromptIO, "isTTY" | "env">): boolean {
  return io.isTTY === true && io.env.OMS_NON_INTERACTIVE !== "1";
}

const reject = (reason: HumanRejectReason): HumanSessionOutcome => ({ decision: "reject", reason });

/** Shows `question`, then waits at most ten minutes for one answer. */
export async function runHumanSession(io: HumanPromptIO, question: string): Promise<HumanSessionOutcome> {
  if (!isInteractive(io)) return reject("non-tty");
  io.write(`${question}\nType approve (y/yes) to seal, or reject (n/no): `);
  const stop = new AbortController();
  const timeout = io.wait(HUMAN_PROMPT_TIMEOUT_MS, stop.signal).then((): HumanLine | "timeout" => "timeout");
  const read = io.readLine(stop.signal).catch((): HumanLine => ({ kind: "interrupted" }));
  const first = await Promise.race([read, timeout]);
  stop.abort();
  if (first === "timeout") return reject("timeout");
  if (first.kind !== "line") return reject(first.kind);
  try {
    return (io.parse ?? parseHumanAnswer)(first.text);
  } catch {
    return reject("unknown-input");
  }
}
