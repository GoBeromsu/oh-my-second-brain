import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { compareCodePoints, type Digest } from "../conventions/canonical.js";
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
 *
 * The ledger never refuses an append for its size. A read keeps only the newest
 * `maxBytes` (16 MiB by default) and says so with `truncated`; gaps recorded before that
 * window are no longer reported. To start over, move `events.jsonl` aside (for example to
 * `events.<date>.jsonl`): the next append creates a fresh ledger, and the old file stays
 * readable as plain JSON lines.
 *
 * A ② choice is recorded once per note, set of candidates and contract revision. Its id
 * is derived from that key, and a `<id>.seen` marker beside the ledger keeps a repeated
 * identical write from appending it again, so a resolved choice stays closed until the
 * contract or the candidates change.
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
  /** Present when the ledger outgrew the read window and only its newest events were read. */
  readonly truncated?: true;
}

export interface GapLedgerReadOptions {
  /** How many of the ledger's newest bytes a read keeps; older events are skipped. */
  readonly maxBytes?: number;
}

export interface GapLedgerDeps {
  readonly now: () => number;
  readonly newId: () => string;
}

export const GAP_EVENTS_FILE = "events.jsonl";
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
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

function parseLedger(text: string): GapLedger {
  const events: GapEvent[] = [];
  const corrupt: number[] = [];
  // A final newline leaves one empty element behind; a cut-short last line is reported corrupt.
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const event = parseEvent(line);
    if (event === null) corrupt.push(index + 1);
    else events.push(event);
  }
  return { events, corrupt };
}

/** Newlines in the first `end` bytes, counted a chunk at a time so memory stays bounded. */
async function countLines(handle: FileHandle, end: number): Promise<number> {
  const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, end));
  let lines = 0;
  for (let position = 0; position < end;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (bytesRead === 0) break;
    for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === NEWLINE) lines += 1;
    position += bytesRead;
  }
  return lines;
}

/**
 * Every event in append order. An absent ledger or state directory reads as empty; nothing
 * is created. A ledger larger than `maxBytes` is read from its newest `maxBytes` only,
 * starting at the first whole line, and comes back `truncated`; corrupt line numbers stay
 * counted from the start of the file.
 */
export async function readGapLedger(root: string, vaultId: string, options: GapLedgerReadOptions = {}): Promise<GapLedger> {
  const maxBytes = options.maxBytes ?? MAX_LEDGER_BYTES;
  const dir = await existingStateDir(root, vaultId, "gaps");
  if (dir === null) return { events: [], corrupt: [] };
  const handle = await openStateFile(join(dir, GAP_EVENTS_FILE), constants.O_RDONLY);
  if (handle === null) return { events: [], corrupt: [] };
  try {
    const { size } = await handle.stat();
    if (size <= maxBytes) {
      const { events, corrupt } = parseLedger((await handle.readFile()).toString("utf8"));
      return { events, corrupt };
    }
    // One byte before the window is read too, so a window opening exactly on a line keeps it.
    const start = size - maxBytes - 1;
    const window = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(window, 0, window.length, start);
    // The window may open mid-line; that partial line is skipped with everything before it.
    const cut = window.subarray(0, bytesRead).indexOf(NEWLINE) + 1;
    const skippedLines = cut === 0 ? 0 : await countLines(handle, start + cut);
    const text = cut === 0 ? "" : window.subarray(cut, bytesRead).toString("utf8");
    const { events, corrupt } = parseLedger(text);
    return { events, corrupt: corrupt.map(line => line + skippedLines), truncated: true };
  } finally {
    await handle.close();
  }
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

/** A ② choice is recorded once per key; see the module comment. */
function recordedOnce(event: GapEvent): boolean {
  return event.type === "gap" && event.kind === "choice";
}

function seenMarker(dir: string, id: string): string {
  return join(dir, `${id}.seen`);
}

async function markerExists(path: string): Promise<boolean> {
  const handle = await openStateFile(path, constants.O_RDONLY);
  if (handle === null) return false;
  await handle.close();
  return true;
}

async function writeMarker(path: string): Promise<void> {
  try {
    const handle = await openStateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await handle?.close();
  } catch (error) {
    // Another append marked the same choice first; the fold keeps one record per id.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function appendEvents(root: string, vaultId: string, events: readonly GapEvent[]): Promise<void> {
  if (events.length === 0) return;
  const dir = await ensureStateDir(root, vaultId, "gaps");
  const path = join(dir, GAP_EVENTS_FILE);
  await serialize(path, async () => {
    const pending: GapEvent[] = [];
    for (const event of events) {
      if (!recordedOnce(event) || !await markerExists(seenMarker(dir, event.id))) pending.push(event);
    }
    if (pending.length === 0) return;
    const handle = await openStateFile(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT);
    if (handle === null) throw new Error(`GAP_LEDGER_UNWRITABLE: ${path} could not be opened`);
    try {
      // Only the last byte decides whether a cut-short line needs closing, whatever the ledger's size.
      const { size } = await handle.stat();
      const last = Buffer.alloc(1);
      const endsClean = size === 0 || (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] === NEWLINE;
      // A cut-short last line keeps its bytes; the new events start on the next line.
      await handle.write(`${endsClean ? "" : "\n"}${pending.map(event => `${JSON.stringify(event)}\n`).join("")}`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The marker follows the append, so a failed append never hides a choice from the next write.
    for (const event of pending) if (recordedOnce(event)) await writeMarker(seenMarker(dir, event.id));
  });
}

/** The stable id of a ② choice: its note, its sorted candidates and the contract revision. */
export function choiceGapId(gap: Pick<GapInput, "notePath" | "wanted" | "contractRevision">): string {
  const candidates = Array.isArray(gap.wanted.value) ? gap.wanted.value.map(String).sort(compareCodePoints) : [];
  const key = JSON.stringify([gap.notePath, candidates, gap.contractRevision]);
  return `choice-${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Records `gaps` in one fsynced append and returns them with their ids and time. A ②
 * choice takes its stable id and is appended only the first time it is seen.
 */
export async function recordGaps(root: string, vaultId: string, gaps: readonly GapInput[], overrides: Partial<GapLedgerDeps> = {}): Promise<readonly GapRecord[]> {
  const deps = defaults(overrides);
  const at = deps.now();
  const records = gaps.map(gap => ({ id: gap.kind === "choice" ? choiceGapId(gap) : deps.newId(), at, ...gap }));
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
