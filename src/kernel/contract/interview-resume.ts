import { readVaultSettings } from "../vault/settings.js";
import type { InterviewIO, InterviewRecord } from "./interview.js";
import { appendInterviewEvent, migrateInterviewLog, pendingLogKey, questionDigest, readInterviewLog, type InterviewEvent } from "./interview-log.js";
import { replayIO, type Answers, type ReplayDrift, type ReplayedAnswer } from "./scripted-interview.js";

/**
 * Continuing an interview from its event log. The run in progress is everything after
 * the last `sealed` or `abandoned` event; its `answered` events are replayed in order
 * (a later answer to the same question wins). The seal question and the stale-lock
 * question are never replayed: sealing is always a fresh decision.
 *
 * Until the first seal a vault has no id, and nothing is written into the vault before
 * the seal: the log is kept under a pending key derived from the vault's real path. Once
 * the seal has issued the id, the next write moves the pending log under the id.
 */

/** Questions whose logged answer is never replayed. */
export const LIVE_QUESTIONS: ReadonlySet<string> = new Set(["seal", "seal-lock:reclaim"]);

/** The events of the run in progress. */
export function currentRun(events: readonly InterviewEvent[]): readonly InterviewEvent[] {
  let start = 0;
  for (const [index, event] of events.entries()) {
    if (event.type === "sealed" || event.type === "abandoned") start = index + 1;
  }
  return events.slice(start);
}

export function pendingAnswers(events: readonly InterviewEvent[]): Map<string, ReplayedAnswer> {
  const out = new Map<string, ReplayedAnswer>();
  for (const event of currentRun(events)) {
    if (event.type !== "answered" || event.questionId === null || event.questionDigest === null) continue;
    if (LIVE_QUESTIONS.has(event.questionId)) continue;
    const answer = event.payload["answer"];
    if (typeof answer !== "string") continue;
    out.set(event.questionId, { questionDigest: event.questionDigest, answer });
  }
  return out;
}

/** The last `proposed` event of the run in progress. */
export function latestProposal(events: readonly InterviewEvent[]): InterviewEvent | null {
  return [...currentRun(events)].reverse().find(event => event.type === "proposed") ?? null;
}

/**
 * The proposal digest the owner confirmed: the latest proposal, when an `answered` seal
 * event after it has `confirm: true` and cites exactly that digest. Null otherwise.
 */
export function confirmedProposal(events: readonly InterviewEvent[]): string | null {
  const proposal = latestProposal(events);
  if (proposal === null) return null;
  const digest = proposal.payload["digest"];
  if (typeof digest !== "string") return null;
  const confirmed = currentRun(events).some(event =>
    event.seq > proposal.seq
    && event.type === "answered"
    && event.questionId === "seal"
    && event.payload["confirm"] === true
    && event.payload["proposed"] === digest);
  return confirmed ? digest : null;
}

/**
 * The key the next event is logged under: the vault id when the vault has one (a pending
 * log is moved under it first), otherwise the pending key. It never issues a vault id.
 */
export async function interviewLogKey(vault: string, root: string): Promise<string> {
  const pending = await pendingLogKey(vault);
  const vaultId = (await readVaultSettings(vault))?.vaultId ?? null;
  if (vaultId === null) return pending;
  await migrateInterviewLog(root, pending, vaultId);
  return vaultId;
}

/** Appends each interview record to the log as it happens. */
export function logRecorder(vault: string, root: string, now: () => number = Date.now): (event: InterviewRecord) => Promise<void> {
  return async event => {
    const key = await interviewLogKey(vault, root);
    switch (event.type) {
      case "asked":
        await appendInterviewEvent(root, key, {
          type: "asked",
          questionId: event.question.id,
          questionDigest: questionDigest(event.question),
          payload: {},
        }, now);
        return;
      case "answered":
        await appendInterviewEvent(root, key, {
          type: "answered",
          questionId: event.question.id,
          questionDigest: questionDigest(event.question),
          payload: { answer: event.answer },
        }, now);
        return;
      case "proposed":
        await appendInterviewEvent(root, key, {
          type: "proposed",
          questionId: null,
          questionDigest: null,
          payload: { digest: event.digest, removedTemplates: [...event.removedTemplates], baseSeq: event.baseSeq },
        }, now);
        return;
      case "sealed":
        await appendInterviewEvent(root, key, { type: "sealed", questionId: null, questionDigest: null, payload: { vaultId: event.vaultId } }, now);
        return;
    }
  };
}

/**
 * The logged events for a vault: its pending log (from before the first seal) followed by
 * the log under its vault id, if it has one. Nothing is created or moved.
 */
export async function vaultLog(vault: string, root: string): Promise<{ readonly vaultId: string | null; readonly events: readonly InterviewEvent[]; readonly corrupt: readonly number[] }> {
  let vaultId: string | null;
  try {
    vaultId = (await readVaultSettings(vault))?.vaultId ?? null;
  } catch {
    // Unreadable settings: the interview itself refuses, so there is nothing to continue.
    vaultId = null;
  }
  const pending = await readInterviewLog(root, await pendingLogKey(vault));
  if (vaultId === null) return { vaultId, ...pending };
  const own = await readInterviewLog(root, vaultId);
  if (pending.events.length === 0 && pending.corrupt.length === 0) return { vaultId, ...own };
  // A pending log not yet moved under the id is older than it; its sequence comes first.
  const offset = pending.events.reduce((max, event) => Math.max(max, event.seq), 0);
  return {
    vaultId,
    events: [...pending.events, ...own.events.map(event => ({ ...event, seq: event.seq + offset }))],
    corrupt: [...pending.corrupt, ...own.corrupt],
  };
}

export interface ResumedIO {
  readonly io: InterviewIO;
  readonly notes: readonly string[];
  /** Logged answers dropped because their question changed or was rejected; filled as the run asks. */
  readonly drift: readonly ReplayDrift[];
  /** Line numbers in the log that did not parse; they were skipped, not removed. */
  readonly corrupt: readonly number[];
  /** How many logged answers are offered for replay. */
  readonly pending: number;
}

/**
 * An IO that continues the logged interview: replayed answers first, then `answers`, then
 * `fallback`. With `restart`, an `abandoned` event closes the logged run and nothing is
 * replayed. With `record: false`, new answers are not logged (a read-only preview).
 */
export async function resumableIO(options: {
  readonly vault: string;
  readonly root: string;
  readonly fallback?: InterviewIO;
  readonly answers?: Answers;
  readonly now?: () => number;
  readonly restart?: boolean;
  readonly record?: boolean | ((event: InterviewRecord) => Promise<void>);
}): Promise<ResumedIO> {
  const now = options.now ?? Date.now;
  const log = await vaultLog(options.vault, options.root);
  let events = log.events;
  if (options.restart === true) {
    if (events.length > 0) {
      const key = await interviewLogKey(options.vault, options.root);
      await appendInterviewEvent(options.root, key, { type: "abandoned", questionId: null, questionDigest: null, payload: {} }, now);
    }
    events = [];
  }
  const replay = pendingAnswers(events);
  const record = typeof options.record === "function"
    ? options.record
    : options.record === false ? undefined : logRecorder(options.vault, options.root, now);
  const { io, notes, drift } = replayIO({
    replay,
    ...(options.answers === undefined ? {} : { answers: options.answers }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(record === undefined ? {} : { record }),
  });
  return { io, notes, drift, corrupt: log.corrupt, pending: replay.size };
}
