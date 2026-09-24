import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, type Dir } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ContractSelectionBinding } from "../templates/source-registry.js";
import type { Digest } from "../templates/types.js";

export type OmsSessionErrorCode =
  | "SESSION_ROOT_INVALID"
  | "SESSION_ROOT_INSIDE_VAULT"
  | "SESSION_UNSAFE"
  | "SESSION_INVALID"
  | "SESSION_VAULT_MISMATCH"
  | "SESSION_CORRUPT"
  | "SESSION_UNSUPPORTED"
  | "SESSION_EXPIRED"
  | "SESSION_RETAINED"
  | "SESSION_RECONCILIATION_UNCERTAIN";

export interface OmsSessionReconciliationLocator {
  readonly sessionsRoot: string;
  readonly connectionId: string;
  readonly sessionId: string;
}

export class OmsSessionError extends Error {
  readonly locator?: OmsSessionReconciliationLocator;
  constructor(readonly code: OmsSessionErrorCode, message: string, options?: ErrorOptions & { readonly locator?: OmsSessionReconciliationLocator }) {
    super(`${code}: ${message}`, options);
    this.name = "OmsSessionError";
    this.locator = options?.locator;
  }
}

/** Explicit external root. There is no implicit default until parent integration supplies one. */
export interface OmsSessionStoreOptions {
  readonly sessionsRoot: string;
  readonly vaultPath: string;
  readonly connectionId: string;
  readonly vaultId: string;
}

export interface OmsSelectionSession {
  readonly version: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly connectionId: string;
  readonly vaultId: string;
  readonly vaultFingerprint: string;
  readonly notePath: string;
  readonly selection: ContractSelectionBinding;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_KEYS = ["version", "sessionId", "createdAt", "connectionId", "vaultId", "vaultFingerprint", "notePath", "selection"] as const;
const SELECTION_KEYS = ["version", "templateId", "policyRevision", "contractDigest", "sourceDigest", "sourceIdentity", "sourcePath", "headingBindings"] as const;
const MAX_TEMPLATE_ID_LENGTH = 128;
const MAX_NOTE_PATH_LENGTH = 1024;
const MAX_HEADING_BINDINGS = 64;
const MAX_BINDING_KEY_LENGTH = 128;
const MAX_BINDING_VALUE_LENGTH = 512;
const MAX_RECORD_BYTES = 64 * 1024;
export const SELECTION_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SELECTION_SESSION_CAP = 64;
const RETENTION_SCAN_BUDGET = SELECTION_SESSION_CAP * 2;
const MAX_SOURCE_IDENTITY_LENGTH = 256;
const MAX_SOURCE_PATH_LENGTH = 1024;

function fail(code: OmsSessionErrorCode, message: string, options?: ErrorOptions): never {
  throw new OmsSessionError(code, message, options);
}

function failUncertain(locator: OmsSessionReconciliationLocator, cause: unknown): never {
  throw new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection cleanup failed; the newly created record may still exist", { cause, locator });
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key)) || Object.getOwnPropertySymbols(value).length > 0) {
    fail("SESSION_INVALID", `${label} must contain exactly ${allowed.join(", ")}`);
  }
}

/** Lexical `.md` confinement. Does not create the note or copy its bytes. */
export function confineSelectionNotePath(notePath: string): string {
  if (typeof notePath !== "string" || notePath.length === 0 || notePath.length > MAX_NOTE_PATH_LENGTH || notePath.includes("\0")) {
    fail("SESSION_INVALID", "notePath must be a bounded vault-relative .md path");
  }
  const normalized = notePath.replaceAll("\\", "/").normalize("NFC");
  if (normalized !== notePath || !normalized.endsWith(".md") || normalized.length === 3) {
    fail("SESSION_INVALID", "notePath must already be a canonical vault-relative .md path");
  }
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) {
    fail("SESSION_INVALID", "notePath must be vault-relative");
  }
  const segments = normalized.split("/");
  if (segments.some(part => part === "" || part === "." || part === ".." || part.startsWith(".") || part === "node_modules")) {
    fail("SESSION_INVALID", "notePath must stay inside ordinary vault notes");
  }
  return normalized;
}

