import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Digest } from "../conventions/canonical.js";
import { ensureStateDir, existingStateDir, openStateFile } from "./state-dir.js";
import type { JsonScalar } from "./types.js";

/**
 * The gap ledger: an append-only log, `<root>/.<id>.state/gaps/events.jsonl`, of every
 * place a write met the edge of the sealed contract. A `gap` event records a choice the
 * writer made inside the frame (`choice`) or a want the frame had no place for
 * (`no-fit`); a `resolved` event closes one. The ledger lives beside the store, never in
 * the vault, so the values it records stay out of agent-visible output; readers that face
 * an agent report `{field, kind}` only.
 *
 * Writing follows the interview log: one JSON object per line, appended with O_APPEND
 * and fsynced, a cut-short line skipped and reported but never rewritten, and appends
 * serialized within a process. The open gap set is a pure fold over the events, so
 * replaying the same events always gives the same set.
 */

export const GAP_AXES = ["folder", "property", "value", "template"] as const;
export type GapAxis = typeof GAP_AXES[number];
export const GAP_KINDS = ["no-fit", "choice"] as const;
export type GapKind = typeof GAP_KINDS[number];

/** What the writer wanted: the field it concerns and, when there was one, the value. */
export interface GapWant {
  readonly field: string;
  readonly value?: JsonScalar | readonly JsonScalar[];
}

export interface GapRecord {
  readonly id: string;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly at: number;
  readonly notePath: string;
  /** Revision of the content the gap was found in: the saved note, or the draft when nothing was saved. */
  readonly noteRevision: Digest;
  readonly contractRevision: Digest;
  readonly axis: GapAxis;
  readonly kind: GapKind;
  /** What was saved in the gap's place: the chosen option, or null when the want was dropped. */
  readonly chosen: string | null;
  readonly wanted: GapWant;
  readonly reason: string;
  /** Name of the draft kept in the ledger directory when nothing valid could be saved. */
  readonly draftRef?: string;
}

export type GapInput = Omit<GapRecord, "id" | "at">;

export type GapEvent =
  | ({ readonly type: "gap" } & GapRecord)
  | { readonly type: "resolved"; readonly id: string; readonly at: number; readonly reason: string };

export interface GapLedger {
  readonly events: readonly GapEvent[];
  /** 1-based line numbers that did not parse as an event. */
  readonly corrupt: readonly number[];
}

export interface GapLedgerDeps {
  readonly now: () => number;
  readonly newId: () => string;
}

export const GAP_EVENTS_FILE = "events.jsonl";
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const AXES: ReadonlySet<string> = new Set(GAP_AXES);
const KINDS: ReadonlySet<string> = new Set(GAP_KINDS);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DRAFT_REF = /^draft-[0-9a-f-]{36}\.md$/;

function defaults(deps: Partial<GapLedgerDeps>): GapLedgerDeps {
  return { now: Date.now, newId: randomUUID, ...deps };
}

function scalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function parseWant(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const want = value as Record<string, unknown>;
  if (typeof want["field"] !== "string") return false;
  return !Object.hasOwn(want, "value") || scalar(want["value"]) || Array.isArray(want["value"]) && want["value"].every(scalar);
}

function parseEvent(line: string): GapEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event["id"] !== "string" || event["id"] === "") return null;
  if (typeof event["at"] !== "number" || !Number.isFinite(event["at"])) return null;
  if (event["type"] === "resolved") return typeof event["reason"] === "string" ? event as unknown as GapEvent : null;
  if (event["type"] !== "gap") return null;
  if (typeof event["notePath"] !== "string" || typeof event["reason"] !== "string") return null;
  if (typeof event["noteRevision"] !== "string" || !DIGEST.test(event["noteRevision"])) return null;
  if (typeof event["contractRevision"] !== "string" || !DIGEST.test(event["contractRevision"])) return null;
  if (typeof event["axis"] !== "string" || !AXES.has(event["axis"])) return null;
  if (typeof event["kind"] !== "string" || !KINDS.has(event["kind"])) return null;
  if (event["chosen"] !== null && typeof event["chosen"] !== "string") return null;
  if (!parseWant(event["wanted"])) return null;
  if (Object.hasOwn(event, "draftRef") && (typeof event["draftRef"] !== "string" || !DRAFT_REF.test(event["draftRef"]))) return null;
  return event as unknown as GapEvent;
}

