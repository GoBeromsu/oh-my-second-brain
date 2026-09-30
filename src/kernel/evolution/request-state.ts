import { constants } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Digest } from "../conventions/canonical.js";
import { isContractDigest, isDigest, type ContractDigest } from "../contract/digest.js";
import { writePrivate } from "../contract/fs-private.js";
import { readVerifiedDirectory } from "../contract/generation-snapshot.js";
import { readLineage, tailDigest, type LineageEvent } from "../contract/lineage.js";
import type { Mutation } from "../contract/mutation.js";
import { checkStateFile, ensureStateDir, existingStateDir, openStateFile, StateDirUnsafe } from "../contract/state-dir.js";
import { candidateManifest, NO_DECLINED, readContractDirectory, type DeclinedSet } from "../contract/store.js";
import type { VaultContract } from "../contract/types.js";
import { appendEvolutionEvent } from "./events.js";

/**
 * Evolution requests: `<root>/.<id>.state/evolution/pending/<requestId>/` holds
 * `state.json` and `candidate/`, the pinned bytes of the candidate generation (the files a
 * seal would write plus their manifest). The seal-gate seals exactly those bytes.
 *
 * States: open → awaiting-human | sealed | expired; awaiting-human → sealed | rejected.
 * `superseded` is derived from the lineage and only cached in state.json. Terminal states
 * are sealed, superseded, expired and rejected; awaiting-human has no TTL.
 *
 * The effective state is read in this order:
 *   1. a lineage `sealed` event with this requestId → sealed;
 *   2. the event right after the parent (eventSeq parentEventSeq+1) sealed this candidate
 *      digest (with this requestId when it names one), or recovered it as an unrecorded
 *      seal this request attempted → sealed;
 *   3. a persisted terminal state stands;
 *   4. open at or past expiresAt → expired;
 *   5. the lineage tail moved (eventSeq or digest) → superseded;
 *   6. otherwise the persisted state.
 * Comparing the tail eventSeq, not only its digest, keeps A→B→A from reviving a request.
 */

export const REQUEST_TTL_MS = 15 * 60_000;
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;
export const PENDING_DIR = "pending";
export const STATE_FILE = "state.json";
export const CANDIDATE_DIR = "candidate";
export const QUORUM = 3;
const MAX_STATE_BYTES = 1024 * 1024;

export const REQUEST_STATES = ["open", "awaiting-human", "sealed", "superseded", "expired", "rejected"] as const;
export type RequestState = typeof REQUEST_STATES[number];
export const TERMINAL_STATES: ReadonlySet<RequestState> = new Set(["sealed", "superseded", "expired", "rejected"]);
export type RequestKind = "evolve" | "revert";
export type SealMode = "autonomous" | "human";

const TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  "open": ["awaiting-human", "sealed", "expired", "superseded"],
  "awaiting-human": ["sealed", "rejected", "superseded"],
  "sealed": [],
  "superseded": [],
  "expired": [],
  "rejected": [],
};

/** Written before the seal is attempted, so an unrecorded seal can be attributed later. */
export interface SealAttempt {
  readonly requestId: string;
  readonly parentEventSeq: number;
  readonly candidateDigest: Digest;
  readonly mode: SealMode;
  /** When the attempt was written; the rate limit falls back to it for an unrecorded seal. */
  readonly at?: number;
}

export interface VerdictRecord {
  readonly slot: number;
  readonly evaluatorSessionId: string;
  readonly verdict: "approve" | "reject";
  readonly rubricScores: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
  readonly at: number;
}

export interface RequestRecord {
  readonly version: 1;
  readonly requestId: string;
  readonly kind: RequestKind;
  readonly state: RequestState;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly parentEventSeq: number;
  readonly expectedParentDigest: ContractDigest;
  readonly candidateDigest: Digest;
  readonly mutations: readonly Mutation[];
  readonly revertOf?: Digest;
  readonly makerSessionId?: string;
  readonly slots: readonly string[];
  readonly usedSlots: readonly string[];
  readonly verdicts: readonly VerdictRecord[];
  readonly sealAttempt?: SealAttempt;
  readonly rejectReason?: string;
}

