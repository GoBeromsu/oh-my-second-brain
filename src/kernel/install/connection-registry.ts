import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import { readVaultSettings } from "../vault/settings.js";

const REGISTRY_VERSION = 2;
const POINTER_VERSION = 1;
const REGISTRY_FILE = "vault.json";
const POINTER_DOMAIN = "oms-host-vault-pointer";
const UPDATE_PROTOCOL = "connection-registry-update";
const UPDATE_VERSION = 1;
const RESERVATION_VERSION = 1;
const RESERVATION_KEYS = new Set(["version", "connectionId", "portableVaultId", "localVaultPath"]);
const ADMITTED_TARGET = new Set(["explicit", "vault", "bridge", "env"]);

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^(?:0|[1-9][0-9]{0,15})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KNOWN_ENTRY_KEYS = new Set(["connectionId", "portableVaultId", "localVaultPath", "revision"]);
const faultArmed = new Map<string, ConnectionRegistryFault>();

export type ConnectionRegistryReason =
  | "missing-state"
  | "malformed"
  | "unsupported-record"
  | "invalid-signature"
  | "unknown-semantics"
  | "stale-cas"
  | "identity-conflict"
  | "invalid-path"
  | "unsafe-target"
  | "locked"
  | "external-change"
  | "receipt-conflict"
  | "injected-fault";

export type ConnectionRegistryFault = "after-manifest" | "after-backup" | "after-registry-rename" | "before-receipt";

export class ConnectionRegistryError extends Error {
  readonly reason: ConnectionRegistryReason;

  constructor(reason: ConnectionRegistryReason, message: string) {
    super(message);
    this.name = "ConnectionRegistryError";
    this.reason = reason;
  }
}

export interface ConnectionRegistryOptions {
  readonly registryPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly runtimeRoot?: string;
  readonly createId?: () => string;
  readonly fault?: ConnectionRegistryFault;
}

export interface VaultConnectionEntry {
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly localVaultPath: string;
  readonly revision: string;
  readonly unknown: Readonly<Record<string, unknown>>;
}

export interface ConnectionRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly selectedConnectionId: string | null;
  readonly connections: readonly VaultConnectionEntry[];
  readonly unknown: Readonly<Record<string, unknown>>;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface ConnectionRegistryRead {
  readonly path: string;
  readonly state: "missing" | "v1" | "v2";
  readonly registry?: ConnectionRegistry;
  readonly pointer?: HostVaultPointerV1;
}

export interface HostVaultPointerV1 {
  readonly version: typeof POINTER_VERSION;
  readonly vault: string;
  readonly signature: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface MigrateHostVaultPointerInput {
  readonly expectedDigest: string;
  readonly portableVaultId: string;
  readonly connectionId?: string;
  readonly operationId?: string;
}

export interface UpsertVaultConnectionInput {
  readonly expectedDigest: string;
  readonly expectedEntryRevision?: string;
  readonly connectionId?: string;
  readonly portableVaultId: string;
  readonly localVaultPath: string;
  readonly select: boolean;
  readonly operationId?: string;
}

export interface ConnectionUpdateStage {
  readonly name: "manifest" | "backup" | "registry" | "receipt";
  readonly target: string;
  readonly preimageDigest: string | null;
  readonly postimageDigest: string;
  readonly backupPath?: string;
}

export interface ConnectionUpdateReceipt {
  readonly protocol: typeof UPDATE_PROTOCOL;
  readonly version: typeof UPDATE_VERSION;
  readonly operationId: string;
  readonly operation: "migrate" | "upsert";
  readonly completed: boolean;
  readonly pendingReconciliation?: boolean;
  readonly reason?: ConnectionRegistryReason;