function assertDigest(value: unknown, field: string, nullable: boolean): asserts value is Digest | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !DIGEST.test(value)) fail("SESSION_INVALID", `${field} must be ${nullable ? "null or " : ""}sha256:<64 lowercase hex>`);
}
function assertNullableText(value: unknown, field: string, max: number): void {
  if (value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.normalize("NFC") || /[\u0000-\u001f]/u.test(value)) {
    fail("SESSION_INVALID", `${field} must be null or bounded single-line text`);
  }
}

function assertSourcePath(value: unknown): void {
  if (value === null) return;
  try {
    if (confineSelectionNotePath(value as string) !== value || (value as string).length > MAX_SOURCE_PATH_LENGTH) fail("SESSION_INVALID", "sourcePath must be a canonical relative .md path");
  } catch {
    fail("SESSION_INVALID", "sourcePath must be a canonical relative .md path");
  }
}

function assertSelection(value: unknown): asserts value is ContractSelectionBinding {
  if (!isRecord(value)) fail("SESSION_INVALID", "selection must be an object");
  exactKeys(value, SELECTION_KEYS, "selection");
  if (value.version !== 1) fail("SESSION_UNSUPPORTED", "selection version must be 1");
  if (value.templateId !== null) {
    if (typeof value.templateId !== "string" || value.templateId.length === 0 || value.templateId.length > MAX_TEMPLATE_ID_LENGTH || value.templateId.includes("\0") || /[\u0000-\u001f]/u.test(value.templateId)) {
      fail("SESSION_INVALID", "templateId must be null or bounded text");
    }
  }
  if (!Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) < 0) {
    fail("SESSION_INVALID", "policyRevision must be a non-negative safe integer");
  }
  assertDigest(value.contractDigest, "contractDigest", false);
  assertDigest(value.sourceDigest, "sourceDigest", true);
  assertNullableText(value.sourceIdentity, "sourceIdentity", MAX_SOURCE_IDENTITY_LENGTH);
  assertSourcePath(value.sourcePath);
  if ((value.templateId === null) !== (value.sourceIdentity === null) || (value.templateId === null) !== (value.sourcePath === null) || (value.templateId === null) !== (value.sourceDigest === null)) {
    fail("SESSION_INVALID", "common selection must null source identity, path, and digest together");
  }
  if (!isRecord(value.headingBindings)) fail("SESSION_INVALID", "headingBindings must be an object");
  const bindings = Object.entries(value.headingBindings);
  if (bindings.length > MAX_HEADING_BINDINGS || Object.getOwnPropertySymbols(value.headingBindings).length > 0) {
    fail("SESSION_INVALID", "headingBindings exceed the persisted slot limit");
  }
  for (const [key, binding] of bindings) {
    if (key.length === 0 || key.length > MAX_BINDING_KEY_LENGTH || key !== key.normalize("NFC") || /[\u0000-\u001f]/u.test(key)) {
      fail("SESSION_INVALID", "heading binding keys must be bounded single-line text");
    }
    if (typeof binding !== "string" || binding.length === 0 || binding.length > MAX_BINDING_VALUE_LENGTH || binding !== binding.trim() || binding !== binding.normalize("NFC") || /[\u0000-\u001f]/u.test(binding)) {
      fail("SESSION_INVALID", "heading binding values must be exact bounded single-line titles");
    }
  }
}

