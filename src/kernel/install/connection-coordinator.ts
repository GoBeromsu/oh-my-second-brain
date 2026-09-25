import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import { digestBytes, hashCanonical, parseDigest, type Digest } from "../conventions/canonical.js";
import { verifyControlPath } from "../vault/paths.js";
import { parseVaultSettings, readVaultSettings, serializeVaultSettings, SETTINGS_PATH, type VaultSettings } from "../vault/settings.js";
import { publishVaultSettings } from "./vault-settings-publish.js";
import {
  connectionRegistryPath,
  type ConnectionRegistryOptions,
  type ConnectionUpdateReceipt,
  type VaultConnectionReservation,
  assertConnectionControlPath,
  assertConnectionControlTarget,
  connectionBytesEqual,
  ensureConnectionControlDirectory,
  connectionBytes,
  connectionDigest,
  connectionRuntimeRoot,
  connectionText,
  readConnectionBytes,
  readConnectionRegistry,
  reserveVaultConnection,
  upsertVaultConnection,
  writeConnectionExclusive,
} from "./connection-registry.js";
import {
  type ProjectConnectionUpdateResult,
  readProjectConnection,
  updateProjectConnection,
} from "./project-connection.js";

/** The single vault publication the coordinator performs: `.oms/settings.json` only. */
export type VaultPublicationKind = "settings-update";
export type VaultPublicationFault = "after-plan";
interface Blob { readonly digest: Digest; readonly base64: string; }
export interface VaultPublicationPlan {
  readonly version: 1;
  readonly transactionId: string;
  readonly kind: VaultPublicationKind;
  readonly vaultId: string;
  readonly targetDigest: Digest;
  readonly markerBefore: Blob | null;
  readonly outputs: readonly { readonly path: string; readonly before: Blob | null; readonly after: Blob }[];
  readonly sources: readonly { readonly path: string; readonly digest: Digest }[];
  readonly evidence: readonly { readonly name: string; readonly content: Blob }[];
  readonly planDigest: Digest;
}
export interface VaultPublicationRequest {
  readonly transactionId?: string;
  readonly kind: VaultPublicationKind;
  readonly vaultId: string;
  readonly outputs: readonly { readonly path: string; readonly expectedDigest: Digest | null; readonly content: string }[];
  readonly sources?: readonly { readonly path: string; readonly digest: Digest }[];
  readonly evidence?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}
export interface VaultPublicationReceipt {
  readonly version: 1;
  readonly transactionId: string;
  readonly kind: VaultPublicationKind;
  readonly planDigest: Digest;
  readonly status: "complete" | "rolled-back";
  readonly verified: readonly { readonly path: string; readonly digest: Digest | null }[];
}

const firedFaults = new Set<string>();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMITTED = new Set(["explicit", "vault", "bridge", "env"]);
const INTENT_PROTOCOL = "oms.connection-coordinator.v1";

export type ConnectionStageName = "vault" | "global" | "project";
export type ConnectionStageState = "not-requested" | "unattempted" | "complete" | "blocked" | "pending";
export type ConnectionCoordinatorFault =
  | "after-intent"
  | "after-vault-publication"
  | "after-reservation"
  | "after-global-upsert"
  | "after-project-publication";

export type ConnectionDiagnosticCode =
  | "invalid-input"
  | "unsafe-target"
  | "approval-mismatch"
  | "identity-missing"
  | "identity-conflict"
  | "publication-blocked"
  | "reservation-blocked"
  | "registry-pending"
  | "registry-blocked"
  | "project-blocked"
  | "project-pending"
  | "injected-fault"
  | "preparation-required"
  | "external-change";

export interface ConnectionDiagnostic {
  readonly code: ConnectionDiagnosticCode;
  readonly message: string;
  readonly stage?: ConnectionStageName;
}

export interface ConnectionStageResult<TReceipt> {
  readonly state: ConnectionStageState;
  readonly code?: ConnectionDiagnosticCode;
  readonly reason?: string;
  readonly receipt?: TReceipt;
}

export interface PrepareConnectionInput {
  /** Caller-stable UUID reused for replay of this exact operation. */
  readonly operationId: string;
  readonly target: WriteTarget;
  readonly publication: VaultPublicationRequest | null;
  /** Explicit global selection intent. False never changes an unrelated selection. */
  readonly select: boolean;
  readonly project?: { readonly root: string; readonly scope: readonly string[] };
}

export interface PreparedConnection {
  readonly operationId: string;
  readonly input: PrepareConnectionInput;
  readonly canonicalTarget: string;
  readonly registryPath: string;
  readonly runtimeRoot: string;
  readonly projectPath: string | null;
  readonly publicationPlan: VaultPublicationPlan | null;
  readonly expectedRegistryDigest: Digest | "sha256:absent" | null;
  readonly expectedEntryRevision: string | null;
  readonly expectedProjectDigest: Digest | "sha256:absent" | null;
  readonly portableVaultId: string | null;
  readonly identityPreview: { readonly state: "registered"; readonly connectionId: string } | { readonly state: "deferred-until-reservation" };
  readonly blockers: readonly ConnectionDiagnostic[];
  readonly digest: Digest;
}

export interface ConnectionCommitResult {
  readonly operationId: string;
  readonly planDigest: Digest;
  readonly reservation: VaultConnectionReservation | null;
  readonly reservationDiagnostic: ConnectionDiagnostic | null;
  readonly vault: ConnectionStageResult<VaultPublicationReceipt>;
  readonly global: ConnectionStageResult<ConnectionUpdateReceipt>;
  readonly project: ConnectionStageResult<ProjectConnectionUpdateResult>;
  readonly crossFilesystemAtomicity: false;
}

export type ConnectionResumeResult =
  | ConnectionCommitResult
  | { readonly state: "intent-absent"; readonly operationId: string }
  | { readonly state: "preparation-required"; readonly operationId: string };

export interface ResumeConnectionInput {
  readonly operationId: string;
  readonly target: WriteTarget;
}