  readonly atomicity: "single-file-rename";
  readonly crossFilesystemAtomicity: false;
  readonly stages: readonly ConnectionUpdateStage[];
  readonly registryPath: string;
  readonly registryDigest: string;
  readonly inputDigest: string;
}

export interface VaultConnectionReservation {
  readonly version: 1;
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly localVaultPath: string;
  readonly state: "registered" | "reserved";
}

interface OperationManifest {
  readonly protocol: typeof UPDATE_PROTOCOL;
  readonly version: typeof UPDATE_VERSION;
  readonly phase: "sealed";
  readonly operationId: string;
  readonly operation: "migrate" | "upsert";
  readonly registryPath: string;
  readonly inputDigest: string;
  readonly preimageDigest: string | null;
  readonly preimage: string | null;
  readonly postimageDigest: string;
  readonly postimage: string;
}

interface StoredEntry {
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly localVaultPath: string;
  readonly revision: string;
  readonly unknown: Readonly<Record<string, unknown>>;
  readonly canonical: string;
}

interface StoredRegistry {
  readonly selectedConnectionId: string | null;
  readonly connections: readonly StoredEntry[];
  readonly unknown: Readonly<Record<string, unknown>>;
  readonly canonical: string;
}

function fail(reason: ConnectionRegistryReason, message: string): never {
  throw new ConnectionRegistryError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestOf(value: string | Uint8Array): string {
  return `sha256:${sha256(value)}`;
}

function bytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("unknown-semantics", "Non-finite numbers cannot be preserved losslessly.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(",")}]`;
  if (!isRecord(value)) fail("unknown-semantics", "Undefined or non-JSON values cannot be preserved losslessly.");
  const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
}

function copyUnknown(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = emptyRecord();
  for (const key of Object.keys(source)) copy[key] = source[key];
  return copy;
}

function pointerSignature(vault: string): string {
  return sha256(`${POINTER_DOMAIN}\n${POINTER_VERSION}\n${vault}\n`);
}

export function connectionRegistryPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir = homedir(),
): string {
  const configured = env["XDG_CONFIG_HOME"];
  const configHome = configured === undefined || configured === "" ? path.join(homeDir, ".config") : configured;
  if (!path.isAbsolute(configHome)) fail("invalid-path", "XDG_CONFIG_HOME must be an absolute path.");
  return path.join(configHome, "oms", REGISTRY_FILE);
}

function runtimeRootFor(options: ConnectionRegistryOptions): string {
  const configured = options.runtimeRoot ?? options.env?.["OMS_RUNTIME_ROOT"] ?? process.env["OMS_RUNTIME_ROOT"];
  const root = configured === undefined || configured === "" ? path.join(options.homeDir ?? homedir(), ".oms", "runtime", "v1") : configured;
  if (!path.isAbsolute(root)) fail("invalid-path", "OMS runtime root must be an absolute path.");
  return root;
}

function registryLocation(options: ConnectionRegistryOptions): string {
  return options.registryPath ?? connectionRegistryPath(options.env, options.homeDir);
}

function assertIdentifier(value: string, label: string): void {
  if (!ID.test(value)) fail("invalid-path", `${label} must be a UUID.`);
}

function assertRevision(value: string): void {
  if (!REVISION.test(value)) fail("malformed", "Connection revision must be a canonical decimal integer.");
}

function nextRevision(value: string): string {
  assertRevision(value);
  return (BigInt(value) + 1n).toString();
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function optionalLstat(candidate: string): Promise<Stats | undefined> {
  try {
    return await lstat(candidate, { bigint: false });
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function assertNoAncestorSymlink(candidate: string, label: string): Promise<void> {
  if (candidate.includes("\0") || !path.isAbsolute(candidate)) fail("invalid-path", `${label} must be an absolute path without NUL.`);
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    const existing = await optionalLstat(cursor);
    if (existing === undefined) {
      const parent = path.dirname(cursor);
      if (parent === cursor) fail("invalid-path", `${label} has no existing ancestor.`);
      const parentStat = await optionalLstat(parent);
      if (parentStat?.isSymbolicLink()) fail("unsafe-target", `${label} escapes through symbolic link ${parent}.`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    if (existing.isSymbolicLink()) fail("unsafe-target", `${label} escapes through symbolic link ${cursor}.`);
    const resolved = path.resolve(await realpath(cursor));
    const lexical = path.resolve(cursor);
    if (resolved !== lexical) fail("unsafe-target", `${label} escapes through a symlink ancestor of ${cursor}.`);
    const leaf = path.resolve(resolved, ...missing);
    if (path.resolve(candidate) !== leaf) fail("unsafe-target", `${label} does not stay inside its real ancestor.`);
    return;
  }
}

async function assertSafeControl(candidate: string, label: string, kind: "file" | "directory" | "absent-file"): Promise<void> {
  await assertNoAncestorSymlink(candidate, label);
  const existing = await optionalLstat(candidate);
  if (existing === undefined) {
    if (kind !== "absent-file") fail("missing-state", `${label} does not exist.`);
    return;
  }
  if (existing.isSymbolicLink()) fail("unsafe-target", `${label} must not be a symbolic link.`);
  const realStat = await stat(await realpath(candidate));
  if (kind === "directory") {
    if (!realStat.isDirectory()) fail("unsafe-target", `${label} must be a real directory.`);
    return;
  }
  if (!realStat.isFile()) fail("unsafe-target", `${label} must be a regular file.`);
  if (realStat.nlink !== 1) fail("unsafe-target", `${label} must not be hard-linked.`);
}

async function ensureRealDirectory(candidate: string, label: string): Promise<void> {
  await assertNoAncestorSymlink(candidate, label);
  const existing = await optionalLstat(candidate);
  if (existing === undefined) {
    await ensureRealDirectory(path.dirname(candidate), label);
    try {
      await mkdir(candidate, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  await assertSafeControl(candidate, label, "directory");
}

async function canonicalPublicVault(vault: string): Promise<string> {
  if (vault.includes("\0") || !path.isAbsolute(vault)) fail("invalid-path", "Vault path must be an absolute path without NUL.");
  let canonical: string;
  try {
    canonical = path.resolve(await realpath(vault));
  } catch (error) {
    if (isCode(error, "ENOENT")) fail("invalid-path", `Vault path does not exist: ${vault}.`);
    throw error;
  }
  if (!(await stat(canonical)).isDirectory()) fail("invalid-path", `Vault path is not a directory: ${canonical}.`);
  return canonical;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function nearestReal(candidate: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(candidate);
  while (true) {
    const existing = await optionalLstat(cursor);
    if (existing === undefined) {
      const parent = path.dirname(cursor);
      if (parent === cursor) fail("invalid-path", `Connection storage has no existing ancestor: ${candidate}.`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    return path.resolve(await realpath(cursor), ...missing);
  }
}

async function assertOutsideVault(vaultRoot: string, candidate: string, label: string): Promise<void> {
  await assertNoAncestorSymlink(candidate, label);
  const resolved = await nearestReal(candidate);
  if (contained(vaultRoot, resolved) || contained(vaultRoot, path.resolve(candidate))) {
    fail("unsafe-target", `${label} must stay outside the selected vault.`);
  }
}

function reservationPath(options: ConnectionRegistryOptions, canonical: string, portableVaultId: string): string {
  const key = sha256(`${canonical}\0${portableVaultId}`);
  return path.join(runtimeRootFor(options), "connection-reservations", "v1", `${key}.json`);
}

function reservationBytes(connectionId: string, portableVaultId: string, localVaultPath: string): Uint8Array {
  return bytesOf(`${canonicalValue({ version: RESERVATION_VERSION, connectionId, portableVaultId, localVaultPath })}\n`);
}

function parseReservation(raw: string, expected: { readonly portableVaultId: string; readonly localVaultPath: string }, location: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("malformed", `Connection reservation is malformed: ${location}.`);
  }
  if (!isRecord(parsed)) fail("malformed", `Connection reservation is malformed: ${location}.`);
  const keys = Object.keys(parsed);
  if (keys.length !== RESERVATION_KEYS.size || keys.some(key => !RESERVATION_KEYS.has(key)) || parsed["version"] !== RESERVATION_VERSION) {
    fail("unsupported-record", `Connection reservation has an unsupported shape: ${location}.`);
  }
  if (typeof parsed["connectionId"] !== "string" || typeof parsed["portableVaultId"] !== "string" || typeof parsed["localVaultPath"] !== "string") {
    fail("malformed", `Connection reservation is missing required members: ${location}.`);
  }
  assertIdentifier(parsed["connectionId"], "connectionId");
  assertIdentifier(parsed["portableVaultId"], "portableVaultId");
  if (parsed["portableVaultId"] !== expected.portableVaultId || parsed["localVaultPath"] !== expected.localVaultPath) {
    fail("identity-conflict", `Connection reservation does not bind ${expected.localVaultPath}.`);
  }
  const rendered = decode(reservationBytes(parsed["connectionId"], expected.portableVaultId, expected.localVaultPath));
  if (raw !== rendered) fail("malformed", `Connection reservation is not canonical: ${location}.`);
  return parsed["connectionId"];
}

async function assertPrivateReservationDirectory(target: string, runtimeRoot: string): Promise<void> {
  let cursor = path.dirname(target);
  while (contained(runtimeRoot, cursor)) {
    const existing = await optionalLstat(cursor);
    if (existing !== undefined) {
      await assertSafeControl(cursor, "Connection reservation directory", "directory");
      if ((existing.mode & 0o077) !== 0) fail("unsafe-target", `Connection reservation directory must be private: ${cursor}.`);
    }
    if (cursor === runtimeRoot) return;
    cursor = path.dirname(cursor);
  }
}

async function readValidatedReservation(target: string, portableVaultId: string, localVaultPath: string): Promise<string | undefined> {
  await assertSafeControl(target, "Connection reservation", "absent-file");
  const existing = await optionalLstat(target);
  if (existing === undefined) return undefined;
  if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) fail("unsafe-target", `Connection reservation must be a private regular file: ${target}.`);
  const mode = existing.mode & 0o777;
  if ((mode & 0o077) !== 0) fail("unsafe-target", `Connection reservation must be private: ${target}.`);
  return parseReservation(await readFile(target, "utf8"), { portableVaultId, localVaultPath }, target);
}

async function requirePortableIdentity(canonical: string): Promise<string> {
  let settings: Awaited<ReturnType<typeof readVaultSettings>>;
  try {
    settings = await readVaultSettings(canonical);
  } catch (error) {
    fail("malformed", error instanceof Error ? error.message : `Vault settings are unreadable: ${canonical}.`);
  }
  if (settings === null) fail("missing-state", `Selected vault has no published portable identity: ${canonical}.`);
  assertIdentifier(settings.vaultId, "portableVaultId");
  return settings.vaultId;
}

async function assertReservationStorage(options: ConnectionRegistryOptions, canonical: string): Promise<void> {
  const location = registryLocation(options);
  const runtime = runtimeRootFor(options);
  await assertOutsideVault(canonical, location, "Connection registry");
  await assertOutsideVault(canonical, runtime, "Connection runtime root");
  await assertOutsideVault(canonical, path.join(runtime, "connection-reservations"), "Connection reservation directory");
}

function parsePointer(raw: string, location: string): HostVaultPointerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("malformed", `Connection registry is malformed: ${location}.`);
  }
  if (!isRecord(parsed)) fail("malformed", `Connection registry is malformed: ${location}.`);
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || !keys.includes("signature") || !keys.includes("vault") || !keys.includes("version")
    || parsed["version"] !== POINTER_VERSION || typeof parsed["vault"] !== "string" || typeof parsed["signature"] !== "string") {
    fail("unsupported-record", `Connection registry has an unsupported v1 shape: ${location}.`);
  }
  if (!path.isAbsolute(parsed["vault"])) fail("invalid-path", `v1 vault path must be absolute: ${location}.`);
  if (parsed["signature"] !== pointerSignature(parsed["vault"])) {
    fail("invalid-signature", `v1 integrity digest does not match the unsigned pointer domain: ${location}. This digest is not an authentication claim.`);
  }
  const bytes = bytesOf(raw);
  return { version: POINTER_VERSION, vault: parsed["vault"], signature: parsed["signature"], bytes, digest: digestOf(bytes) };
}

function splitKnown(record: Record<string, unknown>, known: ReadonlySet<string>): { readonly known: Record<string, unknown>; readonly unknown: Record<string, unknown> } {
  const recognized = emptyRecord();
  const unknown = emptyRecord();
  for (const key of Object.keys(record)) {
    if (known.has(key)) recognized[key] = record[key];
    else unknown[key] = record[key];
  }
  for (const key of Object.keys(unknown)) canonicalValue(unknown[key]);
  return { known: recognized, unknown };
}

function parseEntry(value: unknown, location: string): StoredEntry {
  if (!isRecord(value)) fail("malformed", `Connection entry is malformed: ${location}.`);
  const { known, unknown } = splitKnown(value, KNOWN_ENTRY_KEYS);
  if (typeof known["connectionId"] !== "string" || typeof known["portableVaultId"] !== "string"
    || typeof known["localVaultPath"] !== "string" || typeof known["revision"] !== "string") {
    fail("malformed", `Connection entry is missing required members: ${location}.`);
  }
  assertIdentifier(known["connectionId"], "connectionId");
  assertIdentifier(known["portableVaultId"], "portableVaultId");
  assertRevision(known["revision"]);
  if (!path.isAbsolute(known["localVaultPath"])) fail("invalid-path", `Connection path must be absolute: ${location}.`);
  const canonical = canonicalValue({ ...copyUnknown(unknown), connectionId: known["connectionId"], portableVaultId: known["portableVaultId"], localVaultPath: known["localVaultPath"], revision: known["revision"] });
  return {
    connectionId: known["connectionId"],
    portableVaultId: known["portableVaultId"],
    localVaultPath: known["localVaultPath"],
    revision: known["revision"],
    unknown,
    canonical,
  };
}

function parseRegistry(raw: string, location: string): StoredRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("malformed", `Connection registry is malformed: ${location}.`);
  }
  if (!isRecord(parsed)) fail("malformed", `Connection registry is malformed: ${location}.`);
  if (parsed["version"] !== REGISTRY_VERSION) fail("unsupported-record", `Connection registry version is unsupported: ${location}.`);
  const { known, unknown } = splitKnown(parsed, new Set(["version", "selectedConnectionId", "connections"]));
  if (!Array.isArray(known["connections"])) fail("malformed", `Connection registry connections must be an array: ${location}.`);
  if (known["selectedConnectionId"] !== null && typeof known["selectedConnectionId"] !== "string") {
    fail("malformed", `selectedConnectionId must be a string or null: ${location}.`);
  }
  const connections = known["connections"].map(entry => parseEntry(entry, location));
  const ids = new Set<string>();
  for (const entry of connections) {
    if (ids.has(entry.connectionId)) fail("malformed", `Duplicate connectionId: ${entry.connectionId}.`);
    ids.add(entry.connectionId);
  }
  if (typeof known["selectedConnectionId"] === "string" && !ids.has(known["selectedConnectionId"])) {
    fail("malformed", `selectedConnectionId is absent from connections: ${location}.`);
  }
  const document = {
    ...copyUnknown(unknown),
    version: REGISTRY_VERSION,
    selectedConnectionId: known["selectedConnectionId"],
    connections: connections.map(entry => JSON.parse(entry.canonical) as unknown),
  };
  return {
    selectedConnectionId: known["selectedConnectionId"] as string | null,
    connections,
    unknown,
    canonical: `${canonicalValue(document)}\n`,
  };
}

function toPublic(stored: StoredRegistry, raw: string): ConnectionRegistry {
  const bytes = bytesOf(raw);
  return {
    version: REGISTRY_VERSION,
    selectedConnectionId: stored.selectedConnectionId,
    connections: stored.connections.map(entry => ({
      connectionId: entry.connectionId,
      portableVaultId: entry.portableVaultId,
      localVaultPath: entry.localVaultPath,
      revision: entry.revision,
      unknown: entry.unknown,
    })),
    unknown: stored.unknown,
    bytes,
    digest: digestOf(bytes),
  };
}

export async function readConnectionRegistry(options: ConnectionRegistryOptions = {}): Promise<ConnectionRegistryRead> {
  const location = registryLocation(options);
  await assertSafeControl(location, "Connection registry", "absent-file");
  let raw: string;
  try {
    raw = await readFile(location, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { path: location, state: "missing" };
    throw error;
  }
  let head: unknown;
  try {
    head = JSON.parse(raw);
  } catch {
    fail("malformed", `Connection registry is malformed: ${location}.`);
  }
  if (!isRecord(head) || typeof head["version"] !== "number") fail("malformed", `Connection registry is malformed: ${location}.`);
  if (head["version"] === POINTER_VERSION) return { path: location, state: "v1", pointer: parsePointer(raw, location) };
  if (head["version"] === REGISTRY_VERSION) return { path: location, state: "v2", registry: toPublic(parseRegistry(raw, location), raw) };
  fail("unsupported-record", `Connection registry version is unsupported: ${location}.`);
}

async function withRegistryLock<T>(location: string, operation: () => Promise<T>): Promise<T> {
  const parent = path.dirname(location);
  const lock = `${location}.lock`;
  await ensureRealDirectory(parent, "Connection registry directory");
  const token = randomUUID();
  let ownerToken: string | null = null;
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    ownerToken = token;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  if (ownerToken === null) fail("locked", `Connection registry is locked: ${location}. Refusing PID-only lock takeover.`);
  try {
    return await operation();
  } finally {
    await releaseOwned(lock, ownerToken);
  }
}

async function readOwner(lock: string): Promise<{ readonly pid: number; readonly token: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { readonly pid: number; readonly token: string };
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function releaseOwned(lock: string, token: string): Promise<void> {
  try {
    const owner = await readOwner(lock);
    if (owner === null || owner.token !== token || owner.pid !== process.pid) return;
    const released = `${lock}.released.${token}`;
    await rename(lock, released);
    await rm(released, { recursive: true, force: true });
  } catch {
    // Never remove a lock instance not owned by this operation.
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!isCode(error, "EINVAL") && !isCode(error, "ENOTSUP")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function replaceFile(target: string, bytes: Uint8Array, allowedDigests: readonly (string | null)[]): Promise<void> {
  await assertSafeControl(target, "Connection registry", "absent-file");
  const current = await optionalBytes(target);
  const currentDigest = current === undefined ? null : digestOf(current);
  if (!allowedDigests.includes(currentDigest)) fail("external-change", `Connection registry bytes are neither the sealed preimage nor postimage: ${target}.`);
  if (currentDigest === digestOf(bytes)) return;
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await syncDirectory(parent);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
  const written = await readFile(target);
  if (digestOf(written) !== digestOf(bytes)) fail("external-change", `Connection registry postimage does not match the committed bytes: ${target}.`);
}

async function optionalBytes(target: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(target);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function receiptDirectory(options: ConnectionRegistryOptions, operationId: string): string {
  assertIdentifier(operationId, "operationId");
  return path.join(runtimeRootFor(options), "connection-updates", "v1", operationId);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("receipt-conflict", `${label} is not a sha256 digest.`);
}

function validateReceipt(value: unknown, directory: string, location: string, inputDigest: string, operation: "migrate" | "upsert", operationId: string): ConnectionUpdateReceipt {
  if (!isRecord(value)) fail("receipt-conflict", `Connection update receipt is malformed: ${directory}.`);
  if (value["protocol"] !== UPDATE_PROTOCOL || value["version"] !== UPDATE_VERSION) fail("receipt-conflict", `Connection update receipt protocol is unsupported: ${directory}.`);
  if (value["operationId"] !== operationId || value["operation"] !== operation) fail("receipt-conflict", `Connection update receipt identity does not match ${operationId}.`);
  if (value["registryPath"] !== location) fail("receipt-conflict", `Connection update receipt target does not match ${location}.`);
  if (value["inputDigest"] !== inputDigest) fail("receipt-conflict", `Connection update receipt input does not match this operation: ${directory}.`);
  assertDigest(value["registryDigest"], "registryDigest");
  if (value["completed"] !== true || value["atomicity"] !== "single-file-rename" || value["crossFilesystemAtomicity"] !== false) {
    fail("receipt-conflict", `Connection update receipt completion claims are invalid: ${directory}.`);
  }
  if (!Array.isArray(value["stages"]) || value["stages"].length === 0) fail("receipt-conflict", `Connection update receipt stages are missing: ${directory}.`);
  return {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    operationId,
    operation,
    completed: true,
    atomicity: "single-file-rename",
    crossFilesystemAtomicity: false,
    stages: value["stages"] as ConnectionUpdateStage[],
    registryPath: location,
    registryDigest: value["registryDigest"],
    inputDigest,
  };
}

async function readJsonFile(target: string): Promise<unknown | undefined> {
  const existing = await optionalLstat(target);
  if (existing === undefined) return undefined;
  await assertSafeControl(target, target, "file");
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}

async function writeExclusive(target: string, bytes: Uint8Array): Promise<void> {
  await ensureRealDirectory(path.dirname(target), "Connection update directory");
  await assertSafeControl(target, target, "absent-file");
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(target));
}

function backupMarker(raw: Uint8Array | undefined): Uint8Array {
  return raw === undefined ? Uint8Array.of(0) : Uint8Array.of(1, ...raw);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function backupPreimage(directory: string, registryPath: string, raw: Uint8Array | undefined): Promise<string> {
  const backupPath = path.join(directory, "registry-preimage.bin");
  const existing = await optionalLstat(backupPath);
  const marker = backupMarker(raw);
  if (existing === undefined) {
    await writeExclusive(backupPath, marker);
    return backupPath;
  }
  await assertSafeControl(backupPath, "Connection update backup", "file");
  const prior = await readFile(backupPath);
  if (!equalBytes(prior, marker)) fail("external-change", `Connection update backup bytes differ: ${backupPath}.`);
  return backupPath;
}
export {
  assertNoAncestorSymlink as assertConnectionControlPath,
  assertSafeControl as assertConnectionControlTarget,
  ensureRealDirectory as ensureConnectionControlDirectory,
  digestOf as connectionDigest,
  bytesOf as connectionBytes,
  decode as connectionText,
  equalBytes as connectionBytesEqual,
  writeExclusive as writeConnectionExclusive,
  replaceFile as replaceConnectionFile,
  syncDirectory as syncConnectionDirectory,
  optionalBytes as readConnectionBytes,
  runtimeRootFor as connectionRuntimeRoot,
};

function renderRegistry(selectedConnectionId: string | null, connections: readonly StoredEntry[], unknown: Readonly<Record<string, unknown>>): string {
  const document = {
    ...copyUnknown(unknown),
    version: REGISTRY_VERSION,
    selectedConnectionId,
    connections: connections.map(entry => JSON.parse(entry.canonical) as unknown),
  };
  return `${canonicalValue(document)}\n`;
}

function storedFromInput(input: {
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly localVaultPath: string;
  readonly revision: string;
  readonly unknown?: Readonly<Record<string, unknown>>;
}): StoredEntry {
  const unknown = input.unknown ?? emptyRecord();
  canonicalValue(unknown);
  const canonical = canonicalValue({
    ...copyUnknown(unknown),
    connectionId: input.connectionId,
    portableVaultId: input.portableVaultId,
    localVaultPath: input.localVaultPath,
    revision: input.revision,
  });
  return { ...input, unknown, canonical };
}

function inputDigestFor(operation: "migrate" | "upsert", input: MigrateHostVaultPointerInput | UpsertVaultConnectionInput): string {
  const fields = emptyRecord();
  fields["operation"] = operation;
  fields["expectedDigest"] = input.expectedDigest;
  fields["portableVaultId"] = input.portableVaultId;
  if ("localVaultPath" in input) fields["localVaultPath"] = input.localVaultPath;
  if ("select" in input) fields["select"] = input.select;
  if (input.connectionId !== undefined) fields["connectionId"] = input.connectionId;
  if ("expectedEntryRevision" in input && input.expectedEntryRevision !== undefined) fields["expectedEntryRevision"] = input.expectedEntryRevision;
  return digestOf(canonicalValue(fields));
}

function takeFault(operationId: string, boundary: ConnectionRegistryFault, armed: ConnectionRegistryFault | undefined): void {
  const selected = armed ?? faultArmed.get(operationId);
  if (selected !== boundary) return;
  faultArmed.delete(operationId);
  fail("injected-fault", `Injected fault after ${boundary} for ${operationId}.`);
}

function manifestFrom(value: unknown, location: string, operationId: string): OperationManifest {
  if (!isRecord(value)) fail("receipt-conflict", `Connection update manifest is malformed: ${operationId}.`);
  if (value["protocol"] !== UPDATE_PROTOCOL || value["version"] !== UPDATE_VERSION || value["phase"] !== "sealed") {
    fail("receipt-conflict", `Connection update manifest protocol is unsupported: ${operationId}.`);
  }
  if (value["operationId"] !== operationId || (value["operation"] !== "migrate" && value["operation"] !== "upsert")) {
    fail("receipt-conflict", `Connection update manifest identity does not match ${operationId}.`);
  }
  if (value["registryPath"] !== location || typeof value["postimage"] !== "string") fail("receipt-conflict", `Connection update manifest target is invalid: ${operationId}.`);
  assertDigest(value["inputDigest"], "inputDigest");
  assertDigest(value["postimageDigest"], "postimageDigest");
  if (value["preimageDigest"] !== null) assertDigest(value["preimageDigest"], "preimageDigest");
  if (value["preimage"] !== null && typeof value["preimage"] !== "string") fail("receipt-conflict", `Connection update manifest preimage is invalid: ${operationId}.`);
  if (typeof value["preimage"] === "string" && digestOf(value["preimage"]) !== value["preimageDigest"]) fail("receipt-conflict", `Connection update manifest preimage does not match its digest: ${operationId}.`);
  if (value["preimageDigest"] === null && value["preimage"] !== null) fail("receipt-conflict", `Absent preimage must be null: ${operationId}.`);
  if (digestOf(value["postimage"]) !== value["postimageDigest"]) fail("receipt-conflict", `Connection update manifest postimage does not match its digest: ${operationId}.`);
  return {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    phase: "sealed",
    operationId,
    operation: value["operation"],
    registryPath: location,
    inputDigest: value["inputDigest"],
    preimageDigest: value["preimageDigest"] as string | null,
    preimage: value["preimage"] as string | null,
    postimageDigest: value["postimageDigest"],
    postimage: value["postimage"],
  };
}

async function commitRegistry(
  options: ConnectionRegistryOptions,
  operation: "migrate" | "upsert",
  operationId: string,
  inputDigest: string,
  before: Uint8Array | undefined,
  next: string,
): Promise<ConnectionUpdateReceipt> {
  const location = registryLocation(options);
  const directory = receiptDirectory(options, operationId);
  await assertNoAncestorSymlink(directory, "Connection update directory");
  const manifestPath = path.join(directory, "manifest.json");
  const nextBytes = bytesOf(next);
  const nextDigest = digestOf(nextBytes);
  const preimageDigest = before === undefined ? null : digestOf(before);
  const proposed: OperationManifest = {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    phase: "sealed",
    operationId,
    operation,
    registryPath: location,
    inputDigest,
    preimageDigest,
    preimage: before === undefined ? null : decode(before),
    postimageDigest: nextDigest,
    postimage: next,
  };
  const existingManifest = await readJsonFile(manifestPath);
  const manifest = existingManifest === undefined ? proposed : manifestFrom(existingManifest, location, operationId);
  if (manifest.operation !== operation || manifest.inputDigest !== inputDigest || manifest.registryPath !== location || manifest.postimageDigest !== nextDigest || manifest.preimageDigest !== preimageDigest) {
    fail("receipt-conflict", `Connection update ${operationId} is already bound to a different input, target, or postimage.`);
  }
  if (existingManifest === undefined) {
    await writeExclusive(manifestPath, bytesOf(`${canonicalValue(manifest)}\n`));
    takeFault(operationId, "after-manifest", options.fault);
  }
  const receiptPath = path.join(directory, "receipt.json");
  const priorReceipt = await readJsonFile(receiptPath);
  if (priorReceipt !== undefined) {
    const parsed = validateReceipt(priorReceipt, directory, location, inputDigest, operation, operationId);
    if (parsed.registryDigest !== manifest.postimageDigest) fail("external-change", `Connection update receipt bytes differ: ${receiptPath}.`);
    const live = await optionalBytes(location);
    const liveDigest = live === undefined ? null : digestOf(live);
    if (liveDigest === manifest.postimageDigest) return parsed;
    return {
      ...parsed,
      completed: false,
      pendingReconciliation: true,
      reason: "external-change",
      registryDigest: liveDigest ?? "sha256:absent",
    };
  }
  const current = await optionalBytes(location);
  const currentDigest = current === undefined ? null : digestOf(current);
  if (currentDigest !== manifest.preimageDigest && currentDigest !== manifest.postimageDigest) {
    fail("external-change", `Connection registry is neither the sealed preimage nor postimage: ${location}.`);
  }
  const sealedPreimage = manifest.preimage === null ? undefined : bytesOf(manifest.preimage);
  const backupPath = await backupPreimage(directory, location, sealedPreimage);
  takeFault(operationId, "after-backup", options.fault);
  if (currentDigest !== manifest.postimageDigest) await replaceFile(location, bytesOf(manifest.postimage), [manifest.preimageDigest]);
  takeFault(operationId, "after-registry-rename", options.fault);
  takeFault(operationId, "before-receipt", options.fault);
  const stages: ConnectionUpdateStage[] = [
    { name: "manifest", target: manifestPath, preimageDigest: null, postimageDigest: digestOf(`${canonicalValue(manifest)}\n`) },
    { name: "backup", target: location, preimageDigest, postimageDigest: preimageDigest ?? "sha256:absent", backupPath },
    { name: "registry", target: location, preimageDigest, postimageDigest: nextDigest },
  ];
  const receipt: ConnectionUpdateReceipt = {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    operationId,
    operation,
    completed: true,
    atomicity: "single-file-rename",
    crossFilesystemAtomicity: false,
    stages,
    registryPath: location,
    registryDigest: nextDigest,
    inputDigest,
  };
  const receiptBytes = bytesOf(`${canonicalValue(receipt)}\n`);
  const raced = await readJsonFile(receiptPath);
  if (raced === undefined) await writeExclusive(receiptPath, receiptBytes);
  else {
    const parsed = validateReceipt(raced, directory, location, inputDigest, operation, operationId);
    if (parsed.registryDigest !== nextDigest) fail("external-change", `Connection update receipt bytes differ: ${receiptPath}.`);
  }
  const confirmed = await readFile(location);
  if (digestOf(confirmed) !== nextDigest) fail("external-change", `Completed connection update postimage changed: ${location}.`);
  return receipt;

}

export async function migrateHostVaultPointer(
  input: MigrateHostVaultPointerInput,
  options: ConnectionRegistryOptions = {},
): Promise<ConnectionUpdateReceipt> {
  assertIdentifier(input.portableVaultId, "portableVaultId");
  if (input.connectionId !== undefined) assertIdentifier(input.connectionId, "connectionId");
  const operationId = input.operationId ?? randomUUID();
  assertIdentifier(operationId, "operationId");
  if (options.fault !== undefined) faultArmed.set(operationId, options.fault);
  const location = registryLocation(options);
  const boundInput = inputDigestFor("migrate", input);
  return withRegistryLock(location, async () => {
    const directory = receiptDirectory(options, operationId);
    const sealed = await readJsonFile(path.join(directory, "manifest.json"));
    if (sealed !== undefined) {
      const manifest = manifestFrom(sealed, location, operationId);
      if (manifest.operation !== "migrate" || manifest.inputDigest !== boundInput) fail("receipt-conflict", `Migration ${operationId} is bound to another input.`);
      return commitRegistry(options, "migrate", operationId, boundInput, manifest.preimage === null ? undefined : bytesOf(manifest.preimage), manifest.postimage);
    }
    const current = await readConnectionRegistry(options);
    if (current.state === "v2" && current.registry !== undefined) {
      if (current.registry.digest !== input.expectedDigest) fail("stale-cas", `Connection registry digest does not match expectedDigest: ${location}.`);
      const only = current.registry.connections.length === 1 ? current.registry.connections[0] : undefined;
      if (only !== undefined && only.portableVaultId === input.portableVaultId && (input.connectionId === undefined || only.connectionId === input.connectionId)) {
        return commitRegistry(options, "migrate", operationId, boundInput, current.registry.bytes, decode(current.registry.bytes));
      }
      fail("identity-conflict", "Existing v2 registry does not match the v1 migration identity.");
    }
    if (current.state === "missing") fail("missing-state", `No v1 pointer exists to migrate: ${location}.`);
    if (current.state !== "v1" || current.pointer === undefined) fail("unsupported-record", `Only a verified v1 pointer can migrate: ${location}.`);
    if (current.pointer.digest !== input.expectedDigest) fail("stale-cas", `v1 pointer digest does not match expectedDigest: ${location}.`);
    const canonical = await canonicalPublicVault(current.pointer.vault);

    const connectionId = input.connectionId ?? options.createId?.() ?? randomUUID();
    assertIdentifier(connectionId, "connectionId");
    const entry = storedFromInput({ connectionId, portableVaultId: input.portableVaultId, localVaultPath: canonical, revision: "1" });
    return commitRegistry(options, "migrate", operationId, boundInput, current.pointer.bytes, renderRegistry(connectionId, [entry], emptyRecord()));
  });
}


export async function upsertVaultConnection(
  input: UpsertVaultConnectionInput,
  options: ConnectionRegistryOptions = {},
): Promise<ConnectionUpdateReceipt> {
  assertIdentifier(input.portableVaultId, "portableVaultId");
  if (input.connectionId !== undefined) assertIdentifier(input.connectionId, "connectionId");
  const operationId = input.operationId ?? randomUUID();
  assertIdentifier(operationId, "operationId");
  if (options.fault !== undefined) faultArmed.set(operationId, options.fault);
  const canonical = await canonicalPublicVault(input.localVaultPath);

  const location = registryLocation(options);
  const boundInput = inputDigestFor("upsert", { ...input, localVaultPath: canonical });
  return withRegistryLock(location, async () => {
    const directory = receiptDirectory(options, operationId);
    const sealed = await readJsonFile(path.join(directory, "manifest.json"));
    if (sealed !== undefined) {
      const manifest = manifestFrom(sealed, location, operationId);
      if (manifest.operation !== "upsert" || manifest.inputDigest !== boundInput) fail("receipt-conflict", `Upsert ${operationId} is bound to another input.`);
      return commitRegistry(options, "upsert", operationId, boundInput, manifest.preimage === null ? undefined : bytesOf(manifest.preimage), manifest.postimage);
    }
    const current = await readConnectionRegistry(options);
    if (current.state === "v1") fail("unsupported-record", `Migrate the v1 pointer explicitly before upsert: ${location}.`);
    if (current.state === "missing") {
      if (input.expectedDigest !== "sha256:absent") fail("stale-cas", `Missing registry requires expectedDigest sha256:absent: ${location}.`);
      if (input.expectedEntryRevision !== undefined) fail("stale-cas", "A new connection has no expected entry revision.");
      const connectionId = await connectionIdForNew(options, canonical, input.portableVaultId, input.connectionId);
      const entry = storedFromInput({ connectionId, portableVaultId: input.portableVaultId, localVaultPath: canonical, revision: "1" });
      return commitRegistry(options, "upsert", operationId, boundInput, undefined, renderRegistry(input.select ? connectionId : null, [entry], emptyRecord()));
    }
    if (current.registry === undefined) fail("malformed", `Connection registry is unreadable: ${location}.`);
    if (current.registry.digest !== input.expectedDigest) fail("stale-cas", `Connection registry digest does not match expectedDigest: ${location}.`);
    const stored = parseRegistry(decode(current.registry.bytes), location);
    const byId = input.connectionId === undefined ? undefined : stored.connections.find(entry => entry.connectionId === input.connectionId);
    const byPath = stored.connections.find(entry => entry.localVaultPath === canonical);
    if (byId !== undefined && byPath !== undefined && byId.connectionId !== byPath.connectionId) {
      fail("identity-conflict", "connectionId and canonical path identify different connections.");
    }
    const match = byId ?? byPath;
    if (match === undefined) {
      if (input.expectedEntryRevision !== undefined) fail("stale-cas", "A new connection has no expected entry revision.");
      const connectionId = await connectionIdForNew(options, canonical, input.portableVaultId, input.connectionId);
      const created = storedFromInput({ connectionId, portableVaultId: input.portableVaultId, localVaultPath: canonical, revision: "1" });
      const rendered = renderRegistry(input.select ? connectionId : stored.selectedConnectionId, [...stored.connections, created], stored.unknown);
      return commitRegistry(options, "upsert", operationId, boundInput, current.registry.bytes, rendered);
    }
    if (input.connectionId !== undefined && input.connectionId !== match.connectionId) {
      fail("identity-conflict", `connectionId does not match the canonical path entry: ${match.connectionId}.`);
    }
    if (match.portableVaultId !== input.portableVaultId) fail("identity-conflict", `portableVaultId does not match connection ${match.connectionId}.`);
    if (input.expectedEntryRevision !== undefined && input.expectedEntryRevision !== match.revision) {
      fail("stale-cas", `Connection ${match.connectionId} revision does not match expectedEntryRevision.`);
    }
    const revision = match.localVaultPath === canonical ? match.revision : nextRevision(match.revision);
    const updated = storedFromInput({ ...match, localVaultPath: canonical, revision });
    const connections = stored.connections.map(entry => entry.connectionId === match.connectionId ? updated : entry);
    const selected = input.select ? match.connectionId : stored.selectedConnectionId;
    return commitRegistry(options, "upsert", operationId, boundInput, current.registry.bytes, renderRegistry(selected, connections, stored.unknown));
  });
}

async function connectionIdForNew(options: ConnectionRegistryOptions, canonical: string, portableVaultId: string, supplied: string | undefined): Promise<string> {
  const reserved = await readValidatedReservation(reservationPath(options, canonical, portableVaultId), portableVaultId, canonical);
  if (reserved !== undefined) {
    if (supplied !== undefined && supplied !== reserved) fail("identity-conflict", `connectionId does not match the reserved identity ${reserved}.`);
    return reserved;
  }
  const connectionId = supplied ?? options.createId?.() ?? randomUUID();
  assertIdentifier(connectionId, "connectionId");
  return connectionId;
}

export async function reserveVaultConnection(
  target: WriteTarget,
  options: ConnectionRegistryOptions = {},
): Promise<VaultConnectionReservation> {
  if (!ADMITTED_TARGET.has(target.source) || await admitWriteTarget(target) !== undefined) {
    fail("unsafe-target", "Connection reservation requires an admitted explicit, vault, bridge, or env target.");
  }
  const canonical = await canonicalPublicVault(target.vault);
  const portableVaultId = await requirePortableIdentity(canonical);
  await assertReservationStorage(options, canonical);
  const location = registryLocation(options);
  const reservation = reservationPath(options, canonical, portableVaultId);
  await assertPrivateReservationDirectory(reservation, runtimeRootFor(options));
  return withRegistryLock(location, async () => {
    const current = await readConnectionRegistry(options);
    if (current.state === "v2" && current.registry !== undefined) {
      const match = current.registry.connections.find(entry => entry.localVaultPath === canonical);
      if (match !== undefined) {
        if (match.portableVaultId !== portableVaultId) fail("identity-conflict", `Registered portableVaultId does not match published identity ${portableVaultId}.`);
        return { version: RESERVATION_VERSION, connectionId: match.connectionId, portableVaultId, localVaultPath: canonical, state: "registered" };
      }
    }
    const existing = await readValidatedReservation(reservation, portableVaultId, canonical);
    if (existing !== undefined) {
      return { version: RESERVATION_VERSION, connectionId: existing, portableVaultId, localVaultPath: canonical, state: "reserved" };
    }
    const connectionId = options.createId?.() ?? randomUUID();
    assertIdentifier(connectionId, "connectionId");
    await writeExclusive(reservation, reservationBytes(connectionId, portableVaultId, canonical));
    const confirmed = await readValidatedReservation(reservation, portableVaultId, canonical);
    if (confirmed !== connectionId) fail("external-change", `Connection reservation changed during persistence: ${reservation}.`);
    return { version: RESERVATION_VERSION, connectionId, portableVaultId, localVaultPath: canonical, state: "reserved" };
  });
}