function assertSession(value: unknown, expected: { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string }): asserts value is OmsSelectionSession {
  if (!isRecord(value)) fail("SESSION_CORRUPT", "selection session must be an object");
  exactKeys(value, SESSION_KEYS, "selection session");
  if (value.version !== 1) fail("SESSION_UNSUPPORTED", "selection session version must be 1");
  if (typeof value.sessionId !== "string" || !UUID.test(value.sessionId) || value.sessionId !== value.sessionId.toLowerCase()) fail("SESSION_INVALID", "sessionId must be a lowercase UUID");
  if (typeof value.createdAt !== "string" || !TIMESTAMP.test(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) {
    fail("SESSION_INVALID", "createdAt must be a UTC millisecond timestamp");
  }
  if (typeof value.connectionId !== "string" || !UUID.test(value.connectionId) || value.connectionId !== value.connectionId.toLowerCase()) {
    fail("SESSION_INVALID", "connectionId must be a lowercase UUID");
  }
  if (typeof value.vaultId !== "string" || !UUID.test(value.vaultId) || value.vaultId !== value.vaultId.toLowerCase()) {
    fail("SESSION_INVALID", "vaultId must be a lowercase UUID");
  }
  if (typeof value.vaultFingerprint !== "string" || !FINGERPRINT.test(value.vaultFingerprint)) {
    fail("SESSION_INVALID", "vaultFingerprint must be 64 lowercase hex characters");
  }
  if (value.connectionId !== expected.connectionId) fail("SESSION_INVALID", "selection session connection does not match its locator");
  if (value.vaultId !== expected.vaultId || value.vaultFingerprint !== expected.fingerprint) {
    fail("SESSION_VAULT_MISMATCH", "selection session portable identity or canonical fingerprint does not match this vault");
  }
  confineSelectionNotePath(value.notePath as string);
  assertSelection(value.selection);
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !UUID.test(sessionId) || sessionId !== sessionId.toLowerCase()) {
    fail("SESSION_INVALID", "sessionId must be a lowercase UUID");
  }
}

/** Pure persisted-input admission. Creates no directories, records, or capability. */
export function validateOmsSelectionSessionInput(input: { readonly notePath: string; readonly selection: ContractSelectionBinding }): void {
  if (!isRecord(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "notePath") || !Object.hasOwn(input, "selection")) {
    fail("SESSION_INVALID", "selection input must contain only notePath and selection");
  }
  confineSelectionNotePath(input.notePath);
  assertSelection(input.selection);
}

