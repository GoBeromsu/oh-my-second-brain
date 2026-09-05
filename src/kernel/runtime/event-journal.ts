import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  RuntimeLedgerError,
  type RuntimeEvent,
  type RuntimeEventAppendResult,
  type RuntimeEventInput,
  type RuntimeIdentityInput,
  type RuntimeInvocation,
  type RuntimeInvocationInput,
  type RuntimeLedgerOptions,
} from "./event-types.js";

const DATABASE_NAME = "events.sqlite";
const DATABASE_AUXILIARIES = [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`, `${DATABASE_NAME}-journal`] as const;

interface LedgerLocation {
  readonly databasePath: string;
  readonly directory: string;
  readonly hostId: string;
  readonly vaultFingerprint: string;
}

interface EventRow {
  readonly event_id: string;
  readonly invocation_id: string;
  readonly attempt_n: number;
  readonly transaction_id: string | null;
  readonly event_time: string | null;
  readonly observed_at: string;
  readonly registered_at: string;
  readonly kind: string;
  readonly outcome: string;
  readonly changed_between_from: string | null;
  readonly changed_between_to: string | null;
  readonly vault_fingerprint: string;
  readonly host_id: string;
  readonly surface: string;
  readonly operation: string;
  readonly template_id: string | null;
  readonly note_path: string | null;
  readonly input_signature: string | null;
  readonly template_signature: string | null;
  readonly package_version: string | null;
  readonly git_commit: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  attempt_n INTEGER NOT NULL CHECK (attempt_n >= 1),
  transaction_id TEXT,
  event_time TEXT,
  observed_at TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'rejected', 'unchanged', 'observation-gap')),
  changed_between_from TEXT,
  changed_between_to TEXT,
  vault_fingerprint TEXT NOT NULL,
  host_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  template_id TEXT,
  note_path TEXT,
  input_signature TEXT,
  template_signature TEXT,
  package_version TEXT,
  git_commit TEXT
);
CREATE INDEX IF NOT EXISTS runtime_events_invocation_attempt
  ON runtime_events (invocation_id, attempt_n);
CREATE INDEX IF NOT EXISTS runtime_events_identity_history
  ON runtime_events (host_id, vault_fingerprint, registered_at, event_id);
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(input?: RuntimeIdentityInput): { readonly hostId: string } {
  const username = input?.username ?? userInfo().username;
  const machineHostname = input?.hostname ?? hostname();
  return { hostId: sha256(`${username}\0${machineHostname}`).slice(0, 32) };
}

function nearestRealPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  const suffix: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`no existing ancestor for ${candidate}`);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    return path.resolve(realpathSync(cursor), ...suffix);
  }
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertExternal(vaultRealPath: string, candidate: string): void {
  const resolvedCandidate = nearestRealPath(candidate);
  if (contains(vaultRealPath, resolvedCandidate)) {
    throw new RuntimeLedgerError("LEDGER_ROOT_INSIDE_VAULT", `${candidate} resolves inside the vault`);
  }
}

function assertSafeExistingFile(candidate: string, vaultRealPath: string): void {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (link.isSymbolicLink()) throw new Error(`${candidate} must not be a symbolic link`);
  const file = statSync(candidate);
  if (!file.isFile()) throw new Error(`${candidate} must be a regular file`);
  if (file.nlink !== 1) throw new Error(`${candidate} must not be hard-linked`);
  if (contains(vaultRealPath, realpathSync(candidate))) throw new Error(`${candidate} resolves inside the vault`);
}

function assertSafeDatabaseFiles(directory: string, vaultRealPath: string): void {
  for (const name of DATABASE_AUXILIARIES) assertSafeExistingFile(path.join(directory, name), vaultRealPath);
}

function baseRuntimeRoot(explicitRoot?: string): string {
  return explicitRoot ?? process.env.OMS_RUNTIME_ROOT ?? path.join(homedir(), ".oms", "runtime", "v1");
}

export function resolveRuntimeLedgerLocation(options: RuntimeLedgerOptions, create: boolean): LedgerLocation | null {
  const vaultRealPath = realpathSync(options.vaultPath);
  const { hostId } = identity(options.identity);
  const directory = path.join(path.resolve(baseRuntimeRoot(options.runtimeRoot)), hostId);
  assertExternal(vaultRealPath, directory);
  if (!existsSync(directory)) {
    if (!create) return null;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const directoryLink = lstatSync(directory);
  if (directoryLink.isSymbolicLink() || !directoryLink.isDirectory()) throw new Error(`${directory} must be a real directory`);
  const directoryRealPath = realpathSync(directory);
  if (contains(vaultRealPath, directoryRealPath)) {
    throw new RuntimeLedgerError("LEDGER_ROOT_INSIDE_VAULT", `${directory} resolves inside the vault`);
  }
  assertSafeDatabaseFiles(directoryRealPath, vaultRealPath);
  return {
    databasePath: path.join(directoryRealPath, DATABASE_NAME),
    directory: directoryRealPath,
    hostId,
    vaultFingerprint: sha256(vaultRealPath),
  };
}

export function createRuntimeInvocation(input: RuntimeInvocationInput): RuntimeInvocation {
  if (input.surface.length === 0 || input.operation.length === 0) throw new TypeError("surface and operation must be non-empty");
  return {
    invocationId: randomUUID(),
    observedAt: new Date().toISOString(),
    surface: input.surface,
    operation: input.operation,
    packageVersion: input.packageVersion ?? null,
    gitCommit: input.gitCommit ?? null,
  };
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function assertVaultRelative(notePath: string | null): void {
  if (notePath === null) return;
  const normalized = notePath.replaceAll("\\", "/");
  if (
    normalized.length === 0
    || normalized.includes("\0")
    || path.posix.isAbsolute(normalized)
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.startsWith("//")
    || normalized.split("/").includes("..")
  ) {
    throw new TypeError("notePath must be a non-empty vault-relative path");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OUTCOMES = new Set(["success", "failure", "rejected", "unchanged", "observation-gap"]);

function assertString(value: unknown, field: string, nullable = false): asserts value is string | null {
  if ((nullable && value === null) || (typeof value === "string" && value.length > 0 && !value.includes("\0"))) return;
  throw new TypeError(`${field} must be ${nullable ? "null or " : ""}a non-empty string without NUL bytes`);
}

function assertTimestamp(value: unknown, field: string): asserts value is string | null {
  if (value === null) return;
  assertString(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be null or a valid timestamp`);
}

