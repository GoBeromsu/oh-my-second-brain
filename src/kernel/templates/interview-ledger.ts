import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import { acquireTransactionLock, atomicWrite, releaseTransactionLock } from "./file-lock.js";
import { normalizeTemplateControlPath, verifyTemplateControlPath } from "./paths.js";
import type { Digest, JsonValue } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LEDGER_PATH = ".oms/template-interview.json";
const LOCK_PATH = ".oms/.template-transactions/interview/lock";
const DISPOSITIONS = new Set(["confirm", "defer", "unresolved"]);

/** One persisted answer. Anchors are server-observed; callers cannot replace them. */
export interface InterviewLedgerAnswer {
  readonly anchorDigest: Digest;
  readonly disposition: "confirm" | "defer" | "unresolved";
  readonly raw: string;
  readonly [key: string]: unknown;
}

/** User-owned interview answers and their server-observed census. */
export interface InterviewLedger {
  readonly version: 1;
  readonly censusDigest: Digest;
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly [key: string]: unknown;
}

/** A ledger snapshot; `digest:null` denotes an absent ledger. */
export interface InterviewLedgerRead {
  readonly ledger: InterviewLedger | null;
  readonly digest: Digest | null;
}

export interface InterviewLedgerDiagnostic {
  readonly code: "TEMPLATE_INTERVIEW_INVALID";
  readonly message: string;
}

export interface InterviewLedgerLockOptions {
  readonly expectedLedgerDigest: Digest | null;
  readonly expectedCensusDigest: Digest;
  readonly verifyCensus: () => Promise<Digest>;
}

export interface InterviewLedgerLockContext {
  readonly ledger: InterviewLedger | null;
  readonly ledgerDigest: Digest | null;
  readonly state: "absent" | "valid" | "invalid";
  readonly diagnostics: readonly InterviewLedgerDiagnostic[];
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
  readonly save: (ledger: InterviewLedger) => Promise<InterviewLedgerRead>;
}

function digest(value: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}

function errorWithCode(code: "TEMPLATE_INTERVIEW_INVALID" | "TEMPLATE_INTERVIEW_STALE", message: string): Error {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code });
  return error;
}

function invalid(message: string): never {
  throw errorWithCode("TEMPLATE_INTERVIEW_INVALID", message);
}

function stale(message: string): never {
  throw errorWithCode("TEMPLATE_INTERVIEW_STALE", message);
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (!record(value)) return false;
  return Object.values(value).every(jsonValue);
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST.test(value);
}

function validateLedger(value: unknown): value is InterviewLedger {
  if (!record(value) || value.version !== 1 || !isDigest(value.censusDigest) || !record(value.answers)) {
    return false;
  }
  if (!Object.values(value).every(jsonValue)) return false;
  for (const [questionId, answer] of Object.entries(value.answers)) {
    if (questionId.length === 0 || !record(answer)) return false;
    if (
      !isDigest(answer.anchorDigest)
      || typeof answer.raw !== "string"
      || typeof answer.disposition !== "string"
      || !DISPOSITIONS.has(answer.disposition)
    ) return false;
  }
  return true;
}

function parseLedger(bytes: Uint8Array): InterviewLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return invalid("ledger JSON is malformed");
  }
  if (!validateLedger(parsed)) return invalid("ledger schema is invalid");
  return parsed;
}