async function assertNoSymlinkAncestors(candidate: string, label: string): Promise<void> {
  if (candidate.includes("\0") || !path.isAbsolute(candidate)) fail("SESSION_ROOT_INVALID", `${label} must be an absolute path without NUL`);
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      existing = await lstat(cursor);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) fail("SESSION_ROOT_INVALID", `${label} has no existing ancestor`);
      const parentStat = await lstat(parent).catch(parentError => {
        if (isCode(parentError, "ENOENT")) return undefined;
        throw parentError;
      });
      if (parentStat?.isSymbolicLink()) fail("SESSION_UNSAFE", `${label} escapes through symbolic link ${parent}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    if (existing.isSymbolicLink()) fail("SESSION_UNSAFE", `${label} escapes through symbolic link ${cursor}`);
    const resolved = path.resolve(await realpath(cursor));
    if (resolved !== path.resolve(cursor)) fail("SESSION_UNSAFE", `${label} escapes through a symlink ancestor of ${cursor}`);
    const leaf = path.resolve(resolved, ...missing);
    if (path.resolve(candidate) !== leaf) fail("SESSION_UNSAFE", `${label} does not stay inside its real ancestor`);
    return;
  }
}

async function canonicalVault(vaultPath: string): Promise<string> {
  await assertNoSymlinkAncestors(path.resolve(vaultPath), "vault path");
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(vaultPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) fail("SESSION_ROOT_INVALID", `vault path does not exist: ${vaultPath}`);
    throw error;
  }
  if (link.isSymbolicLink()) fail("SESSION_UNSAFE", `vault path must not be a symbolic link: ${vaultPath}`);
  const canonical = await realpath(vaultPath);
  if (!(await stat(canonical)).isDirectory()) fail("SESSION_ROOT_INVALID", `vault path is not a directory: ${canonical}`);
  return canonical;
}

async function ensureRealDirectory(candidate: string): Promise<string> {
  await assertNoSymlinkAncestors(candidate, "sessions root");
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(candidate);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  if (existing === undefined) {
    await ensureRealDirectory(path.dirname(candidate));
    try {
      await mkdir(candidate, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  const link = await lstat(candidate);
  if (link.isSymbolicLink() || !link.isDirectory()) fail("SESSION_UNSAFE", `${candidate} must be a real directory`);
  const resolved = path.resolve(await realpath(candidate));
  if ((link.mode & 0o077) !== 0) fail("SESSION_UNSAFE", `${candidate} must be a private directory`);
  if (resolved !== path.resolve(candidate)) fail("SESSION_UNSAFE", `${candidate} escapes through a symlink`);
  return resolved;
}

async function locatedSessionsRoot(sessionsRoot: string, vaultRealPath: string, create: boolean): Promise<string | null> {
  if (typeof sessionsRoot !== "string" || sessionsRoot.includes("\0") || !path.isAbsolute(sessionsRoot)) {
    fail("SESSION_ROOT_INVALID", "sessionsRoot must be an explicit absolute path");
  }
  const candidate = path.resolve(sessionsRoot);
  await assertNoSymlinkAncestors(candidate, "sessions root");
  if (contained(vaultRealPath, candidate)) fail("SESSION_ROOT_INSIDE_VAULT", "sessionsRoot is inside the vault");
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(candidate);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  if (existing === undefined) {
    if (!create) return null;
    await ensureRealDirectory(candidate);
  }
  const link = await lstat(candidate);
  if (link.isSymbolicLink() || !link.isDirectory()) fail("SESSION_UNSAFE", "sessionsRoot must be a real directory");
  if ((link.mode & 0o077) !== 0) fail("SESSION_UNSAFE", "sessionsRoot must be private to its owner");
  const resolved = path.resolve(await realpath(candidate));
  if (contained(vaultRealPath, resolved) || contained(resolved, vaultRealPath)) {
    fail("SESSION_ROOT_INSIDE_VAULT", "sessionsRoot resolves inside the vault or aliases it");
  }
  return resolved;
}

async function assertSafeRecord(candidate: string, vaultRealPath: string, kind: "file" | "absent-file"): Promise<void> {
  await assertNoSymlinkAncestors(candidate, "selection session");
  if (!contained(path.dirname(candidate), candidate)) fail("SESSION_UNSAFE", "selection session escapes its root");
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(candidate);
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      if (kind === "absent-file") return;
      fail("SESSION_INVALID", "selection session does not exist");
    }
    throw error;
  }
  if (existing.isSymbolicLink()) fail("SESSION_UNSAFE", "selection session must not be a symbolic link");
  const real = await realpath(candidate);
  if (!contained(path.dirname(path.resolve(candidate)), path.resolve(real))) fail("SESSION_UNSAFE", "selection session resolves outside its root");
  if (contained(vaultRealPath, path.resolve(real))) fail("SESSION_UNSAFE", "selection session resolves inside the vault");
  const file = await stat(real);
  if (!file.isFile()) fail("SESSION_UNSAFE", "selection session must be a regular file");
  if (file.nlink !== 1) fail("SESSION_UNSAFE", "selection session must not be hard-linked");
  if ((file.mode & 0o077) !== 0) fail("SESSION_UNSAFE", "selection session must be private to its owner");
  if (file.size > MAX_RECORD_BYTES) fail("SESSION_INVALID", "selection session exceeds the metadata limit");
}
interface ObservedRecord {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly bytes: Uint8Array;
}

function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function disappearedAfterObservation(error: unknown): never {
  if (isCode(error, "ENOENT")) fail("SESSION_UNSAFE", "selection session disappeared after it was observed", { cause: error });
  throw error;
}

async function readBoundedRecord(target: string, vaultRealPath: string): Promise<ObservedRecord> {
  await assertSafeRecord(target, vaultRealPath, "file");
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0) {
    fail("SESSION_UNSAFE", "selection session is not a private regular file");
  }
  if (before.size > MAX_RECORD_BYTES) fail("SESSION_INVALID", "selection session exceeds the metadata limit");
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    disappearedAfterObservation(error);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || !sameIdentity(before, opened) || opened.size !== before.size) {
      fail("SESSION_UNSAFE", "selection session changed before reading");
    }
    if (opened.size > MAX_RECORD_BYTES) fail("SESSION_INVALID", "selection session exceeds the metadata limit");
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let total = 0;
    while (total <= MAX_RECORD_BYTES) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
        fail("SESSION_CORRUPT", "selection session returned an invalid byte count");
      }
      total += bytesRead;
    }
    const after = await handle.stat();
    let pathAfter: Awaited<ReturnType<typeof lstat>>;
    try {
      pathAfter = await lstat(target);
    } catch (error) {
      disappearedAfterObservation(error);
    }
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || (after.mode & 0o077) !== 0 || !sameIdentity(opened, after) || !sameIdentity(before, pathAfter) || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.nlink !== 1) {
      fail("SESSION_UNSAFE", "selection session changed while reading");
    }
    if (total > MAX_RECORD_BYTES || after.size > MAX_RECORD_BYTES || pathAfter.size > MAX_RECORD_BYTES) {
      fail("SESSION_INVALID", "selection session exceeds the metadata limit");
    }
    if (after.size !== opened.size || total !== after.size || pathAfter.size !== after.size) {
      fail("SESSION_UNSAFE", "selection session changed while reading");
    }
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      disappearedAfterObservation(error);
    }
    if (!contained(path.dirname(path.resolve(target)), path.resolve(real)) || contained(vaultRealPath, path.resolve(real))) {
      fail("SESSION_UNSAFE", "selection session escaped while reading");
    }
    return { dev: after.dev, ino: after.ino, mode: after.mode, bytes: new Uint8Array(buffer.subarray(0, total)) };
  } finally {
    await handle.close();
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function publishRecord(directory: string, target: string, bytes: Uint8Array, vaultRealPath: string, onPublished: (owned: ObservedRecord) => void): Promise<ObservedRecord> {
  await assertSafeRecord(target, vaultRealPath, "absent-file");
  try {
    await lstat(target);
    fail("SESSION_INVALID", "selection session already exists");
  } catch (error) {
    if (error instanceof OmsSessionError) throw error;
    if (!isCode(error, "ENOENT")) throw error;
  }
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    const staged = await handle.stat();
    if (staged.isSymbolicLink() || !staged.isFile() || staged.nlink !== 1 || (staged.mode & 0o077) !== 0) fail("SESSION_UNSAFE", "temporary selection session is not a private regular file");
    await handle.close();
    try {
      await lstat(target);
      fail("SESSION_INVALID", "selection session appeared before publication");
    } catch (error) {
      if (error instanceof OmsSessionError) throw error;
      if (!isCode(error, "ENOENT")) throw error;
    }
    await rename(temporary, target);
    onPublished({ dev: staged.dev, ino: staged.ino, mode: staged.mode, bytes });
    syncDirectory(directory);
  } finally {
    await handle.close().catch(error => {
      if (!isCode(error, "EBADF")) throw error;
    });
    await rm(temporary, { force: true }).catch(error => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
  const observed = await readBoundedRecord(target, vaultRealPath);
  if (!Buffer.from(observed.bytes).equals(bytes)) fail("SESSION_CORRUPT", "published selection session does not match the completed bytes");
  if ((observed.mode & 0o077) !== 0) fail("SESSION_UNSAFE", "selection session is not private");
  return observed;
}

function connectionDirectory(root: string, connectionId: string): string {
  assertSessionId(connectionId);
  return path.join(root, connectionId);
}

function recordPath(root: string, connectionId: string, sessionId: string): string {
  assertSessionId(sessionId);
  const directory = connectionDirectory(root, connectionId);
  const target = path.join(directory, `${sessionId}.json`);
  if (!contained(directory, target)) fail("SESSION_UNSAFE", "selection session escapes its connection");
  return target;
}

function cloneSession(session: OmsSelectionSession): OmsSelectionSession {
  return {
    version: 1,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    connectionId: session.connectionId,
    vaultId: session.vaultId,
    vaultFingerprint: session.vaultFingerprint,
    notePath: session.notePath,
    selection: {
      version: 1,
      templateId: session.selection.templateId,
      policyRevision: session.selection.policyRevision,
      contractDigest: session.selection.contractDigest,
      sourceDigest: session.selection.sourceDigest,
      sourceIdentity: session.selection.sourceIdentity,
      sourcePath: session.selection.sourcePath,
      headingBindings: { ...session.selection.headingBindings },
    },
  };
}

function encode(session: OmsSelectionSession): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(cloneSession(session))}\n`);
}