interface ApprovalBinding {
  readonly filesystemBindingDigest: Digest;
  readonly operationId: string;
  readonly target: { readonly vault: string; readonly source: WriteTarget["source"] };
  readonly publication: {
    readonly requested: boolean;
    readonly transactionId: string | null;
    readonly kind: "schema-migration" | "contract-publication" | "settings-update" | null;
    readonly vaultId: string | null;
    readonly planDigest: Digest | null;
    readonly evidence: readonly { readonly name: string; readonly digest: Digest }[];
  };
  readonly select: boolean;
  readonly project: { readonly root: string; readonly scope: readonly string[] } | null;
  readonly canonicalTarget: string;
  readonly registryPath: string;
  readonly runtimeRoot: string;
  readonly projectPath: string | null;
  readonly expectedRegistryDigest: Digest | "sha256:absent" | null;
  readonly expectedEntryRevision: string | null;
  readonly expectedProjectDigest: Digest | "sha256:absent" | null;
  readonly portableVaultId: string | null;
  readonly identityPreview: { readonly state: "registered"; readonly connectionId: string } | { readonly state: "deferred-until-reservation" };
  readonly blockers: readonly { readonly code: ConnectionDiagnosticCode; readonly stage: ConnectionStageName }[];
}
interface ApprovedIntent {
  readonly protocol: typeof INTENT_PROTOCOL;
  readonly operationId: string;
  readonly planDigest: Digest;
  readonly canonicalTarget: string;
  readonly registryPath: string;
  readonly runtimeRoot: string;
  readonly projectRoot: string | null;
  readonly projectPath: string | null;
  readonly publicationRequested: boolean;
  readonly publicationKind: "schema-migration" | "contract-publication" | "settings-update" | null;
  readonly publicationTransactionId: string | null;
  readonly publicationPlanDigest: Digest | null;
  readonly expectedRegistryDigest: Digest | "sha256:absent" | null;
  readonly expectedEntryRevision: string | null;
  readonly expectedProjectDigest: Digest | "sha256:absent" | null;
  readonly portableVaultId: string | null;
  readonly select: boolean;
  readonly scope: readonly string[] | null;
  readonly blockers: readonly { readonly code: ConnectionDiagnosticCode; readonly stage: ConnectionStageName }[];
  /** Exact generic material(prepared). */
  readonly approvalBinding?: ApprovalBinding;
}

export interface ConnectionCoordinatorOptions extends ConnectionRegistryOptions {
  /** Test seam only. It never fabricates a receipt or skips a stage. */
  readonly coordinatorFault?: ConnectionCoordinatorFault;
  /** Native publication fault injection without bypassing its durable checks. */
  readonly publicationFault?: (point: VaultPublicationFault) => void | Promise<void>;
}

export class ConnectionCoordinatorError extends Error {
  constructor(readonly code: ConnectionDiagnosticCode, message: string) {
    super(message);
    this.name = "ConnectionCoordinatorError";
  }
}

function invalid(message: string): never {
  throw new ConnectionCoordinatorError("invalid-input", message);
}

function diagnostic(code: ConnectionDiagnosticCode, message: string): ConnectionDiagnostic {
  return { code, message };
}

function classify(error: unknown, phase: ConnectionStageName = "global"): ConnectionDiagnostic {
  if (error instanceof ConnectionCoordinatorError) return diagnostic(error.code, error.message);
  const reason = typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : undefined;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (reason === "injected-fault" || code === "injected-fault") return diagnostic("injected-fault", message);
  if (reason === "pending-reconciliation") return diagnostic("project-pending", message);
  if (reason === "external-change" || reason === "receipt-conflict") return diagnostic("external-change", message);
  if (reason === "unsupported-record") return diagnostic("registry-pending", message);
  if (reason === "stale-cas") return diagnostic("registry-blocked", message);
  if (reason === "missing-state") return diagnostic("identity-missing", message);
  if (reason === "identity-conflict") return diagnostic("identity-conflict", message);
  if (reason === "unsafe-target" || reason === "invalid-path" || code === "PUBLICATION_TARGET_UNVERIFIED") return diagnostic("unsafe-target", message);
  if (code?.startsWith("PUBLICATION_")) return diagnostic("publication-blocked", message);
  return diagnostic(phase === "vault" ? "publication-blocked" : phase === "project" ? "project-blocked" : "registry-blocked", message);
}