function serializedLedger(ledger: InterviewLedger): Uint8Array {
  if (!validateLedger(ledger)) return invalid("ledger schema is invalid");
  return encoder.encode(`${canonical(ledger)}\n`);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return invalid("ledger contains a non-JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!record(value)) return invalid("ledger contains a non-JSON value");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function readVerifiedLedger(absolutePath: string): Promise<InterviewLedgerRead> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(absolutePath));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ledger: null, digest: null };
    return invalid(`ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const contentDigest = digest(bytes);
  try {
    return { ledger: parseLedger(bytes), digest: contentDigest };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "TEMPLATE_INTERVIEW_INVALID") {
      Object.assign(error, {
        digest: contentDigest,
        diagnostics: [{ code: "TEMPLATE_INTERVIEW_INVALID", message: error.message }],
      });
    }
    throw error;
  }
}

interface LockedLedgerRead {
  readonly ledger: InterviewLedger | null;
  readonly digest: Digest | null;
  readonly state: "absent" | "valid" | "invalid";
  readonly diagnostics: readonly InterviewLedgerDiagnostic[];
  readonly answers: Readonly<Record<string, InterviewLedgerAnswer>>;
}

async function readLockedLedger(vault: string): Promise<LockedLedgerRead> {
  try {
    const current = await readInterviewLedger(vault);
    return {
      ...current,
      state: current.ledger === null ? "absent" : "valid",
      diagnostics: [],
      answers: current.ledger?.answers ?? {},
    };
  } catch (error: unknown) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "TEMPLATE_INTERVIEW_INVALID"
      || !("digest" in error)
      || !isDigest(error.digest)
    ) {
      throw error;
    }
    const diagnostics: readonly InterviewLedgerDiagnostic[] = "diagnostics" in error && Array.isArray(error.diagnostics)
      ? error.diagnostics.filter((item): item is InterviewLedgerDiagnostic =>
        record(item) && item.code === "TEMPLATE_INTERVIEW_INVALID" && typeof item.message === "string")
      : [{ code: "TEMPLATE_INTERVIEW_INVALID", message: error.message }];
    return { ledger: null, digest: error.digest, state: "invalid", diagnostics, answers: {} };
  }
}

/**
 * Reads the user-owned interview ledger without creating or modifying any
 * vault path. A missing control is represented by `{ ledger:null, digest:null }`.
 */
export async function readInterviewLedger(vault: string): Promise<InterviewLedgerRead> {
  const verified = await verifyTemplateControlPath(
    resolve(vault),
    normalizeTemplateControlPath(LEDGER_PATH),
    { expected: "either" },
  );
  if (verified.targetRealPath === null) return { ledger: null, digest: null };
  return readVerifiedLedger(verified.absolutePath);
}

interface VerifiedLedgerPaths {
  readonly vault: string;
  readonly ledger: string;
  readonly lockDirectory: string;
  readonly lock: string;
}

async function verifyWritePaths(target: WriteTarget): Promise<VerifiedLedgerPaths> {
  const admission = await admitWriteTarget(target);
  if (admission !== undefined) throw new Error(`${admission.code}: ${admission.remediation}`);
  const root = resolve(target.vault);
  const ledger = await verifyTemplateControlPath(
    root,
    normalizeTemplateControlPath(LEDGER_PATH),
    { expected: "either" },
  );
  const lock = await verifyTemplateControlPath(
    root,
    normalizeTemplateControlPath(LOCK_PATH),
    { expected: "either" },
  );
  return {
    vault: ledger.vaultRoot,
    ledger: ledger.absolutePath,
    lockDirectory: dirname(lock.absolutePath),
    lock: lock.absolutePath,
  };
}

function validDigestOption(value: unknown): value is Digest {
  return isDigest(value);
}

/**
 * Holds the interview lock for the entire callback. The callback receives the
 * freshly read ledger and a save operation that performs a census-verified CAS
 * while retaining the same lock through its return.
 */
export async function withInterviewLedgerLock<T>(
  target: WriteTarget,
  options: InterviewLedgerLockOptions,
  callback: (context: InterviewLedgerLockContext) => Promise<T>,
): Promise<T> {
  if (
    options === null
    || typeof options !== "object"
    || (options.expectedLedgerDigest !== null && !validDigestOption(options.expectedLedgerDigest))
    || !validDigestOption(options.expectedCensusDigest)
    || typeof options.verifyCensus !== "function"
  ) {
    throw new TypeError("Interview ledger lock options are invalid");
  }
  if (typeof callback !== "function") throw new TypeError("Interview ledger lock callback is required");

  const paths = await verifyWritePaths(target);
  // A refused answer must leave the vault exactly as it was, so directories
  // created only to hold the lock are removed again when nothing was published.
  const created: string[] = [];
  for (let directory = paths.lockDirectory; directory.startsWith(paths.vault) && directory !== paths.vault; directory = dirname(directory)) {
    if (!existsSync(directory)) created.push(directory);
  }
  let persisted = false;
  const token = await acquireTransactionLock(paths.lockDirectory, paths.lock);
  if (token === null) stale("the interview ledger is busy; re-read before retrying");

  try {
    const initial = await readLockedLedger(paths.vault);
    if (initial.digest !== options.expectedLedgerDigest) stale("the interview ledger changed; re-read before retrying");
    const currentCensusDigest = await options.verifyCensus();
    if (!validDigestOption(currentCensusDigest) || currentCensusDigest !== options.expectedCensusDigest) {
      stale("the template census changed; re-read before retrying");
    }

    let currentDigest = initial.digest;
    const save = async (nextLedger: InterviewLedger): Promise<InterviewLedgerRead> => {
      if (!validateLedger(nextLedger)) invalid("ledger schema is invalid");
      const observed = await readLockedLedger(paths.vault);
      if (observed.digest !== currentDigest) stale("the interview ledger changed; re-read before retrying");
      const verifiedCensusDigest = await options.verifyCensus();
      if (!validDigestOption(verifiedCensusDigest) || verifiedCensusDigest !== options.expectedCensusDigest) {
        stale("the template census changed; re-read before retrying");
      }
      if (nextLedger.censusDigest !== options.expectedCensusDigest) {
        stale("the answer census does not match the current census; re-read before retrying");
      }
      const bytes = serializedLedger(nextLedger);
      await atomicWrite(paths.ledger, bytes);
      persisted = true;
      currentDigest = digest(bytes);
      return { ledger: nextLedger, digest: currentDigest };
    };

    return await callback({
      ledger: initial.ledger,
      ledgerDigest: initial.digest,
      state: initial.state,
      diagnostics: initial.diagnostics,
      answers: initial.answers,
      save,
    });
  } finally {
    await releaseTransactionLock(paths.lock, token);
    if (!persisted) {
      // Deepest first. rmdir removes an empty directory only, so any vault
      // content that already existed stops the cleanup instead of being deleted.
      for (const directory of created) {
        await rmdir(directory).catch(() => undefined);
      }
    }
  }
}
