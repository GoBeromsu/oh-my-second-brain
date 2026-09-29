import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { realpath, rename, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashCanonical } from "../conventions/canonical.js";
import type { Question } from "./interview.js";
import { checkStateFile, ensureStateDir, existingStateDir, openStateFile, stateDir } from "./state-dir.js";

/**
 * The interview's append-only event log, `<root>/.<key>.state/interview/events.jsonl`,
 * where the key is the vault id or, before the first seal, a pending key.
 * One JSON object per line, appended with O_APPEND and fsynced before the call returns.
 * A line that does not parse (a write cut short) is skipped and reported, never
 * truncated or rewritten; the next append starts on a fresh line after it.
 *
 * `seq` is one more than the highest sequence already in the file. Appends are
 * serialized within a process only; there is no cross-process lock, so two processes
 * appending at once may write the same `seq`. Readers take events in line order, but
 * `confirmedProposal` also compares `seq` to find a confirmation after a proposal, so
 * `seq` is only trusted within one writer's run.
 *
 * Known limits, accepted for an interview-sized log rather than designed away:
 * - every append reads and parses the whole file to find the next `seq`, so writing n
 *   events costs O(n^2);
 * - a log larger than MAX_LOG_BYTES (16 MiB) is refused with INTERVIEW_LOG_TOO_LARGE on
 *   read and append alike; nothing trims or rotates it;
 * - there is no cross-process lock, for appends or for `migrateInterviewLog`.
 */

export const INTERVIEW_EVENT_TYPES = ["asked", "answered", "proposed", "sealed", "abandoned"] as const;
export type InterviewEventType = typeof INTERVIEW_EVENT_TYPES[number];

export interface InterviewEvent {
  readonly seq: number;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly at: number;
  readonly type: InterviewEventType;
  readonly questionId: string | null;
  readonly questionDigest: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type InterviewEventInput = Omit<InterviewEvent, "seq" | "at">;

export interface InterviewLog {
  readonly events: readonly InterviewEvent[];
  /** 1-based line numbers that did not parse as an event; doctor reports them. */
  readonly corrupt: readonly number[];
}

export const EVENTS_FILE = "events.jsonl";

/**
 * The key a vault's interview is logged under before it has a vault id: derived from the
 * vault's real path, so every process finds the same log, and never written into the vault.
 */
export async function pendingLogKey(vault: string): Promise<string> {
  let path: string;
  try {
    path = await realpath(vault);
  } catch {
    path = resolve(vault);
  }
  return `pending-${createHash("sha256").update(path, "utf8").digest("hex")}`;
}
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const TYPES: ReadonlySet<string> = new Set(INTERVIEW_EVENT_TYPES);

/** What a question asks, so an answer recorded against an older wording is not replayed. */
export function questionDigest(question: Question): string {
  const base = { id: question.id, prompt: question.prompt, kind: question.kind };
  if (question.kind === "choice") return hashCanonical("oms-interview-question-v1", { ...base, options: question.options });
  if (question.kind === "confirm") return hashCanonical("oms-interview-question-v1", question.initial === undefined ? base : { ...base, initial: question.initial });
  return hashCanonical("oms-interview-question-v1", {
    ...base,
    ...(question.initial === undefined ? {} : { initial: question.initial }),
    ...(question.secret === true ? { secret: true } : {}),
  });
}

function parseEvent(line: string): InterviewEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const text = (key: string): boolean => event[key] === null || typeof event[key] === "string";
  if (!Number.isSafeInteger(event["seq"]) || (event["seq"] as number) < 1) return null;
  if (typeof event["at"] !== "number" || !Number.isFinite(event["at"])) return null;
  if (typeof event["type"] !== "string" || !TYPES.has(event["type"])) return null;
  if (!text("questionId") || !text("questionDigest")) return null;
  const payload = event["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return event as unknown as InterviewEvent;
}

function parseLog(text: string): InterviewLog & { readonly endsClean: boolean } {
  const events: InterviewEvent[] = [];
  const corrupt: number[] = [];
  const lines = text.split("\n");
  // A final newline leaves one empty element behind; anything else there is a cut-short line.
  const endsClean = lines.at(-1) === "";
  if (endsClean) lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const event = parseEvent(line);
    if (event === null) corrupt.push(index + 1);
    else events.push(event);
  }
  return { events, corrupt, endsClean };
}