function expectedIdentity(options: OmsSessionStoreOptions, fingerprint: string): { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string } {
  assertSessionId(options.connectionId);
  assertSessionId(options.vaultId);
  return { connectionId: options.connectionId.toLowerCase(), vaultId: options.vaultId.toLowerCase(), fingerprint };
}

interface ClassifiedSession {
  readonly session: OmsSelectionSession;
  readonly observed: ObservedRecord;
  readonly expired: boolean;
}

async function observeSessionRecord(target: string, vaultRealPath: string, expected: { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string }, sessionId: string): Promise<ClassifiedSession> {
  const observed = await readBoundedRecord(target, vaultRealPath);
  const bytes = Buffer.from(observed.bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("SESSION_CORRUPT", "selection session is not UTF-8 JSON", { cause: error });
  }
  assertSession(parsed, expected);
  if (path.basename(target) !== `${sessionId}.json` || parsed.sessionId !== sessionId) fail("SESSION_INVALID", "selection session filename does not match sessionId");
  const canonical = encode(parsed);
  if (!bytes.equals(canonical)) fail("SESSION_CORRUPT", "selection session is not canonical minimal metadata");
  let after: Awaited<ReturnType<typeof lstat>>;
  try {
    after = await lstat(target);
  } catch (error) {
    disappearedAfterObservation(error);
  }
  if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameIdentity(observed, after) || after.size !== bytes.byteLength) {
    fail("SESSION_UNSAFE", "selection session changed while reading");
  }
  return { session: cloneSession(parsed), observed, expired: Date.parse(parsed.createdAt) + SELECTION_SESSION_TTL_MS <= Date.now() };
}

