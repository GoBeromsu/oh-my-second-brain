import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  type ConnectionRegistryOptions,
  type ConnectionUpdateReceipt,
  ConnectionRegistryError,
  assertConnectionControlPath,
  assertConnectionControlTarget,
  connectionBytes,
  connectionBytesEqual,
  connectionDigest,
  connectionRuntimeRoot,
  connectionText,
  readConnectionBytes,
  readConnectionRegistry,
  replaceConnectionFile,
  writeConnectionExclusive,
  ensureConnectionControlDirectory,
} from "./connection-registry.js";

const LINK_VERSION = 2;
const UPDATE_PROTOCOL = "connection-registry-update";
const UPDATE_VERSION = 1;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_V2 = new Set(["version", "connectionId", "portableVaultId", "scope"]);
const KNOWN_V1 = new Set(["version", "vault", "scope"]);
const faultArmed = new Map<string, ProjectConnectionFault>();

export type ProjectConnectionReason =
  | "missing-state"
  | "malformed"
  | "unsupported-record"
  | "unknown-semantics"
  | "identity-conflict"
  | "invalid-path"
  | "unsafe-target"
  | "external-change"
  | "receipt-conflict"
  | "pending-reconciliation"
  | "injected-fault"
  | "locked";

export type ProjectConnectionFault = "after-manifest" | "after-backup" | "after-global-commit" | "after-project-publish" | "before-receipt";

export class ProjectConnectionError extends Error {
  readonly reason: ProjectConnectionReason;

  constructor(reason: ProjectConnectionReason, message: string) {
    super(message);
    this.name = "ProjectConnectionError";
    this.reason = reason;
  }
}
function asProjectError(error: unknown): never {
  if (error instanceof ProjectConnectionError) throw error;
  if (error instanceof ConnectionRegistryError) {
    const mapped: ProjectConnectionReason = error.reason === "locked" || error.reason === "unsafe-target" || error.reason === "invalid-path" || error.reason === "external-change" || error.reason === "receipt-conflict" ? error.reason : "external-change";
    fail(mapped, error.message);
  }
  throw error;
}
async function withProjectLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(projectRoot, ".oms", "links.yaml.lock");
  await ensureConnectionControlDirectory(path.dirname(lock), "Project links lock directory");
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") fail("locked", `Project links are locked: ${projectRoot}. Refusing PID-only lock takeover.`);
    asProjectError(error);
  }
  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { readonly pid: number; readonly token: string };
      if (owner.pid === process.pid && owner.token === token) {
        const released = `${lock}.released.${token}`;
        await rename(lock, released);
        await rm(released, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock instance not owned by this operation.
    }
  }
}
async function assertRegistryReceipt(receipt: ConnectionUpdateReceipt, connectionId: string, portableVaultId: string, expectedRegistryDigest: string, options: ConnectionRegistryOptions): Promise<{ readonly path: string; readonly digest: string; readonly localVaultPath: string }> {
  requireReceiptShape(receipt);
  assertUuid(receipt.operationId, "registry operationId");
  if (receipt.registryDigest !== expectedRegistryDigest) fail("receipt-conflict", "Registry receipt digest does not match expectedRegistryDigest.");
  const persisted = path.join(connectionRuntimeRoot(options), "connection-updates", "v1", receipt.operationId, "receipt.json");
  await assertConnectionControlTarget(persisted, "Registry receipt", "file");
  const bytes = await readConnectionBytes(persisted);
  if (bytes === undefined) fail("receipt-conflict", `Persisted registry receipt is missing: ${receipt.operationId}.`);
  const parsed = JSON.parse(connectionText(bytes)) as ConnectionUpdateReceipt;
  if (!isDeepStrictEqual(parsed, receipt)) fail("receipt-conflict", "Explicit registry receipt does not match the persisted receipt.");
  const bound = await requireBoundEntry(options, connectionId, portableVaultId);
  if (parsed.registryPath !== bound.path || parsed.registryDigest !== bound.digest) {
    fail("receipt-conflict", "Explicit registry receipt does not match the live registry path or digest.");
  }
  return bound;
}