function parseLedger(text: string): GapLedger & { readonly endsClean: boolean } {
  const events: GapEvent[] = [];
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
    if (info.size > MAX_LEDGER_BYTES) throw new Error(`GAP_LEDGER_TOO_LARGE: ${path} exceeds ${MAX_LEDGER_BYTES} bytes`);
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Every event in append order. An absent ledger or state directory reads as empty; nothing is created. */
export async function readGapLedger(root: string, vaultId: string): Promise<GapLedger> {
  const dir = await existingStateDir(root, vaultId, "gaps");
  if (dir === null) return { events: [], corrupt: [] };
  const { events, corrupt } = parseLedger(await readText(join(dir, GAP_EVENTS_FILE)));
  return { events, corrupt };
}

/**
 * The gaps still open after `events`, in the order they were first recorded. A gap id
 * recorded twice keeps its latest record; a `resolved` event closes the id for good.
 */
export function openGaps(events: readonly GapEvent[]): readonly GapRecord[] {
  const open = new Map<string, GapRecord>();
  const closed = new Set<string>();
  for (const event of events) {
    if (event.type === "resolved") {
      closed.add(event.id);
      open.delete(event.id);
      continue;
    }
    if (closed.has(event.id)) continue;
    const { type: _type, ...record } = event;
    open.set(event.id, record);
  }
  return [...open.values()];
}

/** Appends run one at a time per ledger within this process. */
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

async function appendEvents(root: string, vaultId: string, events: readonly GapEvent[]): Promise<void> {
  if (events.length === 0) return;
  const path = join(await ensureStateDir(root, vaultId, "gaps"), GAP_EVENTS_FILE);
  await serialize(path, async () => {
    const current = parseLedger(await readText(path));
    // A cut-short last line keeps its bytes; the new events start on the next line.
    const text = `${current.endsClean ? "" : "\n"}${events.map(event => `${JSON.stringify(event)}\n`).join("")}`;
    const handle = await openStateFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    if (handle === null) throw new Error(`GAP_LEDGER_UNWRITABLE: ${path} could not be opened`);
    try {
      await handle.write(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/** Records `gaps` in one fsynced append and returns them with their ids and time. */
export async function recordGaps(root: string, vaultId: string, gaps: readonly GapInput[], overrides: Partial<GapLedgerDeps> = {}): Promise<readonly GapRecord[]> {
  const deps = defaults(overrides);
  const at = deps.now();
  const records = gaps.map(gap => ({ id: deps.newId(), at, ...gap }));
  await appendEvents(root, vaultId, records.map(record => ({ type: "gap" as const, ...record })));
  return records;
}

/** Closes the gap `id`; resolving an unknown or already closed id is harmless. */
export async function resolveGap(root: string, vaultId: string, id: string, reason: string, overrides: Partial<GapLedgerDeps> = {}): Promise<void> {
  const deps = defaults(overrides);
  await appendEvents(root, vaultId, [{ type: "resolved", id, at: deps.now(), reason }]);
}

/**
 * Keeps `content` that could not be saved as a draft file beside the ledger (0600, never
 * in the vault) and returns its name, the `draftRef` gaps point at.
 */
export async function writeGapDraft(root: string, vaultId: string, content: string, overrides: Partial<GapLedgerDeps> = {}): Promise<string> {
  const deps = defaults(overrides);
  const draftRef = `draft-${deps.newId()}.md`;
  if (!DRAFT_REF.test(draftRef)) throw new TypeError("GAP_DRAFT_ID_INVALID: a draft id must be a UUID");
  const path = join(await ensureStateDir(root, vaultId, "gaps"), draftRef);
  const handle = await openStateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  if (handle === null) throw new Error(`GAP_DRAFT_UNWRITABLE: ${path} could not be opened`);
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return draftRef;
}

/** Reads a draft back by its ref; null when the ref is malformed or the draft is gone. */
export async function readGapDraft(root: string, vaultId: string, draftRef: string): Promise<string | null> {
  if (!DRAFT_REF.test(draftRef)) return null;
  const dir = await existingStateDir(root, vaultId, "gaps");
  if (dir === null) return null;
  const handle = await openStateFile(join(dir, draftRef), constants.O_RDONLY);
  if (handle === null) return null;
  try {
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}