async function readRecord(target: string, vaultRealPath: string, expected: { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string }, sessionId: string): Promise<OmsSelectionSession> {
  const classified = await observeSessionRecord(target, vaultRealPath, expected, sessionId);
  if (classified.expired) fail("SESSION_EXPIRED", "selection session exceeded the seven-day retention");
  return classified.session;
}

interface RetainedRecord {
  readonly session: OmsSelectionSession;
  readonly observed: ObservedRecord;
  readonly target: string;
}

async function scanRetentionNames(directory: string): Promise<string[] | null> {
  let dir: Dir;
  try {
    dir = await opendir(directory);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  const names: string[] = [];
  // Dir's async iterator closes the handle on completion and on early exit.
  for await (const entry of dir) {
    if (names.length === RETENTION_SCAN_BUDGET) fail("SESSION_RETAINED", "connection directory exceeds the retention scan budget");
    names.push(entry.name);
  }
  return names;
}

async function classifyConnection(directory: string, vaultRealPath: string, expected: { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string }): Promise<{ readonly retained: RetainedRecord[]; readonly removable: RetainedRecord[] }> {
  const names = await scanRetentionNames(directory);
  if (names === null) return { retained: [], removable: [] };
  const retained: RetainedRecord[] = [];
  const removable: RetainedRecord[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const target = path.join(directory, name);
    if (!name.endsWith(".json") || !contained(directory, target)) fail("SESSION_RETAINED", `unrecognized entry blocks retention: ${name}`);
    const leaf = name.slice(0, -".json".length);
    if (!UUID.test(leaf) || leaf !== leaf.toLowerCase()) fail("SESSION_RETAINED", `non-UUID record blocks retention: ${name}`);
    let classified: ClassifiedSession;
    try {
      classified = await observeSessionRecord(target, vaultRealPath, expected, leaf);
    } catch (error) {
      fail("SESSION_RETAINED", `unvalidated entry blocks retention: ${name}`, { cause: error });
    }
    const record = { session: classified.session, observed: classified.observed, target };
    if (classified.expired) removable.push(record);
    else retained.push(record);
  }
  return { retained, removable };
}

async function confirmRetainedVictim(target: string, vaultRealPath: string, classified: RetainedRecord): Promise<void> {
  if (!contained(path.dirname(target), target) || path.basename(target) !== `${classified.session.sessionId}.json`) {
    fail("SESSION_RETAINED", "retention victim pathname no longer matches the classified record");
  }
  let observed: ObservedRecord;
  try {
    observed = await readBoundedRecord(target, vaultRealPath);
  } catch (error) {
    fail("SESSION_RETAINED", "retention victim changed before removal", { cause: error });
  }
  const sameBytes = Buffer.from(observed.bytes).equals(Buffer.from(classified.observed.bytes));
  if (!sameIdentity(observed, classified.observed) || !sameBytes || (observed.mode & 0o077) !== 0) {
    fail("SESSION_RETAINED", "retention victim no longer matches the classified identity and bytes");
  }
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(target);
  } catch (error) {
    fail("SESSION_RETAINED", "retention victim pathname changed before removal", { cause: error });
  }
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameIdentity(current, classified.observed) || current.size !== classified.observed.bytes.byteLength) {
    fail("SESSION_RETAINED", "retention victim pathname identity changed before removal");
  }
}

