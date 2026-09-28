import { constants } from "node:fs";
import { join } from "node:path";
import type { Digest } from "../conventions/canonical.js";
import { isContractDigest, isDigest, NO_DIGEST, type ContractDigest } from "./digest.js";
import { ensureStateDir, existingStateDir, openStateFile } from "./state-dir.js";

/**
 * The contract lineage: `<root>/.<id>.state/lineage/events.jsonl`, one event per seal, in
 * seal order. Each `sealed` event names the digest it replaced (`parentDigest`) and the one
 * it installed (`digest`); both are manifest digests (see digest.ts), so every digest here
 * except "none" has a snapshot under `generations/`. Appended with O_APPEND and fsynced
 * under the seal lock, never rewritten.
 *
 * The chain rule: an event's parent is the previous event's digest ("none" before the
 * first). Anchors are `recovered` events that restart or repair the chain:
 *  - `bootstrap` (pre-lineage generations): parent "none" or a retained snapshot digest;
 *  - `seq-restart` (the `<id>` link was lost): parent and digest "none", `priorTail` the old tail;
 *  - `gap-anchor` (a seal happened that the chain cannot account for): parent "none", `gapFrom` the old tail;
 *  - `unrecorded-seal` (a seal crashed before its event): follows the chain like `sealed`.
 * This module is pure bookkeeping and must not import kernel/evolution.
 */

export const LINEAGE_FILE = "events.jsonl";
const MAX_LINEAGE_BYTES = 16 * 1024 * 1024;

export type LineageKind = "sealed" | "recovered";
export const RECOVERED_REASONS = ["bootstrap", "unrecorded-seal", "seq-restart", "gap-anchor"] as const;
export type RecoveredReason = typeof RECOVERED_REASONS[number];
const REASONS: ReadonlySet<string> = new Set(RECOVERED_REASONS);

export interface LineageEvent {
  readonly eventSeq: number;
  readonly kind: LineageKind;
  /** The store sequence of the generation `digest` names; null for a legacy directory or a "none" digest. */
  readonly generation: number | null;
  readonly parentDigest: ContractDigest;
  readonly digest: ContractDigest;
  /** Always empty until contract mutations are recorded. */
  readonly mutations: readonly unknown[];
  /** The manifest's file → digest map of `digest`; empty for "none". */
  readonly manifestDigests: Readonly<Record<string, Digest>>;
  readonly revertOf?: Digest;
  readonly proposer?: string;
  readonly evaluator?: string;
  readonly requestId?: string;
  readonly reason?: RecoveredReason;
  readonly priorTail?: ContractDigest;
  readonly gapFrom?: ContractDigest;
}

export type LineageDraft = Omit<LineageEvent, "eventSeq">;

export class LineageCorrupt extends Error {
  readonly code = "EVOLUTION_LINEAGE_CORRUPT";

  constructor(detail: string) {
    super(`EVOLUTION_LINEAGE_CORRUPT: ${detail}; the lineage was left untouched, run oms doctor contract`);
    this.name = "LineageCorrupt";
  }
}

export class LineageGap extends Error {
  readonly code = "CONTRACT_LINEAGE_GAP";
  readonly guidance = "oms doctor lineage-reanchor";

  constructor(readonly tailDigest: ContractDigest, readonly parentDigest: ContractDigest) {
    super(`CONTRACT_LINEAGE_GAP: the lineage ends at ${tailDigest} but the store holds ${parentDigest}; nothing was written. Run oms doctor lineage-reanchor, then seal again`);
    this.name = "LineageGap";
  }
}

export class LineageAppendFailed extends Error {
  readonly code = "CONTRACT_LINEAGE_APPEND_FAILED";

  constructor(readonly seq: number, readonly digest: Digest, cause: unknown) {
    super(`CONTRACT_LINEAGE_APPEND_FAILED: generation ${seq} (${digest}) is sealed but its lineage event was not recorded (${cause instanceof Error ? cause.message : String(cause)}); run oms doctor lineage-recover`, { cause });
    this.name = "LineageAppendFailed";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OPTIONAL_TEXT = ["proposer", "evaluator", "requestId"] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "eventSeq", "kind", "generation", "parentDigest", "digest", "mutations", "manifestDigests",
  "revertOf", "proposer", "evaluator", "requestId", "reason", "priorTail", "gapFrom",
]);