async function readText(path: string): Promise<string> {
  const handle = await openStateFile(path, constants.O_RDONLY);
  if (handle === null) return "";
  try {
    const info = await handle.stat();
    if (info.size > MAX_LOG_BYTES) throw new Error(`INTERVIEW_LOG_TOO_LARGE: ${path} exceeds ${MAX_LOG_BYTES} bytes`);
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Every event in append order. An absent log or state directory reads as empty; nothing is created. */
export async function readInterviewLog(root: string, vaultId: string): Promise<InterviewLog> {
  const dir = await existingStateDir(root, vaultId);
  if (dir === null) return { events: [], corrupt: [] };
  const { events, corrupt } = parseLog(await readText(join(dir, EVENTS_FILE)));
  return { events, corrupt };
}

/** Appends run one at a time per log within this process, so each takes the next sequence number. */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/** Appends one event with the next sequence number and fsyncs it; returns the event written. */
export async function appendInterviewEvent(root: string, vaultId: string, input: InterviewEventInput, now: () => number = Date.now): Promise<InterviewEvent> {
  const dir = await ensureStateDir(root, vaultId, "interview");
  const path = join(dir, EVENTS_FILE);
  return serialize(path, async () => {
    const current = parseLog(await readText(path));
    const seq = current.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
    const event: InterviewEvent = {
      seq,
      at: now(),
      type: input.type,
      questionId: input.questionId,
      questionDigest: input.questionDigest,
      payload: input.payload,
    };
    // A cut-short last line keeps its bytes; the new event starts on the next line.
    const line = `${current.endsClean ? "" : "\n"}${JSON.stringify(event)}\n`;
    const handle = await openStateFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    if (handle === null) throw new Error(`INTERVIEW_LOG_UNWRITABLE: ${path} could not be opened`);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  });
}

/** An event as migration copies it: everything but `seq`, which the target renumbers. */
function copyKey(event: InterviewEvent): string {
  return JSON.stringify([event.at, event.type, event.questionId, event.questionDigest, event.payload]);
}

/**
 * How many leading `source` events already end `target`: a migration cut short after copying them.
 * Only a copy at the very end of `target` is recognised. That is enough: a cut-short move
 * leaves the pending log in place, and every later append under the vault id first runs the
 * move again (`interviewLogKey` migrates before it returns the key), so nothing is appended
 * after a partial copy before the copy is finished.
 */
export function copiedPrefix(target: readonly InterviewEvent[], source: readonly InterviewEvent[]): number {
  const targetKeys = target.map(copyKey);
  const sourceKeys = source.map(copyKey);
  for (let count = Math.min(targetKeys.length, sourceKeys.length); count > 0; count -= 1) {
    const tail = targetKeys.slice(targetKeys.length - count);
    if (tail.every((key, index) => key === sourceKeys[index])) return count;
  }
  return 0;
}

/**
 * Moves the log kept under `from` (a pending key) to `to` (the vault id issued at seal).
 * When `to` has no log yet the file is renamed as it is, corrupt lines included;
 * otherwise the parsed events of `from` are appended after its events with their original
 * times and the old file is removed. The emptied pending directories are removed when possible.
 * Nothing happens when `from` has no log.
 *
 * A retry after a crash between the appends and the removal does not copy an event twice:
 * the leading events of `from` that already end the `to` log are skipped.
 */
export async function migrateInterviewLog(root: string, from: string, to: string): Promise<void> {
  const sourceDir = await existingStateDir(root, from);
  if (sourceDir === null) return;
  const source = join(sourceDir, EVENTS_FILE);
  await serialize(source, async () => {
    if (!await checkStateFile(source)) return;
    const target = join(await ensureStateDir(root, to, "interview"), EVENTS_FILE);
    const renamed = await serialize(target, async () => {
      if (await checkStateFile(target)) return false;
      await rename(source, target);
      return true;
    });
    if (renamed) return;
    const { events } = parseLog(await readText(source));
    const copied = copiedPrefix(parseLog(await readText(target)).events, events);
    for (const event of events.slice(copied)) {
      const { type, questionId, questionDigest: digest, payload } = event;
      await appendInterviewEvent(root, to, { type, questionId, questionDigest: digest, payload }, () => event.at);
    }
    await rm(source, { force: true });
  });
  // Best effort: another writer may have started a new pending log meanwhile.
  await rmdir(sourceDir).catch(() => undefined);
  await rmdir(stateDir(root, from)).catch(() => undefined);
}
