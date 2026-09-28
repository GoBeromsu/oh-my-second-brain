import { constants } from "node:fs";
import { join } from "node:path";
import { hashCanonical } from "../conventions/canonical.js";
import type { Question } from "./interview.js";
import { ensureStateDir, existingStateDir, openStateFile } from "./state-dir.js";

/**
 * The interview's append-only event log, `<root>/.<id>.state/interview/events.jsonl`.
 * One JSON object per line, appended with O_APPEND and fsynced before the call returns.
 * A line that does not parse (a write cut short) is skipped and reported, never
 * truncated or rewritten; the next append starts on a fresh line after it.
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

/** Appends run one at a time per log in this process, so each takes the next sequence number. */
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