function assertDigest(value: unknown, field: string): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${field} must be null or a sha256 digest`);
}

function validateRuntimeEvent(event: RuntimeEvent): void {
  assertString(event.eventId, "eventId");
  assertString(event.invocationId, "invocationId");
  if (!UUID.test(event.eventId) || !UUID.test(event.invocationId)) throw new TypeError("eventId and invocationId must be UUIDs");
  if (!Number.isSafeInteger(event.attemptN) || event.attemptN < 1) throw new TypeError("attemptN must be a positive integer");
  assertString(event.transactionId, "transactionId", true);
  assertTimestamp(event.eventTime, "eventTime");
  assertTimestamp(event.observedAt, "observedAt");
  assertTimestamp(event.changedBetweenFrom, "changedBetweenFrom");
  assertTimestamp(event.changedBetweenTo, "changedBetweenTo");
  assertString(event.kind, "kind");
  if (!OUTCOMES.has(event.outcome)) throw new TypeError("outcome is invalid");
  assertString(event.surface, "surface");
  assertString(event.operation, "operation");
  assertString(event.templateId, "templateId", true);
  assertString(event.notePath, "notePath", true);
  assertVaultRelative(event.notePath);
  assertDigest(event.inputSignature, "inputSignature");
  assertDigest(event.templateSignature, "templateSignature");
  assertString(event.packageVersion, "packageVersion", true);
  assertString(event.gitCommit, "gitCommit", true);
}

export function createRuntimeEvent(invocation: RuntimeInvocation, input: RuntimeEventInput): RuntimeEvent {
  const attemptN = input.attemptN ?? 1;
  if (!Number.isSafeInteger(attemptN) || attemptN < 1) throw new TypeError("attemptN must be a positive integer");
  if (input.kind.length === 0) throw new TypeError("kind must be non-empty");
  const notePath = nullable(input.notePath);
  assertVaultRelative(notePath);
  return {
    eventId: randomUUID(),
    invocationId: invocation.invocationId,
    attemptN,
    transactionId: nullable(input.transactionId),
    eventTime: nullable(input.eventTime),
    observedAt: new Date().toISOString(),
    kind: input.kind,
    outcome: input.outcome,
    changedBetweenFrom: nullable(input.changedBetweenFrom),
    changedBetweenTo: nullable(input.changedBetweenTo),
    surface: invocation.surface,
    operation: invocation.operation,
    templateId: nullable(input.templateId),
    notePath,
    inputSignature: nullable(input.inputSignature),
    templateSignature: nullable(input.templateSignature),
    packageVersion: invocation.packageVersion,
    gitCommit: invocation.gitCommit,
  };
}

function eventValues(event: RuntimeEvent, location: LedgerLocation, registeredAt: string): EventRow {
  return {
    event_id: event.eventId,
    invocation_id: event.invocationId,
    attempt_n: event.attemptN,
    transaction_id: event.transactionId,
    event_time: event.eventTime,
    observed_at: event.observedAt,
    registered_at: registeredAt,
    kind: event.kind,
    outcome: event.outcome,
    changed_between_from: event.changedBetweenFrom,
    changed_between_to: event.changedBetweenTo,
    vault_fingerprint: location.vaultFingerprint,
    host_id: location.hostId,
    surface: event.surface,
    operation: event.operation,
    template_id: event.templateId,
    note_path: event.notePath,
    input_signature: event.inputSignature,
    template_signature: event.templateSignature,
    package_version: event.packageVersion,
    git_commit: event.gitCommit,
  };
}

function sameReplay(row: EventRow, expected: EventRow): boolean {
  for (const key of Object.keys(expected) as (keyof EventRow)[]) {
    if (key !== "registered_at" && row[key] !== expected[key]) return false;
  }
  return true;
}

export function appendRuntimeEvent(event: RuntimeEvent, options: RuntimeLedgerOptions): RuntimeEventAppendResult {
  let database: Database.Database | undefined;
  try {
    validateRuntimeEvent(event);
    const location = resolveRuntimeLedgerLocation(options, true);
    if (location === null) throw new Error("runtime ledger location was not created");
    database = new Database(location.databasePath);
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.exec(SCHEMA);
    const select = database.prepare("SELECT * FROM runtime_events WHERE event_id = ?");
    const insert = database.prepare(`INSERT OR IGNORE INTO runtime_events (
      event_id, invocation_id, attempt_n, transaction_id, event_time, observed_at, registered_at,
      kind, outcome, changed_between_from, changed_between_to, vault_fingerprint, host_id,
      surface, operation, template_id, note_path, input_signature, template_signature,
      package_version, git_commit
    ) VALUES (
      @event_id, @invocation_id, @attempt_n, @transaction_id, @event_time, @observed_at, @registered_at,
      @kind, @outcome, @changed_between_from, @changed_between_to, @vault_fingerprint, @host_id,
      @surface, @operation, @template_id, @note_path, @input_signature, @template_signature,
      @package_version, @git_commit
    )`);
    return database.transaction((): RuntimeEventAppendResult => {
      const existing = select.get(event.eventId) as EventRow | undefined;
      const registeredAt = new Date().toISOString();
      const values = eventValues(event, location, registeredAt);
      if (existing !== undefined) {
        if (!sameReplay(existing, values)) throw new Error(`event_id ${event.eventId} was replayed with different data`);
        return { eventId: event.eventId, inserted: false, registeredAt: existing.registered_at };
      }
      const result = insert.run(values);
      if (result.changes !== 1) throw new Error(`event_id ${event.eventId} conflicted during append`);
      return { eventId: event.eventId, inserted: true, registeredAt };
    }).immediate();
  } catch (error) {
    if (error instanceof RuntimeLedgerError && error.code === "LEDGER_ROOT_INSIDE_VAULT") throw error;
    throw new RuntimeLedgerError("LEDGER_APPEND_FAILED", `could not append event ${event.eventId}`, { cause: error });
  } finally {
    database?.close();
  }
}