async function enforceRetention(directory: string, vaultRealPath: string, expected: { readonly connectionId: string; readonly vaultId: string; readonly fingerprint: string }, published: string): Promise<void> {
  const classified = await classifyConnection(directory, vaultRealPath, expected);
  const ranked = [...classified.retained].sort((left, right) => left.session.createdAt < right.session.createdAt ? -1 : left.session.createdAt > right.session.createdAt ? 1 : left.session.sessionId < right.session.sessionId ? -1 : 1);
  const overflow = Math.max(0, ranked.length - SELECTION_SESSION_CAP);
  const oldest = ranked.slice(0, overflow);
  if (oldest.some(item => item.target === published)) fail("SESSION_RETAINED", "published selection would be removed to meet the connection cap");
  const victims = [...classified.removable, ...oldest];
  for (const victim of victims) {
    if (victim.target === published) fail("SESSION_RETAINED", "published selection was required for retention and was not claimed");
    await confirmRetainedVictim(victim.target, vaultRealPath, victim);
    await rm(victim.target);
  }
  const after = await classifyConnection(directory, vaultRealPath, expected);
  if (after.retained.length > SELECTION_SESSION_CAP || after.removable.length > 0) {
    fail("SESSION_RETAINED", "selection retention did not reach the connection cap");
  }
  if (!after.retained.some(item => item.target === published)) fail("SESSION_RETAINED", "published selection is absent after retention");
}
async function removeOwnedRecord(target: string, owned: ObservedRecord, locator: OmsSessionReconciliationLocator): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    failUncertain(locator, error);
  }
  let closeError: unknown;
  let outcome: unknown;
  try {
    const opened = await handle.stat();
    const pathCurrent = await lstat(target);
    const probe = Buffer.alloc(owned.bytes.byteLength);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    const confirmed = await handle.stat();
    const proved = opened.isFile() && !opened.isSymbolicLink() && opened.nlink === 1 && sameIdentity(opened, owned) && sameIdentity(pathCurrent, owned) && pathCurrent.isFile() && !pathCurrent.isSymbolicLink() && pathCurrent.nlink === 1 && pathCurrent.size === owned.bytes.byteLength && bytesRead === probe.length && probe.equals(Buffer.from(owned.bytes)) && sameIdentity(confirmed, owned) && confirmed.nlink === 1 && confirmed.size === owned.bytes.byteLength;
    if (!proved) {
      outcome = new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection cleanup could not prove the current path and inode; replacement bytes were preserved", { locator });
    } else {
      const pathBeforeUnlink = await lstat(target);
      const openedBeforeUnlink = fstatSync(handle.fd);
      if (!sameIdentity(pathBeforeUnlink, owned) || !sameIdentity(openedBeforeUnlink, owned) || pathBeforeUnlink.isSymbolicLink() || pathBeforeUnlink.size !== owned.bytes.byteLength) {
        outcome = new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection identity changed immediately before removal; replacement bytes were preserved", { locator });
      } else {
        try {
          await rm(target);
        } catch (error) {
          if (!isCode(error, "ENOENT")) outcome = new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection cleanup failed; the newly created record may still exist", { cause: error, locator });
        }
      }
    }
    if (outcome === undefined) {
      try {
        const remaining = await lstat(target);
        if (sameIdentity(remaining, owned)) outcome = new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection record remained after removal", { locator });
      } catch (error) {
        if (!isCode(error, "ENOENT")) outcome = new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection cleanup could not be confirmed", { cause: error, locator });
      }
    }
  } catch (error) {
    if (!(error instanceof OmsSessionError)) outcome ??= new OmsSessionError("SESSION_RECONCILIATION_UNCERTAIN", "owned selection cleanup could not prove record identity", { cause: error, locator });
    else outcome ??= error;
  } finally {
    await handle.close().catch(error => {
      closeError = error;
    });
  }
  if (outcome instanceof OmsSessionError) throw outcome;
  if (closeError !== undefined && !isCode(closeError, "EBADF")) failUncertain(locator, closeError);
}