function stage<TReceipt>(
  state: ConnectionStageState,
  issue?: ConnectionDiagnostic,
  receipt?: TReceipt,
): ConnectionStageResult<TReceipt> {
  return {
    state,
    ...(issue === undefined ? {} : { code: issue.code, reason: issue.message }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function assertUuid(value: string, label: string): void {
  if (!ID.test(value)) invalid(`${label} must be a lowercase UUID.`);
}

function canonicalScope(scope: readonly string[]): string[] {
  if (scope.length === 0) invalid("Project scope must contain at least one relative path.");
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of scope) {
    const rel = entry.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (rel.length === 0 || path.isAbsolute(entry) || rel.split("/").includes("..") || rel.includes("\0")) {
      invalid(`Project scope entry is not a confined relative vault path: ${entry}.`);
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    normalized.push(rel);
  }
  return normalized.sort();
}

function publicationBinding(request: VaultPublicationRequest | null, plan: VaultPublicationPlan | null) {
  return {
    requested: request !== null,
    transactionId: request?.transactionId ?? null,
    kind: request?.kind ?? null,
    vaultId: request?.vaultId ?? null,
    planDigest: plan?.planDigest ?? null,
    evidence: (request?.evidence ?? []).map(item => ({ name: item.name, digest: digestBytes(item.bytes) })),
  };
}

function material(prepared: Omit<PreparedConnection, "digest">) {
  return {
    // Canonical JSON normalizes Unicode; filesystem names must retain exact bytes.
    filesystemBindingDigest: digestBytes(JSON.stringify({
      vault: prepared.canonicalTarget,
      registry: prepared.registryPath,
      runtime: prepared.runtimeRoot,
      project: prepared.input.project ?? null,
      projectPath: prepared.projectPath,
    })),
    operationId: prepared.operationId,
    target: { vault: prepared.canonicalTarget, source: prepared.input.target.source },
    publication: publicationBinding(prepared.input.publication, prepared.publicationPlan),
    select: prepared.input.select,
    project: prepared.input.project === undefined ? null : { root: prepared.input.project.root, scope: [...prepared.input.project.scope] },
    canonicalTarget: prepared.canonicalTarget,
    registryPath: prepared.registryPath,
    runtimeRoot: prepared.runtimeRoot,
    projectPath: prepared.projectPath,
    expectedRegistryDigest: prepared.expectedRegistryDigest,
    expectedEntryRevision: prepared.expectedEntryRevision,
    expectedProjectDigest: prepared.expectedProjectDigest,
    portableVaultId: prepared.portableVaultId,
    identityPreview: prepared.identityPreview,
    blockers: prepared.blockers.map(item => ({ code: item.code, stage: item.stage ?? "vault" })),
  };
}

function bind(prepared: Omit<PreparedConnection, "digest">): Digest {
  return hashCanonical("oms.connection-coordinator.prepare.v1", material(prepared));
}



async function admittedRoot(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(candidate);
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ConnectionCoordinatorError("unsafe-target", `${label} must be a real directory: ${candidate}.`);
  }
  await assertConnectionControlPath(canonical, label);
  return canonical;
}
function intentPath(runtimeRoot: string, operationId: string): string {
  return path.join(runtimeRoot, "connection-coordinator", "v1", operationId, "intent.json");
}

/** Read-only routing hint, not authority: resume must still validate the full intent. */
export async function hasConnectionIntent(operationId: string, options: ConnectionCoordinatorOptions = {}): Promise<boolean> {
  assertUuid(operationId, "operationId");
  return await readJson<ApprovedIntent>(intentPath(connectionRuntimeRoot(options), operationId), operationId) !== null;
}

async function canonicalTarget(target: WriteTarget): Promise<string> {
  if (!ADMITTED.has(target.source) || await admitWriteTarget(target) !== undefined) {
    throw new ConnectionCoordinatorError("unsafe-target", "Connection preparation requires an admitted explicit, vault, bridge, or env target.");
  }
  return admittedRoot(target.vault, "Connection target");
}

async function readActualSettings(vault: string): Promise<{ readonly settings: VaultSettings | null; readonly diagnostic: ConnectionDiagnostic | null }> {
  try {
    return { settings: await readVaultSettings(vault), diagnostic: null };
  } catch (error) {
    return { settings: null, diagnostic: classify(error, "vault") };
  }
}

async function readSettingsBytes(vault: string): Promise<Buffer | null> {
  const verified = await verifyControlPath(vault, SETTINGS_PATH, { expected: "either" });
  if (verified.targetRealPath === null) return null;
  return readFile(verified.absolutePath);
}

function blob(bytes: Uint8Array) {
  return { digest: digestBytes(bytes), base64: Buffer.from(bytes).toString("base64") };
}

/**
 * Plans the generic connection publication: exactly `.oms/settings.json` and nothing else.
 * Evidence is bound into the approval digest only; it is never stored in the vault.
 */
async function planSettingsPublication(vault: string, request: VaultPublicationRequest): Promise<VaultPublicationPlan> {
  if (request.kind !== "settings-update" || request.transactionId === undefined) throw new ConnectionCoordinatorError("publication-blocked", "Connection publication accepts only a settings-update with a transactionId.");
  const [output, ...rest] = request.outputs;
  if (output === undefined || rest.length !== 0 || output.path !== SETTINGS_PATH || (request.sources ?? []).length !== 0) {
    throw new ConnectionCoordinatorError("publication-blocked", "Connection publication writes only .oms/settings.json.");
  }
  const settings = parseVaultSettings(output.content);
  const expected = serializeVaultSettings({ version: 1, vaultId: request.vaultId });
  if (settings.vaultId !== request.vaultId || output.content !== expected) throw new ConnectionCoordinatorError("publication-blocked", "Connection settings must carry only the requested portable identity.");
  const before = await readSettingsBytes(vault);
  const after = Buffer.from(expected, "utf8");
  if (before !== null && !before.equals(after)) throw new ConnectionCoordinatorError("publication-blocked", "Existing settings differ from the proposed connection settings.");
  if (output.expectedDigest !== null && (before === null || digestBytes(before) !== output.expectedDigest)) throw new ConnectionCoordinatorError("publication-blocked", "Existing settings do not match the expected digest.");
  const evidence = (request.evidence ?? []).map(item => ({ name: item.name, content: blob(item.bytes) }));
  const targetDigest = digestBytes(vault);
  const planDigest = hashCanonical("oms.connection-coordinator.settings.v1", {
    transactionId: request.transactionId,
    kind: request.kind,
    vaultId: request.vaultId,
    targetDigest,
    after: digestBytes(after),
    evidence: evidence.map(item => ({ name: item.name, digest: item.content.digest })),
  });
  return {
    version: 1,
    transactionId: request.transactionId,
    kind: "settings-update",
    vaultId: request.vaultId,
    targetDigest,
    markerBefore: null,
    outputs: [{ path: SETTINGS_PATH, before: before === null ? null : blob(before), after: blob(after) }],
    sources: [],
    evidence,
    planDigest,
  };
}

/** Publishes approved settings through the vault settings publisher; identical existing bytes complete idempotently. */
async function commitSettingsPublication(vault: string, plan: VaultPublicationPlan, options: ConnectionCoordinatorOptions): Promise<VaultPublicationReceipt> {
  const output = plan.outputs[0];
  if (output === undefined || output.path !== SETTINGS_PATH || plan.outputs.length !== 1) throw new ConnectionCoordinatorError("publication-blocked", "Connection publication writes only .oms/settings.json.");
  const after = Buffer.from(output.after.base64, "base64");
  if (digestBytes(after) !== output.after.digest) throw new ConnectionCoordinatorError("publication-blocked", "Settings plan bytes do not match their digest.");
  const current = await readSettingsBytes(vault);
  if (current === null) {
    await options.publicationFault?.("after-plan");
    await publishVaultSettings(vault, parseVaultSettings(after.toString("utf8")));
  } else if (!current.equals(after)) {
    throw new ConnectionCoordinatorError("publication-blocked", "Settings changed since the approved preparation; they were preserved.");
  }
  const verified = await readSettingsBytes(vault);
  if (verified === null || !verified.equals(after)) throw new ConnectionCoordinatorError("publication-blocked", "Settings did not read back as approved.");
  return { version: 1, transactionId: plan.transactionId, kind: "settings-update", planDigest: plan.planDigest, status: "complete", verified: [{ path: SETTINGS_PATH, digest: digestBytes(verified) }] };
}

function settingsIdentity(plan: VaultPublicationPlan | null): string | null {
  const output = plan?.outputs.find(item => item.path === ".oms/settings.json");
  if (output === undefined) return null;
  const text = Buffer.from(output.after.base64, "base64").toString("utf8");
  return JSON.parse(text).vaultId as string;
}

export async function prepareConnection(
  input: PrepareConnectionInput,
  options: ConnectionCoordinatorOptions = {},
): Promise<PreparedConnection> {
  assertUuid(input.operationId, "operationId");
  if (input.publication !== null) {
    if (input.publication.transactionId === undefined) invalid("Publication transactionId must be supplied for repeatable preparation.");
    assertUuid(input.publication.transactionId, "publication.transactionId");
  }
  const canonical = await canonicalTarget(input.target);
  const runtimeRoot = connectionRuntimeRoot(options);
  const registryPath = options.registryPath ?? connectionRegistryPath(options.env, options.homeDir);
  const blockers: ConnectionDiagnostic[] = [];
  let registry: Awaited<ReturnType<typeof readConnectionRegistry>> | null = null;
  try {
    registry = await readConnectionRegistry(options);
  } catch (error) {
    blockers.push({ ...classify(error), stage: "global" });
  }
  let project = input.project === undefined ? undefined : { root: path.resolve(input.project.root), scope: canonicalScope(input.project.scope) };
  let projectRead: Awaited<ReturnType<typeof readProjectConnection>> | null = null;
  if (project !== undefined) {
    try {
      project = { ...project, root: await admittedRoot(project.root, "Project root") };
      projectRead = await readProjectConnection(project.root);
    } catch (error) {
      blockers.push({ ...classify(error, "project"), stage: "project" });
    }
  }
  const actual = await readActualSettings(canonical);
  let plan: VaultPublicationPlan | null = null;
  if (input.publication !== null) {
    try {
      plan = await planSettingsPublication(canonical, input.publication);
    } catch (error) {
      blockers.push({ ...classify(error, "vault"), stage: "vault" });
    }
  }
  if (actual.diagnostic !== null) blockers.push({ ...actual.diagnostic, stage: "vault" });
  const proposed = settingsIdentity(plan);
  const portableVaultId = actual.settings?.vaultId ?? proposed;
  if (actual.settings !== null && proposed !== null && actual.settings.vaultId !== proposed) {
    blockers.push({ ...diagnostic("identity-conflict", "Publication settings identity does not match the published portable vault identity."), stage: "vault" });
  }
  if (input.publication !== null && input.publication.vaultId !== (actual.settings?.vaultId ?? proposed)) {
    blockers.push({ ...diagnostic("identity-conflict", "Publication request identity does not match existing or publisher-validated settings."), stage: "vault" });
  }
  if (portableVaultId === null && input.publication === null) {
    blockers.push({ ...diagnostic("identity-missing", "Selected vault has no published portable identity and no publisher-validated settings proposal."), stage: "vault" });
  }
  const match = portableVaultId === null ? undefined : registry?.registry?.connections.find(entry => entry.localVaultPath === canonical && entry.portableVaultId === portableVaultId);
  const preview = match === undefined ? { state: "deferred-until-reservation" as const } : { state: "registered" as const, connectionId: match.connectionId };
  const registryDigest = registry === null ? null : registry.state === "missing" ? "sha256:absent" as const : registry.state === "v1"
    ? parseDigest(registry.pointer?.digest ?? invalid("v1 pointer digest is missing."))
    : parseDigest(registry.registry?.digest ?? invalid("v2 registry digest is missing."));
  const prepared = {
    operationId: input.operationId,
    input: { ...input, ...(project === undefined ? {} : { project }) },
    canonicalTarget: canonical,
    registryPath,
    runtimeRoot,
    projectPath: project === undefined ? null : path.join(project.root, ".oms", "links.yaml"),
    publicationPlan: plan,
    expectedRegistryDigest: registryDigest,
    expectedEntryRevision: match?.revision ?? null,
    expectedProjectDigest: projectRead === null ? null : projectRead.digest === null ? "sha256:absent" as const : parseDigest(projectRead.digest),
    portableVaultId,
    identityPreview: preview,
    blockers,
  };
  return { ...prepared, digest: bind(prepared) };
}

async function readJson<T>(file: string, operationId: string): Promise<T | null> {
  const bytes = await readConnectionBytes(file);
  if (bytes === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(connectionText(bytes));
  } catch {
    throw new ConnectionCoordinatorError("external-change", `Coordinator record ${operationId} is malformed.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !("protocol" in parsed) || parsed.protocol !== INTENT_PROTOCOL
    || !("operationId" in parsed) || parsed.operationId !== operationId) {
    throw new ConnectionCoordinatorError("external-change", `Coordinator record ${operationId} is bound to another operation.`);
  }
  return parsed as T;
}

async function writeIntent(file: string, value: ApprovedIntent): Promise<void> {
  await assertConnectionControlTarget(file, "Coordinator intent", "absent-file");
  const bytes = connectionBytes(`${JSON.stringify(value)}\n`);
  const existing = await readConnectionBytes(file);
  if (existing !== undefined) {
    if (!connectionBytesEqual(existing, bytes)) throw new ConnectionCoordinatorError("external-change", "The immutable coordinator intent has changed.");
    return;
  }
  await ensureConnectionControlDirectory(path.dirname(file), "Coordinator directory");
  await writeConnectionExclusive(file, bytes);
}

function takeFault(operationId: string, requested: ConnectionCoordinatorFault | undefined, boundary: ConnectionCoordinatorFault): void {
  const key = `${operationId}:${boundary}`;
  if (requested !== boundary || firedFaults.has(key)) return;
  firedFaults.add(key);
  throw new ConnectionCoordinatorError("injected-fault", `Injected coordinator fault at ${boundary}.`);
}

function approvedFrom(prepared: PreparedConnection): ApprovedIntent {
  return {
    protocol: INTENT_PROTOCOL,
    operationId: prepared.operationId,
    planDigest: prepared.digest,
    canonicalTarget: prepared.canonicalTarget,
    registryPath: prepared.registryPath,
    runtimeRoot: prepared.runtimeRoot,
    projectRoot: prepared.input.project?.root ?? null,
    projectPath: prepared.projectPath,
    publicationRequested: prepared.input.publication !== null,
    publicationKind: prepared.publicationPlan?.kind ?? prepared.input.publication?.kind ?? null,
    publicationTransactionId: prepared.publicationPlan?.transactionId ?? prepared.input.publication?.transactionId ?? null,
    publicationPlanDigest: prepared.publicationPlan?.planDigest ?? null,
    expectedRegistryDigest: prepared.expectedRegistryDigest,
    expectedEntryRevision: prepared.expectedEntryRevision,
    expectedProjectDigest: prepared.expectedProjectDigest,
    portableVaultId: prepared.portableVaultId,
    select: prepared.input.select,
    scope: prepared.input.project?.scope ?? null,
    blockers: prepared.blockers.map(item => ({ code: item.code, stage: item.stage ?? "vault" })),
    approvalBinding: material(prepared),
  };
}

function sameIntent(left: ApprovedIntent, right: ApprovedIntent): boolean {
  return connectionDigest(connectionBytes(`${JSON.stringify(left)}\n`)) === connectionDigest(connectionBytes(`${JSON.stringify(right)}\n`));
}



function boundOptions(prepared: PreparedConnection, options: ConnectionCoordinatorOptions): ConnectionCoordinatorOptions {
  const registryPath = options.registryPath ?? connectionRegistryPath(options.env, options.homeDir);
  const runtimeRoot = connectionRuntimeRoot(options);
  if (path.resolve(registryPath) !== path.resolve(prepared.registryPath) || path.resolve(runtimeRoot) !== path.resolve(prepared.runtimeRoot)) {
    throw new ConnectionCoordinatorError("external-change", "Commit storage does not match the approved preparation.");
  }
  return { ...options, registryPath: prepared.registryPath, runtimeRoot: prepared.runtimeRoot };
}

async function assertOutside(vaultRoot: string, candidate: string, label: string): Promise<void> {
  await assertConnectionControlPath(candidate, label);
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new ConnectionCoordinatorError("unsafe-target", `${label} must stay outside the selected vault.`);
  }
}





async function runConnectionStages(intent: ApprovedIntent, source: WriteTarget["source"], bound: ConnectionCoordinatorOptions, options: ConnectionCoordinatorOptions, vaultPublication: () => Promise<VaultPublicationReceipt | null>, blockers: readonly ConnectionDiagnostic[] = [], seal?: () => Promise<void>): Promise<ConnectionCommitResult> {
  const diagnostics = intent.blockers.map(saved => ({
    ...diagnostic(saved.code, blockers.find(item => item.code === saved.code && (item.stage ?? "vault") === saved.stage)?.message ?? `Approved ${saved.stage} preparation is blocked.`),
    stage: saved.stage,
  }));
  const requestedProject = intent.projectRoot !== null;
  let vault = stage<VaultPublicationReceipt>(intent.publicationRequested ? "unattempted" : "not-requested");
  let global = stage<ConnectionUpdateReceipt>("unattempted");
  let project = stage<ProjectConnectionUpdateResult>(requestedProject ? "unattempted" : "not-requested");
  let reservation: VaultConnectionReservation | null = null;
  let reservationDiagnostic: ConnectionDiagnostic | null = null;
  const result = () => commitResult(intent, reservation, vault, global, project, reservationDiagnostic);
  const blocker = diagnostics.find(item => item.stage === "vault");
  if (blocker !== undefined) {
    if (intent.publicationRequested) vault = stage("blocked", blocker);
    else global = stage("blocked", blocker);
    return result();
  }
  let phase: ConnectionStageName | "reservation" = intent.publicationRequested ? "vault" : "global";
  try {
    if (seal !== undefined) await seal();
    phase = intent.publicationRequested ? "vault" : phase;
    if (intent.publicationRequested) {
      phase = "vault";
      const receipt = await vaultPublication();
      if (receipt !== null) {
        vault = stage("complete", undefined, receipt);
        takeFault(intent.operationId, options.coordinatorFault, "after-vault-publication");
      }
    }
    const globalBlocker = diagnostics.find(item => item.stage === "global");
    if (globalBlocker !== undefined || intent.expectedRegistryDigest === null) {
      global = stage("blocked", globalBlocker ?? diagnostic("registry-blocked", "No approved global registry preimage is available."));
      return result();
    }
    phase = "reservation";
    const actual = await readActualSettings(intent.canonicalTarget);
    if (actual.settings === null || actual.settings.vaultId !== intent.portableVaultId) throw new ConnectionCoordinatorError(actual.diagnostic?.code ?? "identity-conflict", actual.diagnostic?.message ?? "Actual settings do not match the approved portable identity.");
    reservation = await reserveVaultConnection({ vault: intent.canonicalTarget, source }, bound);
    if (reservation.portableVaultId !== intent.portableVaultId) throw new ConnectionCoordinatorError("identity-conflict", "Reserved identity differs from the approved settings.");
    takeFault(intent.operationId, options.coordinatorFault, "after-reservation");
    phase = "global";
    const registry = await readConnectionRegistry(bound);
    if (registry.state === "v1") {
      const currentBytes = await readConnectionBytes(intent.registryPath);
      if (currentBytes === undefined || connectionDigest(currentBytes) !== intent.expectedRegistryDigest) {
        global = stage("pending", diagnostic("external-change", "The global v1 pointer changed since preparation; its bytes were preserved."));
        return result();
      }
      global = stage("pending", diagnostic("registry-pending", "The global v1 pointer requires separately verified migration; its vault was not changed."));
      return result();
    }
    const registryReceipt = await upsertVaultConnection({ expectedDigest: intent.expectedRegistryDigest, ...(intent.expectedEntryRevision === null ? {} : { expectedEntryRevision: intent.expectedEntryRevision }), connectionId: reservation.connectionId, portableVaultId: reservation.portableVaultId, localVaultPath: reservation.localVaultPath, select: intent.select, operationId: intent.operationId }, bound);
    if (!registryReceipt.completed) {
      global = stage(registryReceipt.pendingReconciliation ? "pending" : "blocked", diagnostic("external-change", "The native registry postimage no longer matches its completed receipt."), registryReceipt);
      return result();
    }
    global = stage("complete", undefined, registryReceipt);
    takeFault(intent.operationId, options.coordinatorFault, "after-global-upsert");
    if (!requestedProject) return result();
    phase = "project";
    const projectBlocker = diagnostics.find(item => item.stage === "project");
    if (projectBlocker !== undefined) {
      project = stage("blocked", projectBlocker);
      return result();
    }
    if (intent.projectRoot === null || intent.scope === null || intent.expectedProjectDigest === null) throw new ConnectionCoordinatorError("project-blocked", "The approved project preimage and scope are required.");
    const confirmed = await readActualSettings(intent.canonicalTarget);
    if (confirmed.settings?.vaultId !== reservation.portableVaultId) throw new ConnectionCoordinatorError("identity-conflict", "Actual settings changed before project publication.");
    const projectReceipt = await updateProjectConnection({ projectRoot: intent.projectRoot, connectionId: reservation.connectionId, portableVaultId: reservation.portableVaultId, scope: intent.scope, expectedRegistryDigest: registryReceipt.registryDigest, expectedProjectDigest: intent.expectedProjectDigest, registryReceipt, operationId: intent.operationId }, bound);
    const state = projectReceipt.completed ? "complete" : projectReceipt.pendingReconciliation ? "pending" : "blocked";
    project = stage(state, projectReceipt.completed ? undefined : diagnostic(state === "pending" ? "project-pending" : "project-blocked", projectReceipt.reason ?? "Project publication did not complete."), projectReceipt);
    if (projectReceipt.completed) takeFault(intent.operationId, options.coordinatorFault, "after-project-publication");
  } catch (error) {
    const issue = classify(error, phase === "reservation" ? "global" : phase);
    const failure = issue.code === "injected-fault" || issue.code === "external-change" || issue.code === "project-pending" ? "pending" : "blocked";
    if (phase === "vault") {
      if (vault.state === "complete") global = stage("pending", issue);
      else vault = stage(failure, issue);
    } else if (phase === "reservation") {
      reservationDiagnostic = issue;
      global = stage(failure, issue);
    } else if (phase === "global") {
      if (global.state !== "complete") global = stage(failure, issue);
      else if (requestedProject) project = stage("pending", issue);
      else global = { ...global, code: issue.code, reason: issue.message };
    } else if (project.state !== "complete") project = stage(failure, issue);
    else project = { ...project, code: issue.code, reason: issue.message };
  }
  return result();
}
function commitResult(intent: ApprovedIntent, reservation: VaultConnectionReservation | null, vault: ConnectionStageResult<VaultPublicationReceipt>, global: ConnectionStageResult<ConnectionUpdateReceipt>, project: ConnectionStageResult<ProjectConnectionUpdateResult>, reservationDiagnostic: ConnectionDiagnostic | null): ConnectionCommitResult {
  return {
    operationId: intent.operationId,
    planDigest: intent.planDigest,
    reservation,
    reservationDiagnostic,
    vault,
    global,
    project,
    crossFilesystemAtomicity: false,
  };
}

export async function commitConnection(
  prepared: PreparedConnection,
  approvedDigest: Digest,
  options: ConnectionCoordinatorOptions = {},
): Promise<ConnectionCommitResult> {
  if (approvedDigest !== prepared.digest || bind(prepared) !== prepared.digest) {
    throw new ConnectionCoordinatorError("approval-mismatch", "Approval must bind this exact prepared connection.");
  }
  const bound = boundOptions(prepared, options);
  await assertOutside(prepared.canonicalTarget, prepared.runtimeRoot, "Coordinator runtime");
  const intentFile = intentPath(prepared.runtimeRoot, prepared.operationId);
  await assertOutside(prepared.canonicalTarget, intentFile, "Coordinator intent");
  const sealed = await readJson<ApprovedIntent>(intentFile, prepared.operationId);
  const intent = approvedFrom(prepared);
  const existing = sealed;
  if (existing !== null && !sameIntent(existing, intent)) {
    throw new ConnectionCoordinatorError("external-change", "Sealed coordinator intent does not match the approved preparation.");
  }

  return runConnectionStages(intent, prepared.input.target.source, bound, options, async () => {
    if (!intent.publicationRequested) return null;
    const plan = prepared.publicationPlan;
    if (plan === null || plan.planDigest !== intent.publicationPlanDigest || plan.transactionId !== intent.publicationTransactionId) throw new ConnectionCoordinatorError("publication-blocked", "The original approved publication plan is required.");
    return commitSettingsPublication(intent.canonicalTarget, plan, options);
  }, prepared.blockers, async () => {
    if (existing !== null) return;
    await writeIntent(intentFile, intent);
    takeFault(intent.operationId, options.coordinatorFault, "after-intent");
  });
}

/** Settings-only proposal for a vault that has no portable identity yet. It invents no contract or Markdown. */
export function settingsPublicationRequest(transactionId: string, vaultId: string = randomUUID()): VaultPublicationRequest {
  assertUuid(transactionId, "transactionId");
  assertUuid(vaultId, "vaultId");
  const content = serializeVaultSettings({ version: 1, vaultId });
  return {
    transactionId,
    kind: "settings-update",
    vaultId,
    outputs: [{ path: ".oms/settings.json", expectedDigest: null, content }],
  };
}

const GENERIC_INTENT_KEYS = ["protocol", "operationId", "planDigest", "canonicalTarget", "registryPath", "runtimeRoot", "projectRoot", "projectPath", "publicationRequested", "publicationKind", "publicationTransactionId", "publicationPlanDigest", "expectedRegistryDigest", "expectedEntryRevision", "expectedProjectDigest", "portableVaultId", "select", "scope", "blockers", "approvalBinding"] as const;
const BINDING_KEYS = ["filesystemBindingDigest", "operationId", "target", "publication", "select", "project", "canonicalTarget", "registryPath", "runtimeRoot", "projectPath", "expectedRegistryDigest", "expectedEntryRevision", "expectedProjectDigest", "portableVaultId", "identityPreview", "blockers"] as const;
const PUBLICATION_BINDING_KEYS = ["requested", "transactionId", "kind", "vaultId", "planDigest", "evidence"] as const;
const DIAGNOSTIC_CODES = new Set<ConnectionDiagnosticCode>(["invalid-input", "unsafe-target", "approval-mismatch", "identity-missing", "identity-conflict", "publication-blocked", "reservation-blocked", "registry-pending", "registry-blocked", "project-blocked", "project-pending", "injected-fault", "preparation-required", "external-change"]);
const PUBLICATION_KINDS = new Set(["schema-migration", "contract-publication", "settings-update"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(`${label} keys do not match the approved shape.`);
}

function digestField(value: unknown, label: string, absent = false): Digest | "sha256:absent" | null {
  if (value === null) return null;
  if (absent && value === "sha256:absent") return value;
  if (typeof value !== "string") invalid(`${label} is not a digest.`);
  return parseDigest(value);
}

function uuidField(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ID.test(value)) invalid(`${label} must be a lowercase UUID or null.`);
  return value;
}

function genericBinding(value: unknown): ApprovalBinding {
  const binding = record(value, "Approval binding");
  exactKeys(binding, BINDING_KEYS, "Approval binding");
  const target = record(binding.target, "Approval target");
  exactKeys(target, ["vault", "source"], "Approval target");
  if (typeof target.vault !== "string" || target.vault.length === 0 || !ADMITTED.has(String(target.source))) invalid("Approval target is not admitted.");
  const publication = record(binding.publication, "Approval publication");
  exactKeys(publication, PUBLICATION_BINDING_KEYS, "Approval publication");
  if (typeof publication.requested !== "boolean") invalid("Approval publication request is invalid.");
  const kind = publication.kind === null ? null : typeof publication.kind === "string" && PUBLICATION_KINDS.has(publication.kind) ? publication.kind as ApprovalBinding["publication"]["kind"] : invalid("Approval publication kind is invalid.");
  if (!Array.isArray(publication.evidence)) invalid("Approval evidence must be an array.");
  const evidence = publication.evidence.map(item => {
    const entry = record(item, "Approval evidence");
    exactKeys(entry, ["name", "digest"], "Approval evidence");
    if (typeof entry.name !== "string" || !/^[a-z][a-z0-9.-]{0,80}$/.test(entry.name)) invalid("Approval evidence name is invalid.");
    return { name: entry.name, digest: parseDigest(String(entry.digest)) };
  });
  const project = binding.project === null ? null : record(binding.project, "Approval project");
  if (project !== null) {
    exactKeys(project, ["root", "scope"], "Approval project");
    if (typeof project.root !== "string" || !Array.isArray(project.scope) || project.scope.some(item => typeof item !== "string")) invalid("Approval project is invalid.");
  }
  const preview = record(binding.identityPreview, "Approval identity");
  if (preview.state === "deferred-until-reservation") exactKeys(preview, ["state"], "Approval identity");
  else if (preview.state === "registered" && typeof preview.connectionId === "string" && ID.test(preview.connectionId)) exactKeys(preview, ["state", "connectionId"], "Approval identity");
  else invalid("Approval identity preview is invalid.");
  if (!Array.isArray(binding.blockers)) invalid("Approval blockers must be an array.");
  const blockers = binding.blockers.map(item => {
    const entry = record(item, "Approval blocker");
    exactKeys(entry, ["code", "stage"], "Approval blocker");
    if (typeof entry.code !== "string" || !DIAGNOSTIC_CODES.has(entry.code as ConnectionDiagnosticCode) || !["vault", "global", "project"].includes(String(entry.stage))) invalid("Approval blocker is invalid.");
    return { code: entry.code as ConnectionDiagnosticCode, stage: entry.stage as ConnectionStageName };
  });
  if (typeof binding.operationId !== "string" || !ID.test(binding.operationId) || typeof binding.select !== "boolean") invalid("Approval binding identity is invalid.");
  for (const key of ["canonicalTarget", "registryPath", "runtimeRoot"] as const) if (typeof binding[key] !== "string" || binding[key].length === 0) invalid(`Approval ${key} is invalid.`);
  if (binding.projectPath !== null && typeof binding.projectPath !== "string") invalid("Approval project path is invalid.");
  if (binding.expectedEntryRevision !== null && typeof binding.expectedEntryRevision !== "string") invalid("Approval entry revision is invalid.");
  return {
    filesystemBindingDigest: parseDigest(String(binding.filesystemBindingDigest)),
    operationId: binding.operationId,
    target: { vault: target.vault, source: target.source as WriteTarget["source"] },
    publication: { requested: publication.requested, transactionId: uuidField(publication.transactionId, "publication.transactionId"), kind, vaultId: uuidField(publication.vaultId, "publication.vaultId"), planDigest: digestField(publication.planDigest, "publication.planDigest") as Digest | null, evidence },
    select: binding.select,
    project: project === null ? null : { root: project.root as string, scope: [...project.scope as string[]] },
    canonicalTarget: binding.canonicalTarget as string,
    registryPath: binding.registryPath as string,
    runtimeRoot: binding.runtimeRoot as string,
    projectPath: binding.projectPath as string | null,
    expectedRegistryDigest: digestField(binding.expectedRegistryDigest, "expectedRegistryDigest", true),
    expectedEntryRevision: binding.expectedEntryRevision as string | null,
    expectedProjectDigest: digestField(binding.expectedProjectDigest, "expectedProjectDigest", true),
    portableVaultId: uuidField(binding.portableVaultId, "portableVaultId"),
    identityPreview: preview.state === "registered" ? { state: "registered", connectionId: preview.connectionId as string } : { state: "deferred-until-reservation" },
    blockers,
  };
}

function genericIntent(value: ApprovedIntent): ApprovedIntent & { readonly approvalBinding: ApprovalBinding } {
  const intent = record(value, "Coordinator intent");
  exactKeys(intent, GENERIC_INTENT_KEYS, "Coordinator intent");
  if (intent.protocol !== INTENT_PROTOCOL) invalid("Coordinator protocol is invalid.");
  const binding = genericBinding(intent.approvalBinding);
  const kind = intent.publicationKind;
  if (kind !== null && (typeof kind !== "string" || !PUBLICATION_KINDS.has(kind))) invalid("Coordinator publication kind is invalid.");
  if (typeof intent.publicationRequested !== "boolean" || typeof intent.select !== "boolean") invalid("Coordinator flags are invalid.");
  if (intent.projectRoot !== null && typeof intent.projectRoot !== "string") invalid("Coordinator project root is invalid.");
  if (intent.projectPath !== null && typeof intent.projectPath !== "string") invalid("Coordinator project path is invalid.");
  if (intent.scope !== null && (!Array.isArray(intent.scope) || intent.scope.some(item => typeof item !== "string"))) invalid("Coordinator scope is invalid.");
  if (!Array.isArray(intent.blockers)) invalid("Coordinator blockers are invalid.");
  for (const key of ["canonicalTarget", "registryPath", "runtimeRoot"] as const) if (typeof intent[key] !== "string") invalid(`Coordinator ${key} is invalid.`);
  const parsed: ApprovedIntent & { readonly approvalBinding: ApprovalBinding } = {
    protocol: INTENT_PROTOCOL,
    operationId: uuidField(intent.operationId, "operationId") ?? invalid("operationId is required."),
    planDigest: parseDigest(String(intent.planDigest)),
    canonicalTarget: intent.canonicalTarget as string,
    registryPath: intent.registryPath as string,
    runtimeRoot: intent.runtimeRoot as string,
    projectRoot: intent.projectRoot as string | null,
    projectPath: intent.projectPath as string | null,
    publicationRequested: intent.publicationRequested,
    publicationKind: kind as ApprovedIntent["publicationKind"],
    publicationTransactionId: uuidField(intent.publicationTransactionId, "publicationTransactionId"),
    publicationPlanDigest: digestField(intent.publicationPlanDigest, "publicationPlanDigest") as Digest | null,
    expectedRegistryDigest: digestField(intent.expectedRegistryDigest, "expectedRegistryDigest", true),
    expectedEntryRevision: intent.expectedEntryRevision === null || typeof intent.expectedEntryRevision === "string" ? intent.expectedEntryRevision as string | null : invalid("Coordinator entry revision is invalid."),
    expectedProjectDigest: digestField(intent.expectedProjectDigest, "expectedProjectDigest", true),
    portableVaultId: uuidField(intent.portableVaultId, "portableVaultId"),
    select: intent.select,
    scope: intent.scope === null ? null : [...intent.scope as string[]],
    blockers: (intent.blockers as unknown[]).map(item => {
      const entry = record(item, "Coordinator blocker");
      exactKeys(entry, ["code", "stage"], "Coordinator blocker");
      if (typeof entry.code !== "string" || !DIAGNOSTIC_CODES.has(entry.code as ConnectionDiagnosticCode)) invalid("Coordinator blocker is invalid.");
      return { code: entry.code as ConnectionDiagnosticCode, stage: entry.stage as ConnectionStageName };
    }),
    approvalBinding: binding,
  };
  if (binding.operationId !== parsed.operationId || binding.target.vault !== parsed.canonicalTarget || binding.canonicalTarget !== parsed.canonicalTarget || binding.registryPath !== parsed.registryPath || binding.runtimeRoot !== parsed.runtimeRoot || binding.projectPath !== parsed.projectPath || binding.select !== parsed.select || binding.portableVaultId !== parsed.portableVaultId || binding.expectedRegistryDigest !== parsed.expectedRegistryDigest || binding.expectedEntryRevision !== parsed.expectedEntryRevision || binding.expectedProjectDigest !== parsed.expectedProjectDigest) invalid("Approval binding does not match coordinator execution fields.");
  if (binding.publication.requested !== parsed.publicationRequested || binding.publication.kind !== parsed.publicationKind || binding.publication.transactionId !== parsed.publicationTransactionId || binding.publication.planDigest !== parsed.publicationPlanDigest || binding.publication.vaultId !== (parsed.publicationRequested ? parsed.portableVaultId : binding.publication.vaultId)) invalid("Approval publication does not match coordinator execution fields.");
  if ((binding.project?.root ?? null) !== parsed.projectRoot || JSON.stringify(binding.project?.scope ?? null) !== JSON.stringify(parsed.scope) || JSON.stringify(binding.blockers) !== JSON.stringify(parsed.blockers)) invalid("Approval project or blockers do not match coordinator execution fields.");
  const filesystem = digestBytes(JSON.stringify({ vault: parsed.canonicalTarget, registry: parsed.registryPath, runtime: parsed.runtimeRoot, project: binding.project, projectPath: parsed.projectPath }));
  if (binding.filesystemBindingDigest !== filesystem) invalid("Approval filesystem binding does not match its paths.");
  if (hashCanonical("oms.connection-coordinator.prepare.v1", binding) !== parsed.planDigest) throw new ConnectionCoordinatorError("approval-mismatch", "Sealed approval binding does not recompute the original digest.");
  if (parsed.publicationKind === "schema-migration" || parsed.publicationKind === "contract-publication" || (parsed.publicationRequested && parsed.publicationKind !== "settings-update") || (!parsed.publicationRequested && parsed.publicationKind !== null)) invalid("Generic resume accepts only settings-update or no publication.");
  return parsed;
}

/** Resumes one original generic settings or no-publication intent from its sealed approval binding. */
export async function resumeConnection(input: ResumeConnectionInput, approvedDigest: Digest, options: ConnectionCoordinatorOptions = {}): Promise<ConnectionResumeResult> {
  assertUuid(input.operationId, "operationId");
  parseDigest(approvedDigest);
  const runtimeRoot = connectionRuntimeRoot(options);
  const registryPath = options.registryPath ?? connectionRegistryPath(options.env, options.homeDir);
  const file = intentPath(runtimeRoot, input.operationId);
  const raw = await readJson<ApprovedIntent>(file, input.operationId);
  if (raw === null) return { state: "intent-absent", operationId: input.operationId };
  const intent = genericIntent(raw);
  if (intent.operationId !== input.operationId || intent.planDigest !== approvedDigest) throw new ConnectionCoordinatorError("approval-mismatch", "Approval must equal the original sealed digest.");
  if (path.resolve(intent.runtimeRoot) !== path.resolve(runtimeRoot) || path.resolve(intent.registryPath) !== path.resolve(registryPath)) throw new ConnectionCoordinatorError("external-change", "Resume storage does not match the sealed approval.");
  const canonical = await canonicalTarget(input.target);
  if (canonical !== intent.canonicalTarget || input.target.source !== intent.approvalBinding.target.source) throw new ConnectionCoordinatorError("external-change", "Resume target does not match the sealed approval.");
  await assertOutside(intent.canonicalTarget, intent.runtimeRoot, "Coordinator runtime");
  await assertOutside(intent.canonicalTarget, file, "Coordinator intent");
  await assertOutside(intent.canonicalTarget, intent.registryPath, "Connection registry");
  const bound = { ...options, runtimeRoot: intent.runtimeRoot, registryPath: intent.registryPath };
  const committed = await runConnectionStages(intent, input.target.source, bound, options, async () => {
    if (!intent.publicationRequested) return null;
    const binding = intent.approvalBinding.publication;
    if (binding.kind !== "settings-update" || binding.transactionId === null || binding.vaultId === null || binding.planDigest === null || intent.publicationPlanDigest === null) throw new ConnectionCoordinatorError("publication-blocked", "The original settings publication binding is incomplete.");
    // Evidence bytes are never stored, so an evidenced approval cannot be replayed without its original preparation.
    if (binding.evidence.length !== 0) return preparationRequired(intent.operationId);
    const request = settingsPublicationRequest(binding.transactionId, binding.vaultId);
    const plan = await planSettingsPublication(intent.canonicalTarget, request);
    if (plan.planDigest !== binding.planDigest || plan.transactionId !== binding.transactionId || plan.vaultId !== binding.vaultId) return preparationRequired(intent.operationId);
    return commitSettingsPublication(intent.canonicalTarget, plan, options);
  }, intent.blockers.map(item => ({ ...item, message: `Approved ${item.stage} preparation is blocked.` })));
  if (committed.vault.code === "preparation-required") return { state: "preparation-required", operationId: intent.operationId };
  return committed;
}

function preparationRequired(operationId: string): never {
  throw new ConnectionCoordinatorError("preparation-required", `Connection ${operationId} requires its original preparation.`);
}