export function parseLineageEvent(line: string): LineageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record(value) || !Object.keys(value).every(key => KNOWN_KEYS.has(key))) return null;
  if (!Number.isSafeInteger(value["eventSeq"]) || (value["eventSeq"] as number) < 1) return null;
  const generation = value["generation"];
  if (generation !== null && (!Number.isSafeInteger(generation) || (generation as number) < 0)) return null;
  if (!isContractDigest(value["parentDigest"]) || !isContractDigest(value["digest"])) return null;
  if (!Array.isArray(value["mutations"])) return null;
  const manifest = value["manifestDigests"];
  if (!record(manifest) || !Object.values(manifest).every(isDigest)) return null;
  if (value["revertOf"] !== undefined && !isDigest(value["revertOf"])) return null;
  if (!OPTIONAL_TEXT.every(key => value[key] === undefined || typeof value[key] === "string")) return null;
  for (const key of ["priorTail", "gapFrom"]) if (value[key] !== undefined && !isContractDigest(value[key])) return null;
  if (value["kind"] === "sealed") {
    if (value["reason"] !== undefined || value["priorTail"] !== undefined || value["gapFrom"] !== undefined) return null;
  } else if (value["kind"] === "recovered") {
    if (typeof value["reason"] !== "string" || !REASONS.has(value["reason"])) return null;
  } else {
    return null;
  }
  return value as unknown as LineageEvent;
}

export interface LineageRead {
  readonly events: readonly LineageEvent[];
  /** 1-based lines, before the last, that do not parse. */
  readonly corrupt: readonly number[];
  /** The last line was cut short (no newline and does not parse); it is ignored. */
  readonly truncatedTail: boolean;
  readonly endsClean: boolean;
}

function parseLineage(text: string): LineageRead {
  const events: LineageEvent[] = [];
  const corrupt: number[] = [];
  const lines = text.split("\n");
  const endsClean = lines.at(-1) === "";
  if (endsClean) lines.pop();
  let truncatedTail = false;
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const event = parseLineageEvent(line);
    if (event !== null) events.push(event);
    else if (!endsClean && index === lines.length - 1) truncatedTail = true;
    else corrupt.push(index + 1);
  }
  return { events, corrupt, truncatedTail, endsClean };
}