export async function createOmsSelectionSession(
  input: { readonly notePath: string; readonly selection: ContractSelectionBinding },
  options: OmsSessionStoreOptions,
): Promise<OmsSelectionSession> {
  assertSessionId(options.connectionId);
  assertSessionId(options.vaultId);
  validateOmsSelectionSessionInput(input);
  const notePath = confineSelectionNotePath(input.notePath);
  const vaultRealPath = await canonicalVault(options.vaultPath);
  const root = await locatedSessionsRoot(options.sessionsRoot, vaultRealPath, true);
  if (root === null) fail("SESSION_ROOT_INVALID", "sessionsRoot could not be created");
  const expected = expectedIdentity(options, sha256(vaultRealPath));
  const directory = await ensureRealDirectory(connectionDirectory(root, expected.connectionId));
  if (!contained(root, directory)) fail("SESSION_UNSAFE", "connection directory escapes sessionsRoot");
  const session = cloneSession({
    version: 1,
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    connectionId: expected.connectionId,
    vaultId: expected.vaultId,
    vaultFingerprint: expected.fingerprint,
    notePath,
    selection: input.selection,
  });
  const target = recordPath(root, expected.connectionId, session.sessionId);
  const bytes = encode(session);
  let published: ObservedRecord | undefined;
  const locator: OmsSessionReconciliationLocator = { sessionsRoot: root, connectionId: expected.connectionId, sessionId: session.sessionId };
  try {
    await publishRecord(directory, target, bytes, vaultRealPath, owned => {
      published = owned;
    });
    await enforceRetention(directory, vaultRealPath, expected, target);
    return await readRecord(target, vaultRealPath, expected, session.sessionId);
  } catch (error) {
    if (published !== undefined) await removeOwnedRecord(target, published, locator);
    throw error;
  }
}

export async function readOmsSelectionSession(sessionId: string, options: OmsSessionStoreOptions): Promise<OmsSelectionSession | null> {
  assertSessionId(sessionId);
  assertSessionId(options.connectionId);
  assertSessionId(options.vaultId);
  const vaultRealPath = await canonicalVault(options.vaultPath);
  const root = await locatedSessionsRoot(options.sessionsRoot, vaultRealPath, false);
  if (root === null) return null;
  const expected = expectedIdentity(options, sha256(vaultRealPath));
  const target = recordPath(root, expected.connectionId, sessionId);
  await assertSafeRecord(target, vaultRealPath, "absent-file");
  try {
    await lstat(target);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  return readRecord(target, vaultRealPath, expected, sessionId);
}
