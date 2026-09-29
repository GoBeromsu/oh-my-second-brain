import { constants } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, existingStateDir, openStateFile } from "../contract/state-dir.js";

/**
 * The evolution journal: `<root>/.<id>.state/evolution/events.jsonl`, one JSON object per
 * line, appended with O_APPEND and fsynced. It records what the evolution loop decided and
 * why; the contract lineage (kernel/contract/lineage.ts) stays the record of what was sealed.
 * Reading never creates anything, so `doctor status` can count it read-only.
 */

export const EVOLUTION_EVENTS_FILE = "events.jsonl";
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;

export const EVOLUTION_EVENT_KINDS = [
  "request.issued",
  "request.expired",
  "request.retried",
  "request.awaiting-human",
  "request.rejected",
  "request.superseded",
  "verdict.received",
  "seal.autonomous",
  "seal.blocked-loosening",
  "seal.rate-limited",
  "seal.stalled",
  "seal.parent-moved",
  "seal.lock-stale",
  "seal.human-approved",
  "seal.human-rejected",
  "revert.proposed",
  "revert.source-unavailable",
  "lineage.gap-refused",
  "lineage.reanchored",
  "lineage.seq-restart",
  "lock.reclaimed",
] as const;
export type EvolutionEventKind = typeof EVOLUTION_EVENT_KINDS[number];
const KINDS: ReadonlySet<string> = new Set(EVOLUTION_EVENT_KINDS);

export interface EvolutionEvent {
  readonly kind: EvolutionEventKind;
  /** Milliseconds since the epoch, from the caller's clock. */
  readonly at: number;
  readonly requestId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function isEvolutionEventKind(value: unknown): value is EvolutionEventKind {
  return typeof value === "string" && KINDS.has(value);
}

export async function appendEvolutionEvent(root: string, vaultId: string, event: EvolutionEvent): Promise<void> {
  if (!isEvolutionEventKind(event.kind)) throw new TypeError(`EVOLUTION_EVENT_INVALID: unknown kind ${String(event.kind)}`);
  const directory = await ensureStateDir(root, vaultId, "evolution");
  const handle = await openStateFile(join(directory, EVOLUTION_EVENTS_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  if (handle === null) throw new Error(`EVOLUTION_EVENT_INVALID: ${directory} could not be opened`);
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface EvolutionEventsRead {
  readonly events: readonly EvolutionEvent[];
  /** 1-based line numbers that did not parse as an event; they are skipped, never fatal. */
  readonly skipped: readonly number[];
}

function parseEvent(line: string): EvolutionEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (!isEvolutionEventKind(event.kind) || typeof event.at !== "number") return null;
  if (event.requestId !== undefined && typeof event.requestId !== "string") return null;
  return event as unknown as EvolutionEvent;
}

/** Every readable event in append order; an absent journal reads as empty. */
export async function readEvolutionEvents(root: string, vaultId: string): Promise<EvolutionEventsRead> {
  const directory = await existingStateDir(root, vaultId, "evolution");
  if (directory === null) return { events: [], skipped: [] };
  const handle = await openStateFile(join(directory, EVOLUTION_EVENTS_FILE), constants.O_RDONLY);
  if (handle === null) return { events: [], skipped: [] };
  let text: string;
  try {
    if ((await handle.stat()).size > MAX_EVENTS_BYTES) throw new Error(`EVOLUTION_EVENTS_TOO_LARGE: the evolution journal exceeds ${MAX_EVENTS_BYTES} bytes`);
    text = (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
  const events: EvolutionEvent[] = [];
  const skipped: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const event = parseEvent(line);
    if (event === null) skipped.push(index + 1);
    else events.push(event);
  });
  return { events, skipped };
}

export type EvolutionCounters = Readonly<Record<EvolutionEventKind, number>>;

/** How many events of each kind the journal holds; read-only. */
export async function evolutionCounters(root: string, vaultId: string): Promise<EvolutionCounters> {
  const counters = Object.fromEntries(EVOLUTION_EVENT_KINDS.map(kind => [kind, 0])) as Record<EvolutionEventKind, number>;
  for (const event of (await readEvolutionEvents(root, vaultId)).events) counters[event.kind] += 1;
  return counters;
}