class RequestError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RequestError";
  }
}

export class RequestClosed extends Error {
  readonly code = "EVOLUTION_REQUEST_CLOSED";

  constructor(readonly requestId: string, readonly state: RequestState) {
    super(`EVOLUTION_REQUEST_CLOSED: request ${requestId} is ${state}; start a new one`);
    this.name = "RequestClosed";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is RequestState {
  return typeof value === "string" && (REQUEST_STATES as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isVerdict(value: unknown): value is VerdictRecord {
  if (!record(value)) return false;
  return isCount(value.slot) && typeof value.evaluatorSessionId === "string" && (value.verdict === "approve" || value.verdict === "reject")
    && record(value.rubricScores) && Object.values(value.rubricScores).every(score => typeof score === "number")
    && isStringArray(value.reasons) && isCount(value.at);
}

function isSealAttempt(value: unknown): value is SealAttempt {
  return record(value) && typeof value.requestId === "string" && isCount(value.parentEventSeq) && isDigest(value.candidateDigest)
    && (value.mode === "autonomous" || value.mode === "human") && (value.at === undefined || isCount(value.at));
}

function parseRecord(value: unknown, requestId: string): RequestRecord | null {
  if (!record(value) || value.version !== 1 || value.requestId !== requestId) return null;
  if (value.kind !== "evolve" && value.kind !== "revert") return null;
  if (!isState(value.state) || typeof value.nonce !== "string" || !isCount(value.issuedAt) || !isCount(value.expiresAt)) return null;
  if (!isCount(value.parentEventSeq) || !isContractDigest(value.expectedParentDigest) || !isDigest(value.candidateDigest)) return null;
  if (!Array.isArray(value.mutations) || !isStringArray(value.slots) || !isStringArray(value.usedSlots)) return null;
  if (!Array.isArray(value.verdicts) || !value.verdicts.every(isVerdict)) return null;
  if (value.revertOf !== undefined && !isDigest(value.revertOf)) return null;
  if (value.makerSessionId !== undefined && typeof value.makerSessionId !== "string") return null;
  if (value.sealAttempt !== undefined && !isSealAttempt(value.sealAttempt)) return null;
  if (value.rejectReason !== undefined && typeof value.rejectReason !== "string") return null;
  if (value.kind === "revert" && value.revertOf === undefined) return null;
  return value as unknown as RequestRecord;
}

/** Refuses an existing entry that is not a real directory; true when it exists. */
async function checkDirectory(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new StateDirUnsafe(path, "symlink");
  if (!info.isDirectory()) throw new StateDirUnsafe(path, info.isFile() ? "file" : "other");
  return true;
}

function requirePattern(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new RequestError("EVOLUTION_REQUEST_UNKNOWN", `${JSON.stringify(requestId)} is not a request id`);
}

/** `pending/<requestId>` when both levels exist as real directories; null otherwise. */
async function existingRequestDir(root: string, vaultId: string, requestId: string): Promise<string | null> {
  requirePattern(requestId);
  const evolution = await existingStateDir(root, vaultId, "evolution");
  if (evolution === null) return null;
  const pending = join(evolution, PENDING_DIR);
  if (!await checkDirectory(pending)) return null;
  const directory = join(pending, requestId);
  return await checkDirectory(directory) ? directory : null;
}

export interface LineageTail {
  /** The last event's eventSeq; 0 for an empty lineage. */
  readonly eventSeq: number;
  readonly digest: ContractDigest;
}

export function tailOf(events: readonly LineageEvent[]): LineageTail {
  return { eventSeq: events.at(-1)?.eventSeq ?? 0, digest: tailDigest(events) };
}

/** The lineage tail as the seal-gate sees it (append mode: a truncated tail is ignored). */
export async function lineageTail(root: string, vaultId: string): Promise<{ readonly tail: LineageTail; readonly events: readonly LineageEvent[] }> {
  const read = await readLineage(root, vaultId, "append");
  return { tail: tailOf(read.events), events: read.events };
}

export interface RequestDeps {
  readonly now: () => number;
  /** A lowercase UUID. */
  readonly newId: () => string;
  /** 32–128 lowercase hex characters. */
  readonly newToken: () => string;
}

export interface NewRequest {
  readonly kind: RequestKind;
  readonly contract: VaultContract;
  readonly declined?: DeclinedSet;
  readonly mutations: readonly Mutation[];
  readonly parent: LineageTail;
  readonly revertOf?: Digest;
  readonly makerSessionId?: string;
  readonly state?: "open" | "awaiting-human";
}

async function writeCandidate(directory: string, files: ReadonlyMap<string, string>, manifestText: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  for (const [path, content] of files) {
    const target = join(directory, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600, flag: "wx" });
  }
  await writeFile(join(directory, "manifest.json"), manifestText, { mode: 0o600, flag: "wx" });
}

/**
 * Issues a request: pins the candidate bytes, writes state.json last and records
 * `request.issued`. The caller holds the evolution lock and read `parent` under it.
 */
export async function createRequest(root: string, vaultId: string, input: NewRequest, deps: RequestDeps): Promise<RequestRecord> {
  if (input.kind === "revert" && input.revertOf === undefined) throw new RequestError("EVOLUTION_REQUEST_INVALID", "a revert request names the digest it restores");
  const requestId = deps.newId();
  requirePattern(requestId);
  const tokens = [deps.newToken(), ...Array.from({ length: QUORUM }, () => deps.newToken())];
  if (!tokens.every(token => TOKEN_PATTERN.test(token)) || new Set(tokens).size !== tokens.length) {
    throw new RequestError("EVOLUTION_REQUEST_INVALID", "the nonce and slot tokens must be distinct hex strings");
  }
  const [nonce, ...slots] = tokens as [string, ...string[]];
  const candidate = candidateManifest(input.contract, input.declined ?? NO_DECLINED);
  const evolution = await ensureStateDir(root, vaultId, "evolution");
  const pending = join(evolution, PENDING_DIR);
  if (!await checkDirectory(pending)) await mkdir(pending, { mode: 0o700 });
  const directory = join(pending, requestId);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") throw new RequestError("EVOLUTION_REQUEST_INVALID", `request ${requestId} already exists`);
    throw error;
  }
  await writeCandidate(join(directory, CANDIDATE_DIR), candidate.files, candidate.manifestText);
  const issuedAt = deps.now();
  const created: RequestRecord = {
    version: 1,
    requestId,
    kind: input.kind,
    state: input.state ?? "open",
    nonce,
    issuedAt,
    expiresAt: issuedAt + REQUEST_TTL_MS,
    parentEventSeq: input.parent.eventSeq,
    expectedParentDigest: input.parent.digest,
    candidateDigest: candidate.digest,
    mutations: input.mutations,
    ...(input.revertOf === undefined ? {} : { revertOf: input.revertOf }),
    ...(input.makerSessionId === undefined ? {} : { makerSessionId: input.makerSessionId }),
    slots,
    usedSlots: [],
    verdicts: [],
  };
  await writeRequest(root, vaultId, created);
  await appendEvolutionEvent(root, vaultId, { kind: "request.issued", at: issuedAt, requestId, detail: { kind: input.kind, candidateDigest: candidate.digest, parentDigest: input.parent.digest, parentEventSeq: input.parent.eventSeq, state: created.state } });
  if (created.state === "awaiting-human") await appendEvolutionEvent(root, vaultId, { kind: "request.awaiting-human", at: issuedAt, requestId, detail: { reason: "issued" } });
  return created;
}

/** The stored request; null when absent. A malformed state.json is EVOLUTION_REQUEST_INVALID. */
export async function readRequest(root: string, vaultId: string, requestId: string): Promise<RequestRecord | null> {
  const directory = await existingRequestDir(root, vaultId, requestId);
  if (directory === null) return null;
  const handle = await openStateFile(join(directory, STATE_FILE), constants.O_RDONLY);
  if (handle === null) return null;
  let text: string;
  try {
    if ((await handle.stat()).size > MAX_STATE_BYTES) throw new RequestError("EVOLUTION_REQUEST_INVALID", `request ${requestId} state is too large`);
    text = (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError("EVOLUTION_REQUEST_INVALID", `request ${requestId} state is not JSON`);
  }
  const parsed = parseRecord(value, requestId);
  if (parsed === null) throw new RequestError("EVOLUTION_REQUEST_INVALID", `request ${requestId} state does not match the request schema`);
  return parsed;
}

/** Replaces state.json atomically (0600). The request directory must already exist. */
export async function writeRequest(root: string, vaultId: string, request: RequestRecord): Promise<void> {
  const directory = await existingRequestDir(root, vaultId, request.requestId);
  if (directory === null) throw new RequestError("EVOLUTION_REQUEST_UNKNOWN", `request ${request.requestId} does not exist`);
  const path = join(directory, STATE_FILE);
  await checkStateFile(path);
  await writePrivate(path, `${JSON.stringify(request, null, 2)}\n`);
}

export interface RequestListing {
  readonly records: readonly RequestRecord[];
  /** Entries under pending/ that are not a readable request, with the reason. */
  readonly invalid: readonly { readonly name: string; readonly reason: string }[];
}

/** Every request, oldest first; reading creates nothing. */
export async function listRequests(root: string, vaultId: string): Promise<RequestListing> {
  const evolution = await existingStateDir(root, vaultId, "evolution");
  if (evolution === null) return { records: [], invalid: [] };
  const pending = join(evolution, PENDING_DIR);
  if (!await checkDirectory(pending)) return { records: [], invalid: [] };
  const records: RequestRecord[] = [];
  const invalid: { name: string; reason: string }[] = [];
  for (const name of (await readdir(pending)).sort()) {
    if (!REQUEST_ID_PATTERN.test(name)) {
      invalid.push({ name, reason: "not a request id" });
      continue;
    }
    try {
      const read = await readRequest(root, vaultId, name);
      if (read === null) invalid.push({ name, reason: "no state.json" });
      else records.push(read);
    } catch (error: unknown) {
      invalid.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  records.sort((left, right) => left.issuedAt - right.issuedAt || (left.requestId < right.requestId ? -1 : 1));
  return { records, invalid };
}

/** The record moved to `to`; a terminal record is RequestClosed, any other disallowed move is invalid. */
export function transition(request: RequestRecord, to: RequestState, extra: Partial<Pick<RequestRecord, "rejectReason" | "sealAttempt">> = {}): RequestRecord {
  if (TERMINAL_STATES.has(request.state)) throw new RequestClosed(request.requestId, request.state);
  if (!TRANSITIONS[request.state].includes(to)) {
    throw new RequestError("EVOLUTION_REQUEST_TRANSITION_INVALID", `request ${request.requestId} cannot move from ${request.state} to ${to}`);
  }
  return { ...request, ...extra, state: to };
}

function sealedThis(request: RequestRecord, event: LineageEvent): boolean {
  if (event.digest !== request.candidateDigest) return false;
  if (event.kind === "sealed") return event.requestId === undefined || event.requestId === request.requestId;
  // An unrecorded seal recovered later: ours only when this request attempted exactly that seal.
  return event.reason === "unrecorded-seal"
    && request.sealAttempt?.parentEventSeq === request.parentEventSeq
    && request.sealAttempt.candidateDigest === request.candidateDigest;
}

/** The state the request is in given the lineage and the clock; see the module comment. */
export function effectiveState(request: RequestRecord, events: readonly LineageEvent[], now: number): RequestState {
  if (events.some(event => event.kind === "sealed" && event.requestId === request.requestId)) return "sealed";
  const next = events.find(event => event.eventSeq === request.parentEventSeq + 1);
  if (next !== undefined && sealedThis(request, next)) return "sealed";
  if (TERMINAL_STATES.has(request.state)) return request.state;
  if (request.state === "open" && now >= request.expiresAt) return "expired";
  const tail = tailOf(events);
  if (tail.eventSeq !== request.parentEventSeq || tail.digest !== request.expectedParentDigest) return "superseded";
  return request.state;
}

/**
 * Persists a derived terminal state (sealed, expired or superseded) and records it; the
 * caller holds the evolution lock. Returns the record as stored.
 */
export async function settleRequest(root: string, vaultId: string, request: RequestRecord, events: readonly LineageEvent[], now: number): Promise<RequestRecord> {
  const state = effectiveState(request, events, now);
  if (state === request.state) return request;
  const settled: RequestRecord = { ...request, state };
  await writeRequest(root, vaultId, settled);
  if (state === "expired") await appendEvolutionEvent(root, vaultId, { kind: "request.expired", at: now, requestId: request.requestId, detail: { expiresAt: request.expiresAt } });
  if (state === "superseded") {
    const tail = tailOf(events);
    await appendEvolutionEvent(root, vaultId, { kind: "request.superseded", at: now, requestId: request.requestId, detail: { parentEventSeq: request.parentEventSeq, tailEventSeq: tail.eventSeq, tailDigest: tail.digest } });
  }
  return settled;
}

/** Refuses (RequestClosed) unless the effective state is one of `allowed`. */
export function assertActive(request: RequestRecord, events: readonly LineageEvent[], now: number, allowed: readonly RequestState[]): RequestState {
  const state = effectiveState(request, events, now);
  if (!allowed.includes(state)) throw new RequestClosed(request.requestId, state);
  return state;
}

export interface PinnedCandidate {
  readonly contract: VaultContract;
  readonly declined: DeclinedSet;
  readonly digest: Digest;
}

/**
 * The pinned candidate, verified three ways: the directory matches its own manifest and
 * the request's digest, it reads as a current (not legacy) contract, and sealing that
 * contract would produce the same digest. Anything else is EVOLUTION_CANDIDATE_MISMATCH.
 */
export async function readPinnedCandidate(root: string, vaultId: string, request: RequestRecord): Promise<PinnedCandidate> {
  const directory = await existingRequestDir(root, vaultId, request.requestId);
  if (directory === null) throw new RequestError("EVOLUTION_REQUEST_UNKNOWN", `request ${request.requestId} does not exist`);
  const candidate = join(directory, CANDIDATE_DIR);
  if (!await checkDirectory(candidate)) throw new RequestError("EVOLUTION_CANDIDATE_MISMATCH", `request ${request.requestId} has no pinned candidate`);
  const verified = await readVerifiedDirectory(candidate, request.candidateDigest);
  if (verified.state !== "ok") throw new RequestError("EVOLUTION_CANDIDATE_MISMATCH", `the pinned candidate of request ${request.requestId} is ${verified.state === "missing" ? "missing" : "altered"}`);
  const read = await readContractDirectory(candidate);
  if (read.state !== "ok" || read.legacy !== undefined) throw new RequestError("EVOLUTION_CANDIDATE_MISMATCH", `the pinned candidate of request ${request.requestId} is not a current contract`);
  if (candidateManifest(read.contract, read.declined).digest !== request.candidateDigest) {
    throw new RequestError("EVOLUTION_CANDIDATE_MISMATCH", `the pinned candidate of request ${request.requestId} does not reproduce its digest`);
  }
  return { contract: read.contract, declined: read.declined, digest: request.candidateDigest };
}