async function readText(path: string): Promise<string> {
  const handle = await openStateFile(path, constants.O_RDONLY);
  if (handle === null) return "";
  try {
    const info = await handle.stat();
    if (info.size > MAX_LINEAGE_BYTES) throw new LineageCorrupt(`the lineage exceeds ${MAX_LINEAGE_BYTES} bytes`);
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * - `display`: everything readable, problems reported (doctor, status);
 * - `append`: a cut-short last line is ignored (a crashed append), any other bad line throws;
 * - `strict`: any bad line throws.
 */
export type LineageReadMode = "display" | "append" | "strict";

function enforce(read: LineageRead, mode: LineageReadMode): LineageRead {
  if (mode !== "display" && read.corrupt.length > 0) throw new LineageCorrupt(`line ${read.corrupt[0]} does not parse`);
  if (mode === "strict" && read.truncatedTail) throw new LineageCorrupt("the last line is cut short");
  return read;
}

/** The lineage in append order; absent reads as empty and nothing is created. */
export async function readLineage(root: string, vaultId: string, mode: LineageReadMode = "display"): Promise<LineageRead> {
  const directory = await existingStateDir(root, vaultId, "lineage");
  if (directory === null) return { events: [], corrupt: [], truncatedTail: false, endsClean: true };
  return enforce(parseLineage(await readText(join(directory, LINEAGE_FILE))), mode);
}

/** The digest the lineage ends at; "none" when it is empty. */
export function tailDigest(events: readonly LineageEvent[]): ContractDigest {
  return events.at(-1)?.digest ?? NO_DIGEST;
}

function isSeqRestart(event: LineageEvent | undefined): boolean {
  return event?.kind === "recovered" && event.reason === "seq-restart";
}

/**
 * Why `event` breaks the chain after `previous`, or null. `retained` holds the digests
 * with a kept snapshot, which a bootstrap anchor may name as its parent.
 */
export function chainViolation(previous: LineageEvent | undefined, event: LineageEvent, retained: ReadonlySet<string>): string | null {
  if (previous !== undefined && event.eventSeq <= previous.eventSeq) return `eventSeq ${event.eventSeq} does not increase`;
  const expected = previous?.digest ?? NO_DIGEST;
  if (event.kind === "sealed") {
    if (event.digest === NO_DIGEST) return `sealed event ${event.eventSeq} installs no digest`;
    return event.parentDigest === expected ? null : `sealed event ${event.eventSeq} does not follow ${expected}`;
  }
  switch (event.reason) {
    case "bootstrap":
      return event.parentDigest === NO_DIGEST || retained.has(event.parentDigest) ? null : `bootstrap anchor ${event.eventSeq} names a parent that is not retained`;
    case "seq-restart":
      return event.parentDigest === NO_DIGEST && event.digest === NO_DIGEST && (event.priorTail ?? NO_DIGEST) === expected ? null : `seq-restart anchor ${event.eventSeq} is malformed`;
    case "gap-anchor":
      return event.parentDigest === NO_DIGEST && event.digest !== NO_DIGEST && (event.gapFrom ?? NO_DIGEST) === expected ? null : `gap anchor ${event.eventSeq} is malformed`;
    default:
      return event.parentDigest === expected && event.digest !== NO_DIGEST ? null : `recovered event ${event.eventSeq} does not follow ${expected}`;
  }
}

/** Every chain violation, in order. */
export function chainViolations(events: readonly LineageEvent[], retained: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const [index, event] of events.entries()) {
    const violation = chainViolation(events[index - 1], event, retained);
    if (violation !== null) found.push(violation);
  }
  return found;
}

/** The seal's view of the store, read under the lock. */
export interface LineageTailInput {
  /** P: the linked generation's manifest digest, "none" when nothing readable is linked. */
  readonly parentDigest: ContractDigest;
  readonly parentGeneration: number | null;
  readonly parentManifest: Readonly<Record<string, Digest>>;
  /** The N-1 generation's digest when it is retained and reads intact, else null. */
  readonly previousDigest: Digest | null;
  /** Digests with a kept snapshot. */
  readonly retained: ReadonlySet<string>;
}

export type LineageGapPolicy = "refuse" | "reanchor";

export type LineageClassification =
  | { readonly outcome: "current" }
  | { readonly outcome: "seq-restart" | "unrecorded-seal" | "gap"; readonly anchor: LineageDraft };

/** Which of the four cases the lineage is in against the store; pure. */
export function classifyLineageTail(events: readonly LineageEvent[], input: LineageTailInput): LineageClassification {
  const tail = events.at(-1);
  const P = input.parentDigest;
  if (tail === undefined || tail.digest === P || (isSeqRestart(tail) && P === NO_DIGEST)) return { outcome: "current" };
  if (P === NO_DIGEST) {
    return {
      outcome: "seq-restart",
      anchor: { kind: "recovered", reason: "seq-restart", generation: null, parentDigest: NO_DIGEST, digest: NO_DIGEST, mutations: [], manifestDigests: {}, priorTail: tail.digest },
    };
  }
  const base = { kind: "recovered" as const, generation: input.parentGeneration, digest: P, mutations: [], manifestDigests: input.parentManifest };
  if (input.previousDigest !== null && tail.digest === input.previousDigest && chainViolation(events.at(-2), tail, input.retained) === null) {
    return { outcome: "unrecorded-seal", anchor: { ...base, reason: "unrecorded-seal", parentDigest: tail.digest } };
  }
  return { outcome: "gap", anchor: { ...base, reason: "gap-anchor", parentDigest: NO_DIGEST, gapFrom: tail.digest } };
}

export type LineagePlan =
  | { readonly action: "none"; readonly anchors: readonly []; readonly warnings: readonly [] }
  | { readonly action: "append"; readonly anchors: readonly LineageDraft[]; readonly warnings: readonly string[] }
  | { readonly action: "refuse"; readonly tailDigest: ContractDigest; readonly parentDigest: ContractDigest };

/**
 * What a seal must append before its own event so the chain reaches P. `refuse` accepts
 * only a lineage that already ends at P; `reanchor` repairs any gap with an anchor and a
 * `lineage-gap-reanchored` warning.
 */
export function planLineageTail(events: readonly LineageEvent[], input: LineageTailInput, gapPolicy: LineageGapPolicy): LineagePlan {
  const classified = classifyLineageTail(events, input);
  if (classified.outcome === "current") return { action: "none", anchors: [], warnings: [] };
  if (gapPolicy === "refuse") return { action: "refuse", tailDigest: tailDigest(events), parentDigest: input.parentDigest };
  return { action: "append", anchors: [classified.anchor], warnings: classified.outcome === "gap" ? ["lineage-gap-reanchored"] : [] };
}

/** Appends run one at a time per lineage within this process; the seal lock orders processes. */
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

export interface AppendOptions {
  /** The digest the lineage must end at before the append; a different tail throws EVOLUTION_LINEAGE_CORRUPT. */
  readonly expectTail?: ContractDigest;
}

/**
 * Appends drafts with consecutive eventSeq values after the highest one present, fsynced
 * as one write. Only the seal-lock holder calls this.
 */
export async function appendLineageEvents(root: string, vaultId: string, drafts: readonly LineageDraft[], options: AppendOptions = {}): Promise<LineageEvent[]> {
  if (drafts.length === 0) return [];
  const directory = await ensureStateDir(root, vaultId, "lineage");
  const path = join(directory, LINEAGE_FILE);
  return serialize(path, async () => {
    const raw = await readText(path);
    const current = enforce(parseLineage(raw), "append");
    if (options.expectTail !== undefined && tailDigest(current.events) !== options.expectTail) {
      throw new LineageCorrupt(`the lineage ends at ${tailDigest(current.events)}, not the planned ${options.expectTail}`);
    }
    let seq = current.events.reduce((max, event) => Math.max(max, event.eventSeq), 0);
    const events = drafts.map(draft => ({ eventSeq: (seq += 1), ...draft }));
    const body = events.map(event => `${JSON.stringify(event)}\n`).join("");
    // A cut-short last line never finished its append, so it is dropped rather than kept:
    // kept, it would sit mid-file and every later append-mode read would refuse it as corrupt.
    // A last line that parses but lacks its newline is kept and ended.
    const text = `${current.endsClean || current.truncatedTail ? "" : "\n"}${body}`;
    const handle = await openStateFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    if (handle === null) throw new LineageCorrupt(`${path} could not be opened`);
    try {
      if (current.truncatedTail) await handle.truncate(Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n") + 1)));
      await handle.write(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return events;
  });
}

/** What a seal installed, handed to `onSealed` while the seal lock is still held. */
export interface SealedGeneration {
  readonly root: string;
  readonly vaultId: string;
  readonly seq: number;
  readonly parentDigest: ContractDigest;
  readonly digest: Digest;
  readonly manifestDigests: Readonly<Record<string, Digest>>;
}

export interface LineageAttribution {
  readonly proposer: string;
  readonly evaluator: string;
  readonly requestId?: string;
}

export const HUMAN_CLI: LineageAttribution = { proposer: "human-cli", evaluator: "none" };

export function sealedDraft(sealed: SealedGeneration, attribution: LineageAttribution): LineageDraft {
  return {
    kind: "sealed",
    generation: sealed.seq,
    parentDigest: sealed.parentDigest,
    digest: sealed.digest,
    mutations: [],
    manifestDigests: sealed.manifestDigests,
    proposer: attribution.proposer,
    evaluator: attribution.evaluator,
    ...(attribution.requestId === undefined ? {} : { requestId: attribution.requestId }),
  };
}

/** An `onSealed` that records the `sealed` event, checking the lineage still ends at its parent. */
export function lineageAppender(attribution: LineageAttribution = HUMAN_CLI): (sealed: SealedGeneration) => Promise<void> {
  return async sealed => {
    await appendLineageEvents(sealed.root, sealed.vaultId, [sealedDraft(sealed, attribution)], { expectTail: sealed.parentDigest });
  };
}