export interface ProjectConnectionReference {
  readonly version: typeof LINK_VERSION;
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly scope: readonly string[];
  readonly unknown: Readonly<Record<string, unknown>>;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface ProjectConnectionPointerV1 {
  readonly version: 1;
  readonly vault: string;
  readonly scope: readonly string[];
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface ProjectConnectionRead {
  readonly path: string;
  readonly state: "missing" | "v1" | "v2";
  readonly digest: string | null;
  readonly reference?: ProjectConnectionReference;
  readonly pointer?: ProjectConnectionPointerV1;
}

export interface ProjectConnectionUpdateInput {
  readonly projectRoot: string;
  readonly connectionId: string;
  readonly portableVaultId: string;
  readonly scope: readonly string[];
  readonly expectedRegistryDigest: string;
  readonly expectedProjectDigest: string;
  readonly registryReceipt: ConnectionUpdateReceipt;
  readonly operationId?: string;
  readonly fault?: ProjectConnectionFault;
}

export interface ProjectConnectionUpdateResult {
  readonly protocol: typeof UPDATE_PROTOCOL;
  readonly version: typeof UPDATE_VERSION;
  readonly operationId: string;
  readonly completed: boolean;
  readonly pendingReconciliation: boolean;
  readonly globalCommitted: boolean;
  readonly vaultWritten: false;
  readonly crossFilesystemAtomicity: false;
  readonly registryPath: string;
  readonly registryDigest: string;
  readonly projectPath: string;
  readonly projectDigest: string | null;
  readonly inputDigest: string;
  readonly reason?: ProjectConnectionReason;
}

interface ProjectManifest {
  readonly protocol: typeof UPDATE_PROTOCOL;
  readonly version: typeof UPDATE_VERSION;
  readonly phase: "sealed";
  readonly operationId: string;
  readonly operation: "project-link";
  readonly registryPath: string;
  readonly projectPath: string;
  readonly inputDigest: string;
  readonly registryPostimageDigest: string;
  readonly projectPreimage: string | null;
  readonly projectPostimage: string;
  readonly globalCommitted: boolean;
}

function fail(reason: ProjectConnectionReason, message: string): never {
  throw new ProjectConnectionError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function assertUuid(value: string, label: string): void {
  if (!ID.test(value)) fail("invalid-path", `${label} must be a UUID.`);
}

function assertScope(scope: readonly string[]): void {
  if (scope.length === 0) fail("invalid-path", "Project scope must contain at least one relative path.");
  for (const entry of scope) {
    if (entry.length === 0 || entry.includes("\0") || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      fail("invalid-path", `Project scope entry is not a relative vault path: ${entry}.`);
    }
  }
}

function projectLinkPath(projectRoot: string): string {
  return path.join(projectRoot, ".oms", "links.yaml");
}

function copyUnknown(record: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const unknown = emptyRecord();
  for (const key of Object.keys(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") fail("unknown-semantics", `Project link key ${key} cannot be preserved losslessly.`);
    if (!known.has(key)) unknown[key] = record[key];
  }
  return unknown;
}

function renderReference(connectionId: string, portableVaultId: string, scope: readonly string[], unknown: Readonly<Record<string, unknown>>): string {
  return yamlStringify({
    ...Object.fromEntries(Object.entries(unknown)),
    version: LINK_VERSION,
    connectionId,
    portableVaultId,
    scope: [...scope],
  });
}

export async function readProjectConnection(projectRoot: string): Promise<ProjectConnectionRead> {
  await assertConnectionControlPath(projectRoot, "Project root");
  const location = projectLinkPath(projectRoot);
  await assertConnectionControlTarget(location, "Project links", "absent-file");
  const bytes = await readConnectionBytes(location);
  if (bytes === undefined) return { path: location, state: "missing", digest: null };
  let parsed: unknown;
  try {
    parsed = yamlParse(connectionText(bytes));
  } catch {
    fail("malformed", `Project links are malformed: ${location}.`);
  }
  if (!isRecord(parsed) || typeof parsed["version"] !== "number") fail("malformed", `Project links are malformed: ${location}.`);
  const digest = connectionDigest(bytes);
  if (parsed["version"] === 1) {
    if (typeof parsed["vault"] !== "string" || parsed["vault"].length === 0) fail("unsupported-record", `Project v1 links require a vault path: ${location}.`);
    if (!Array.isArray(parsed["scope"]) || parsed["scope"].some(entry => typeof entry !== "string")) fail("malformed", `Project v1 scope must be a string list: ${location}.`);
    return { path: location, state: "v1", digest, pointer: { version: 1, vault: parsed["vault"], scope: parsed["scope"], bytes, digest } };
  }
  if (parsed["version"] !== LINK_VERSION) fail("unsupported-record", `Project links version is unsupported: ${location}.`);
  if ("vault" in parsed) fail("unsupported-record", `Project v2 links must not carry an absolute vault path: ${location}.`);
  if (typeof parsed["connectionId"] !== "string" || typeof parsed["portableVaultId"] !== "string" || !Array.isArray(parsed["scope"])) {
    fail("malformed", `Project v2 links require connectionId, portableVaultId, and scope: ${location}.`);
  }
  assertUuid(parsed["connectionId"], "connectionId");
  assertUuid(parsed["portableVaultId"], "portableVaultId");
  if (parsed["scope"].some(entry => typeof entry !== "string")) fail("malformed", `Project scope must contain only strings: ${location}.`);
  const scope = parsed["scope"] as string[];
  assertScope(scope);
  const unknown = copyUnknown(parsed, KNOWN_V2);
  return {
    path: location,
    state: "v2",
    digest,
    reference: { version: LINK_VERSION, connectionId: parsed["connectionId"], portableVaultId: parsed["portableVaultId"], scope, unknown, bytes, digest },
  };
}

function boundInput(input: ProjectConnectionUpdateInput, projectPath: string, registryPath: string): string {
  const fields = emptyRecord();
  fields["operation"] = "project-link";
  fields["projectPath"] = projectPath;
  fields["registryPath"] = registryPath;
  fields["connectionId"] = input.connectionId;
  fields["portableVaultId"] = input.portableVaultId;
  fields["scope"] = [...input.scope];
  fields["expectedRegistryDigest"] = input.expectedRegistryDigest;
  fields["expectedProjectDigest"] = input.expectedProjectDigest;
  fields["registryReceipt"] = receiptBinding(input.registryReceipt);
  return connectionDigest(JSON.stringify(fields));
}

function manifestFrom(value: unknown, operationId: string): ProjectManifest {
  if (!isRecord(value) || value["protocol"] !== UPDATE_PROTOCOL || value["version"] !== UPDATE_VERSION || value["phase"] !== "sealed" || value["operation"] !== "project-link" || value["operationId"] !== operationId) {
    fail("receipt-conflict", `Project connection manifest does not match ${operationId}.`);
  }
  if (typeof value["registryPath"] !== "string" || typeof value["projectPath"] !== "string" || typeof value["inputDigest"] !== "string" || typeof value["registryPostimageDigest"] !== "string" || typeof value["projectPostimage"] !== "string") {
    fail("receipt-conflict", `Project connection manifest targets are invalid: ${operationId}.`);
  }
  if (value["projectPreimage"] !== null && typeof value["projectPreimage"] !== "string") fail("receipt-conflict", `Project connection preimage is invalid: ${operationId}.`);
  if (value["globalCommitted"] !== true && value["globalCommitted"] !== false) fail("receipt-conflict", `Project connection manifest commit flag is invalid: ${operationId}.`);
  return {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    phase: "sealed",
    operationId,
    operation: "project-link",
    registryPath: value["registryPath"],
    projectPath: value["projectPath"],
    inputDigest: value["inputDigest"],
    registryPostimageDigest: value["registryPostimageDigest"],
    projectPreimage: value["projectPreimage"] as string | null,
    projectPostimage: value["projectPostimage"],
    globalCommitted: value["globalCommitted"],
  };
}

async function readManifest(directory: string, operationId: string): Promise<ProjectManifest | undefined> {
  const target = path.join(directory, "project-manifest.json");
  const bytes = await readConnectionBytes(target);
  if (bytes === undefined) return undefined;
  await assertConnectionControlTarget(target, "Project connection manifest", "file");
  return manifestFrom(JSON.parse(connectionText(bytes)) as unknown, operationId);
}

function takeFault(operationId: string, boundary: ProjectConnectionFault, armed: ProjectConnectionFault | undefined): void {
  if ((armed ?? faultArmed.get(operationId)) !== boundary) return;
  faultArmed.delete(operationId);
  fail("injected-fault", `Injected project connection fault after ${boundary} for ${operationId}.`);
}
function requireReceiptShape(receipt: ConnectionUpdateReceipt): void {
  if (!isRecord(receipt) || receipt.protocol !== UPDATE_PROTOCOL || receipt.version !== UPDATE_VERSION || receipt.operation !== "upsert" || receipt.completed !== true || receipt.atomicity !== "single-file-rename" || receipt.crossFilesystemAtomicity !== false || typeof receipt.operationId !== "string" || typeof receipt.registryPath !== "string" || typeof receipt.registryDigest !== "string" || typeof receipt.inputDigest !== "string") {
    fail("receipt-conflict", "Registry receipt is missing or is not a committed upsert receipt.");
  }
}


function receiptBinding(receipt: ConnectionUpdateReceipt): { readonly registryDigest: string; readonly operationId: string; readonly inputDigest: string } {
  return {
    registryDigest: receipt.registryDigest,
    operationId: receipt.operationId,
    inputDigest: receipt.inputDigest,
  };
}

async function requireBoundEntry(options: ConnectionRegistryOptions, connectionId: string, portableVaultId: string): Promise<{ readonly path: string; readonly digest: string; readonly localVaultPath: string }> {
  const read = await readConnectionRegistry(options);
  if (read.state !== "v2" || read.registry === undefined) fail("unsupported-record", "Project connection requires a committed v2 registry.");
  const entry = read.registry.connections.find(candidate => candidate.connectionId === connectionId);
  if (entry === undefined || entry.portableVaultId !== portableVaultId) fail("identity-conflict", `Connection ${connectionId} does not match portableVaultId ${portableVaultId}.`);
  return { path: read.path, digest: read.registry.digest, localVaultPath: entry.localVaultPath };
}

function resultFor(manifest: ProjectManifest, registryDigest: string, completedUpdate: boolean, reason?: ProjectConnectionReason): ProjectConnectionUpdateResult {
  return {
    protocol: UPDATE_PROTOCOL,
    version: UPDATE_VERSION,
    operationId: manifest.operationId,
    completed: completedUpdate,
    pendingReconciliation: !completedUpdate,
    globalCommitted: true,
    vaultWritten: false,
    crossFilesystemAtomicity: false,
    registryPath: manifest.registryPath,
    registryDigest,
    projectPath: manifest.projectPath,
    projectDigest: completedUpdate ? connectionDigest(connectionBytes(manifest.projectPostimage)) : null,
    inputDigest: manifest.inputDigest,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function publishProject(manifest: ProjectManifest): Promise<void> {
  const allowed = [manifest.projectPreimage === null ? null : connectionDigest(connectionBytes(manifest.projectPreimage)), connectionDigest(connectionBytes(manifest.projectPostimage))];
  await replaceConnectionFile(manifest.projectPath, connectionBytes(manifest.projectPostimage), allowed);
}

export async function updateProjectConnection(input: ProjectConnectionUpdateInput, options: ConnectionRegistryOptions = {}): Promise<ProjectConnectionUpdateResult> {
  requireReceiptShape(input.registryReceipt);
  assertUuid(input.connectionId, "connectionId");
  assertUuid(input.portableVaultId, "portableVaultId");
  assertScope(input.scope);
  try {
    await assertConnectionControlPath(input.projectRoot, "Project root");
    const projectPath = projectLinkPath(input.projectRoot);
    const operationId = input.operationId ?? randomUUID();
    assertUuid(operationId, "operationId");
    const registryRead = await readConnectionRegistry(options);
    const bound = boundInput(input, projectPath, registryRead.path);
    const directory = path.join(connectionRuntimeRoot(options), "connection-updates", "v1", operationId);
    await assertConnectionControlPath(directory, "Project connection update directory");
    const sealed = await readManifest(directory, operationId);
    if (sealed === undefined) await assertRegistryReceipt(input.registryReceipt, input.connectionId, input.portableVaultId, input.expectedRegistryDigest, options);
    return await withProjectLock(input.projectRoot, async () => {
      if (input.fault !== undefined) faultArmed.set(operationId, input.fault);
      if (sealed !== undefined) {
        if (sealed.inputDigest !== bound || sealed.projectPath !== projectPath || sealed.registryPath !== registryRead.path) fail("receipt-conflict", `Project connection ${operationId} is bound to another input.`);
        return resume(sealed, input, options);
      }
      const current = await readProjectConnection(input.projectRoot);
      if ((current.digest ?? "sha256:absent") !== input.expectedProjectDigest) fail("external-change", `Project links digest does not match expectedProjectDigest: ${projectPath}.`);
      if (current.state === "v1") {
        const parsed = yamlParse(connectionText(current.pointer?.bytes ?? new Uint8Array())) as Record<string, unknown>;
        if (Object.keys(parsed).some(key => !KNOWN_V1.has(key))) fail("unknown-semantics", "Unknown project v1 members block lossless conversion.");
        const entry = await requireBoundEntry(options, input.connectionId, input.portableVaultId);
        if (path.resolve(current.pointer?.vault ?? "") !== path.resolve(entry.localVaultPath)) fail("identity-conflict", "Project v1 vault path does not belong to the bound registry entry.");
      }
      const entry = await assertRegistryReceipt(input.registryReceipt, input.connectionId, input.portableVaultId, input.expectedRegistryDigest, options);
      const unknown = current.reference?.unknown ?? emptyRecord();
      const manifest: ProjectManifest = {
        protocol: UPDATE_PROTOCOL,
        version: UPDATE_VERSION,
        phase: "sealed",
        operationId,
        operation: "project-link",
        registryPath: entry.path,
        projectPath,
        inputDigest: bound,
        registryPostimageDigest: entry.digest,
        projectPreimage: current.state === "missing" ? null : connectionText(current.reference?.bytes ?? current.pointer?.bytes ?? new Uint8Array()),
        projectPostimage: renderReference(input.connectionId, input.portableVaultId, input.scope, unknown),
        globalCommitted: true,
      };
      await writeConnectionExclusive(path.join(directory, "project-manifest.json"), connectionBytes(`${JSON.stringify(manifest)}\n`));
      takeFault(operationId, "after-manifest", input.fault);
      return resume(manifest, input, options);
    });
  } catch (error) {
    asProjectError(error);
  }
}

async function resume(manifest: ProjectManifest, input: ProjectConnectionUpdateInput, options: ConnectionRegistryOptions): Promise<ProjectConnectionUpdateResult> {
  const directory = path.join(connectionRuntimeRoot(options), "connection-updates", "v1", manifest.operationId);
  const backupPath = path.join(directory, "project-preimage.bin");
  const marker = manifest.projectPreimage === null ? Uint8Array.of(0) : Uint8Array.of(1, ...connectionBytes(manifest.projectPreimage));
  const prior = await readConnectionBytes(backupPath);
  if (prior === undefined) await writeConnectionExclusive(backupPath, marker);
  else {
    await assertConnectionControlTarget(backupPath, "Project connection backup", "file");
    if (!connectionBytesEqual(prior, marker)) fail("external-change", `Project connection backup bytes differ: ${backupPath}.`);
  }
  takeFault(manifest.operationId, "after-backup", input.fault);
  if (manifest.globalCommitted !== true) fail("receipt-conflict", `Project connection ${manifest.operationId} has no committed global predecessor.`);
  const registryDigest = manifest.registryPostimageDigest;
  takeFault(manifest.operationId, "after-global-commit", input.fault);
  const confirmed = await readConnectionRegistry(options);
  if (confirmed.registry?.digest !== registryDigest) return resultFor(manifest, confirmed.registry?.digest ?? registryDigest, false, "pending-reconciliation");
  const receiptPath = path.join(directory, "project-receipt.json");
  const existingReceipt = await readConnectionBytes(receiptPath);
  const liveProject = await readConnectionBytes(manifest.projectPath);
  const liveDigest = liveProject === undefined ? null : connectionDigest(liveProject);
  if (existingReceipt !== undefined) {
    if (liveDigest !== connectionDigest(connectionBytes(manifest.projectPostimage))) return resultFor(manifest, registryDigest, false, "pending-reconciliation");
    const parsed = JSON.parse(connectionText(existingReceipt)) as ProjectConnectionUpdateResult;
    if (parsed.operationId === manifest.operationId && parsed.inputDigest === manifest.inputDigest && parsed.completed === true) return parsed;
    fail("receipt-conflict", `Project connection receipt does not match ${manifest.operationId}.`);
  }
  try {
    await publishProject(manifest);
  } catch (error) {
    if (error instanceof ProjectConnectionError || (error instanceof Error && error.name === "ConnectionRegistryError")) {
      return resultFor(manifest, registryDigest, false, "pending-reconciliation");
    }
    throw error;
  }
  const published = await readFile(manifest.projectPath);
  if (connectionDigest(published) !== connectionDigest(connectionBytes(manifest.projectPostimage))) return resultFor(manifest, registryDigest, false, "pending-reconciliation");
  takeFault(manifest.operationId, "after-project-publish", input.fault);
  takeFault(manifest.operationId, "before-receipt", input.fault);
  const result = resultFor(manifest, registryDigest, true);
  const receiptBytes = connectionBytes(`${JSON.stringify(result)}\n`);
  const raced = await readConnectionBytes(receiptPath);
  if (raced === undefined) await writeConnectionExclusive(receiptPath, receiptBytes);
  else if (!connectionBytesEqual(raced, receiptBytes)) fail("external-change", `Project connection receipt bytes differ: ${receiptPath}.`);
  return result;
}
