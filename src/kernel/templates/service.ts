import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import {
  commitMigratedConnection,
  inspectMigratedConnection,
  prepareMigratedConnection,
  resumeMigratedConnection,
  type ConnectionCommitResult,
  type ConnectionCoordinatorOptions,
  type ConnectionStageResult,
} from "../install/connection-coordinator.js";
import { connectionRegistryPath } from "../install/connection-registry.js";
import type { LegacyEquivalenceCandidate, LegacyEquivalenceProposal } from "./legacy-equivalence.js";
import {
  legacyMigrationLocator,
  inspectLegacyVaultPublication,
  inspectPreparedLegacyMigration,
  prepareLegacyVaultMigration,
  type LegacyMigrationLocator,
  type PreparedLegacyMigration,
  type LegacyVaultPublicationAdmission,
  commitPreparedContractSourcePublication,
  commitVaultPublication,
  planVaultPublication,
  prepareContractSourcePublication,
  type VaultPublicationReceipt,
} from "./vault-publication.js";
import {
  assertConnectionControlPath,
  connectionRuntimeRoot,
  type ConnectionRegistryOptions,
  ConnectionRegistryError,
  reserveVaultConnection,
  type VaultConnectionReservation,
} from "../install/connection-registry.js";
import { parseNote } from "../conventions/frontmatter.js";
import {
  createOmsSelectionSession,
  readOmsSelectionSession,
  validateOmsSelectionSessionInput,
} from "../runtime/sessions.js";
import { MAX_TEMPLATE_SOURCE_BYTES } from "./census.js";
import { digestBytes } from "./canonical.js";
import { evaluateContractV5, type StructuralContractResult } from "./contract-check.js";
import { ContractV5Error, parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { parseLegacyJson } from "./legacy-json.js";
import { normalizeTemplateControlPath, verifyTemplateControlPath } from "./paths.js";
import {
  inspectContractSource,
  prepareContractSourceAcknowledgment,
  prepareContractSourceRelink,
  revalidateContractSelection,
  selectContractV5,
  SourceRegistryError,
  type ContractSelectionBinding,
  type ContractSourceReview,
  type ContractSourcePublicationLocator,
  type PreparedContractSourceReview,
  type SelectedContractV5,
} from "./source-registry.js";
import type { Digest } from "./types.js";
import { readVaultSettings, serializeVaultSettings, type VaultSettings } from "./vault-settings.js";

export interface ContractSelectionLocator {
  readonly connectionId: string;
  readonly sessionId: string;
}

export interface ContractMigrationRequest {
  readonly operationId: string;
  readonly transactionId: string;
  readonly vaultId: string;
}

export interface ContractServiceOptions extends Pick<ConnectionRegistryOptions, "registryPath" | "env" | "homeDir" | "runtimeRoot" | "createId"> {
  readonly sessionsRoot?: string;
  readonly coordinatorFault?: ConnectionCoordinatorOptions["coordinatorFault"];
  readonly publicationFault?: ConnectionCoordinatorOptions["publicationFault"];
}

export interface SelectContractInput {
  readonly target: WriteTarget;
  readonly notePath: string;
  readonly templateId: string | null;
  readonly headingBindings?: Readonly<Record<string, string>>;
  readonly migration?: ContractMigrationRequest;
}

export interface ContractAdmission {
  readonly status: LegacyVaultPublicationAdmission["status"];
  readonly markerPath: string | null;
  readonly reasons: readonly string[];
  readonly unavailableSources: readonly { readonly templateId: string; readonly reason: string }[];
}

export interface ContractMigrationStage {
  readonly stage: "vault" | "reservation" | "global";
  readonly state: ConnectionStageResult<unknown>["state"];
  readonly code?: string;
  readonly reason?: string;
}

export type SelectContractResult =
  | {
    readonly state: "selected";
    readonly locator: ContractSelectionLocator;
    readonly notePath: string;
    readonly selected: SelectedContractV5;
    readonly migration?: {
      readonly operationId: string;
      readonly transactionId: string;
      readonly vaultId: string;
      readonly stages: readonly ContractMigrationStage[];
      readonly sessionLimit: "session persistence and response are not one atomic receipt";
    };
  }
  | { readonly state: "review-required"; readonly admission: ContractAdmission; readonly reasons: readonly string[] }
  | { readonly state: "setup-required"; readonly admission: ContractAdmission }
  | {
    readonly state: "migration-pending";
    readonly operationId: string;
    readonly transactionId: string;
    readonly vaultId: string;
    readonly stages: readonly ContractMigrationStage[];
  };

export interface CheckContractInput {
  readonly vault: string;
  readonly locator: ContractSelectionLocator;
}

export interface CheckContractResult {
  readonly locator: ContractSelectionLocator;
  readonly notePath: string;
  readonly result: StructuralContractResult;
}

export type ContractServiceErrorCode = "SELECTION_MISSING" | "VAULT_SETTINGS_MISSING" | "SELECTION_INVALID" | "SELECTION_UNSAFE" | "NOTE_UNSAFE" | "NOTE_UNSUPPORTED";

export class ContractServiceError extends Error {
  constructor(readonly code: ContractServiceErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ContractServiceError";
  }
}

const POLICY_PATH = ".oms/template-policy.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SELECT_KEYS = new Set(["target", "notePath", "templateId", "headingBindings", "migration"]);
const MIGRATION_KEYS = new Set(["operationId", "transactionId", "vaultId"]);
const CHECK_KEYS = new Set(["vault", "locator"]);
const LOCATOR_KEYS = new Set(["connectionId", "sessionId"]);

function fail(code: ContractServiceErrorCode, message: string, cause?: unknown): never {
  throw new ContractServiceError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactOwnKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some(key => !allowed.has(key)) || Object.getOwnPropertySymbols(value).length > 0) {
    fail("SELECTION_INVALID", `${label} contains an unsupported field`);
  }
}

function assertLowercaseUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail("SELECTION_INVALID", `${label} must be a lowercase UUID`);
}

function assertSelectInput(input: SelectContractInput): void {
  if (!isRecord(input)) fail("SELECTION_INVALID", "selection input must be an object");
  exactOwnKeys(input, SELECT_KEYS, "selection input");
  if (!Object.hasOwn(input, "target") || !Object.hasOwn(input, "notePath") || !Object.hasOwn(input, "templateId")) {
    fail("SELECTION_INVALID", "selection requires an explicit target, notePath, and templateId");
  }
  if (!isRecord(input.target) || typeof input.target.vault !== "string" || typeof input.target.source !== "string") {
    fail("SELECTION_INVALID", "selection target must name an explicit vault and source");
  }
  if (input.templateId === undefined) fail("SELECTION_INVALID", "templateId must be an explicit string or null");
  if (input.templateId !== null && typeof input.templateId !== "string") fail("SELECTION_INVALID", "templateId must be an explicit string or null");
  if (typeof input.notePath !== "string") fail("SELECTION_INVALID", "notePath must be an explicit string");
  if (input.headingBindings !== undefined && !isRecord(input.headingBindings)) fail("SELECTION_INVALID", "headingBindings must be an object");
  if (input.migration !== undefined) {
    if (!isRecord(input.migration)) fail("SELECTION_INVALID", "migration must be an object");
    exactOwnKeys(input.migration, MIGRATION_KEYS, "migration");
    if (Object.keys(input.migration).length !== 3) fail("SELECTION_INVALID", "migration must contain operationId, transactionId, and vaultId");
    assertLowercaseUuid(input.migration.operationId, "operationId");
    assertLowercaseUuid(input.migration.transactionId, "transactionId");
    assertLowercaseUuid(input.migration.vaultId, "vaultId");
  }
}

function assertCheckInput(input: CheckContractInput): void {
  if (!isRecord(input)) fail("SELECTION_INVALID", "contract check must be an object");
  const keys = Object.keys(input);
  if (keys.some(key => !CHECK_KEYS.has(key)) || Object.getOwnPropertySymbols(input).length > 0) {
    fail("SELECTION_INVALID", "contract check accepts only an explicit vault and locator");
  }
  if (!Object.hasOwn(input, "vault") || !Object.hasOwn(input, "locator") || keys.length !== 2) {
    fail("SELECTION_INVALID", "contract check accepts only an explicit vault and locator");
  }
  if (typeof input.vault !== "string" || input.vault.length === 0) fail("SELECTION_INVALID", "contract check requires an explicit vault");
  if (!isRecord(input.locator)) fail("SELECTION_INVALID", "contract locator must be an object");
  exactOwnKeys(input.locator, LOCATOR_KEYS, "contract locator");
  if (Object.keys(input.locator).length !== 2) fail("SELECTION_INVALID", "contract locator must contain only connectionId and sessionId");
  assertLowercaseUuid(input.locator.connectionId, "connectionId");
  assertLowercaseUuid(input.locator.sessionId, "sessionId");
}

function assertCanonicalConnectionId(reservation: VaultConnectionReservation): void {
  if (reservation.connectionId !== reservation.connectionId.toLowerCase() || !UUID.test(reservation.connectionId)) {
    fail("SELECTION_INVALID", "existing connection identity is not canonical lowercase; refusing to normalize or create another identity");
  }
}

async function canonicalPublicRoot(vault: string): Promise<string> {
  if (typeof vault !== "string" || vault.includes("\0") || !path.isAbsolute(vault)) fail("SELECTION_INVALID", "vault must be an absolute path without NUL");
  let canonical: string;
  try {
    canonical = path.resolve(await realpath(vault));
  } catch (error) {
    if (isCode(error, "ENOENT")) fail("SELECTION_INVALID", `vault path does not exist: ${vault}`, error);
    throw error;
  }
  const stat = await lstat(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("SELECTION_UNSAFE", `canonical vault must be a real directory: ${canonical}`);
  return canonical;
}

async function requireSettings(vault: string): Promise<VaultSettings> {
  const settings = await readVaultSettings(vault);
  if (settings === null) fail("VAULT_SETTINGS_MISSING", "selected vault has no published settings");
  if (!UUID.test(settings.vaultId)) fail("SELECTION_INVALID", "published vaultId is not a lowercase UUID");
  return settings;
}

async function readActualPolicy(vault: string): Promise<ContractPolicyV5> {
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(POLICY_PATH), { expected: "either" });
  if (verified.targetRealPath === null) fail("SELECTION_UNSAFE", "approved V5 policy is absent");
  const observed = await readNoFollow(verified.absolutePath, verified.vaultRoot, MAX_TEMPLATE_SOURCE_BYTES, "approved policy");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes);
  } catch (error) {
    fail("SELECTION_UNSAFE", "approved policy is not valid UTF-8", error);
  }
  return parseContractPolicyV5(unambiguousPolicyValue(text));
}

function unambiguousPolicyValue(text: string): unknown {
  let parsed: ReturnType<typeof parseLegacyJson>;
  try { parsed = parseLegacyJson(text); }
  catch { throw new ContractV5Error("CONTRACT_POLICY_INVALID", "Policy must be valid JSON."); }
  if (parsed.members !== "unique") throw new ContractV5Error("CONTRACT_POLICY_INVALID", "Policy JSON members are ambiguous or cannot be inspected.");
  return parsed.value;
}

function resolveRuntime(options: ContractServiceOptions): { readonly runtimeRoot: string; readonly sessionsRoot: string; readonly bound: ConnectionRegistryOptions } {
  const runtimeRoot = connectionRuntimeRoot(options);
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot) || runtimeRoot.includes("\0")) {
    fail("SELECTION_INVALID", "runtime root must be an absolute path without NUL");
  }
  const sessionsRoot = options.sessionsRoot ?? path.join(runtimeRoot, "sessions", "v1");
  if (typeof sessionsRoot !== "string" || !path.isAbsolute(sessionsRoot) || sessionsRoot.includes("\0")) {
    fail("SELECTION_INVALID", "sessionsRoot override must be an explicit absolute path");
  }
  return {
    runtimeRoot,
    sessionsRoot,
    bound: {
      registryPath: options.registryPath,
      env: options.env,
      homeDir: options.homeDir,
      runtimeRoot,
    },
  };
}

async function assertExternalRoot(candidate: string, vaultRoot: string, label: string): Promise<void> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) fail("SELECTION_INVALID", `${label} must be an absolute path without NUL`);
  try {
    await assertConnectionControlPath(path.resolve(candidate), label);
  } catch (error) {
    if (error instanceof ConnectionRegistryError) fail("SELECTION_UNSAFE", error.message, error);
    throw error;
  }
  const resolved = path.resolve(candidate);
  if (contained(vaultRoot, resolved) || contained(resolved, vaultRoot)) {
    fail("SELECTION_UNSAFE", `${label} must stay outside the selected vault`);
  }
}

async function readNoFollow(absolutePath: string, vaultRoot: string, limit: number, label: string): Promise<{ readonly bytes: Uint8Array }> {
  if (!contained(vaultRoot, absolutePath)) fail("NOTE_UNSAFE", `${label} escapes the vault`);
  const ancestors = await observedAncestors(absolutePath, vaultRoot, label);
  const before = ancestors[ancestors.length - 1];
  if (before === undefined || !before.stat.isFile() || before.stat.isSymbolicLink() || before.stat.isFIFO() || before.stat.nlink !== 1) {
    fail("NOTE_UNSAFE", `${label} must be one regular file`);
  }
  if (!Number.isSafeInteger(before.stat.size) || before.stat.size > limit) fail("NOTE_UNSAFE", `${label} exceeds the supported read limit`);
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ELOOP") || isCode(error, "EPERM") || isCode(error, "EACCES")) fail("NOTE_UNSAFE", `${label} could not be opened safely`, error);
    fail("SELECTION_UNSAFE", `${label} could not be opened safely`, error);
  }
  try {
    const opened = await handle.stat();
    if (!stableFile(before.stat, opened)) fail("NOTE_UNSAFE", `${label} changed before reading`);
    const buffer = Buffer.alloc(opened.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) fail("SELECTION_UNSAFE", `${label} returned an invalid byte count`);
      total += bytesRead;
    }
    const after = await handle.stat();
    let pathAfter: Stats;
    try {
      pathAfter = await lstat(absolutePath);
    } catch (error) {
      fail("NOTE_UNSAFE", `${label} disappeared while reading`, error);
    }
    if (!stableFile(opened, after) || !stableFile(before.stat, pathAfter) || total !== opened.size || after.size !== opened.size || pathAfter.size !== opened.size) {
      fail("NOTE_UNSAFE", `${label} exceeds the supported read limit or changed while reading`);
    }
    await assertAncestorsUnchanged(ancestors, label);
    const real = await realpath(absolutePath);
    if (!contained(vaultRoot, path.resolve(real))) fail("NOTE_UNSAFE", `${label} escaped the vault while reading`);
    return { bytes: Uint8Array.from(buffer.subarray(0, total)) };
  } finally {
    await handle.close();
  }
}

async function observedAncestors(absolutePath: string, vaultRoot: string, label: string): Promise<readonly { readonly current: string; readonly stat: Stats }[]> {
  const relative = path.relative(vaultRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("NOTE_UNSAFE", `${label} escapes the vault`);
  const observed: { current: string; stat: Stats }[] = [];
  let current = vaultRoot;
  const rootStat = await lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("NOTE_UNSAFE", `${label} vault root is not a real directory`);
  observed.push({ current, stat: rootStat });
  for (const segment of relative.split(path.sep).filter(part => part.length > 0)) {
    if (segment === "." || segment === "..") fail("NOTE_UNSAFE", `${label} contains a parent segment`);
    current = path.resolve(current, segment);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isCode(error, "ENOENT")) fail("NOTE_UNSAFE", `${label} is missing`, error);
      fail("SELECTION_UNSAFE", `${label} could not be observed`, error);
    }
    if (stat.isSymbolicLink()) fail("NOTE_UNSAFE", `${label} follows a symlink`);
    if (current !== absolutePath && !stat.isDirectory()) fail("NOTE_UNSAFE", `${label} ancestor is not a directory`);
    if (stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) fail("NOTE_UNSAFE", `${label} is not a regular file`);
    observed.push({ current, stat });
  }
  return observed;
}

async function assertAncestorsUnchanged(ancestors: readonly { readonly current: string; readonly stat: Stats }[], label: string): Promise<void> {
  for (const ancestor of ancestors.slice(0, -1)) {
    let stat: Stats;
    try {
      stat = await lstat(ancestor.current);
    } catch (error) {
      fail("NOTE_UNSAFE", `${label} ancestor changed while reading`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== ancestor.stat.dev || stat.ino !== ancestor.stat.ino) {
      fail("NOTE_UNSAFE", `${label} ancestor changed while reading`);
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1;
}
function stableFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && !right.isSymbolicLink() && !right.isFIFO() && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readSavedNote(vaultRoot: string, notePath: string): Promise<{ readonly frontmatter: Readonly<Record<string, unknown>>; readonly body: string }> {
  const absolute = path.resolve(vaultRoot, notePath);
  if (!contained(vaultRoot, absolute)) fail("NOTE_UNSAFE", "persisted note path escapes the vault");
  const observed = await readNoFollow(absolute, vaultRoot, MAX_TEMPLATE_SOURCE_BYTES, "saved note");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes);
  } catch (error) {
    fail("NOTE_UNSAFE", "saved note is not valid UTF-8", error);
  }
  const parsed = parseNote(text);
  if (parsed.diagnostics.length > 0) fail("NOTE_UNSUPPORTED", parsed.diagnostics.map(item => item.message).join("; "));
  return { frontmatter: parsed.frontmatter, body: parsed.body };
}
function admissionOf(admission: LegacyVaultPublicationAdmission): ContractAdmission {
  return { status: admission.status, markerPath: admission.markerPath, reasons: [...admission.reasons], unavailableSources: admission.unavailableSources.map(item => ({ templateId: item.templateId, reason: item.reason })) };
}

function review(admission: LegacyVaultPublicationAdmission, proposal?: LegacyEquivalenceProposal): Extract<SelectContractResult, { state: "review-required" }> {
  const reasons = [...new Set([
    ...admission.reasons,
    ...(proposal?.decoding.reasons ?? []),
    ...(proposal?.decoding.inventory.filter(item => item.disposition === "review-required").map(item => `${item.path}: ${item.reason}`) ?? []),
    ...(proposal?.unavailableHistoricalSources.map(item => item.reason) ?? []),
  ])];
  if (reasons.length === 0) reasons.push("Historical contract equivalence was not proved; explicit contract review is required.");
  const bounded = reasons.slice(0, 16).map(reason => reason.length <= 512 ? reason : `${reason.slice(0, 509)}...`);
  if (reasons.length > 16) bounded.push(`${reasons.length - 16} additional review reasons omitted.`);
  return { state: "review-required", admission: admissionOf(admission), reasons: bounded };
}

function stageOf(stage: "vault" | "global", value: ConnectionStageResult<unknown>): ContractMigrationStage {
  return { stage, state: value.state, ...(value.code === undefined ? {} : { code: value.code }), ...(value.reason === undefined ? {} : { reason: value.reason }) };
}

function reservationStage(committed: ConnectionCommitResult): ContractMigrationStage {
  const issue = committed.reservationDiagnostic;
  if (committed.vault.state !== "complete") return { stage: "reservation", state: "unattempted", ...(issue === null ? {} : { code: issue.code, reason: issue.message }) };
  if (committed.reservation !== null) return { stage: "reservation", state: "complete", ...(issue === null ? {} : { code: issue.code, reason: issue.message }) };
  return { stage: "reservation", state: issue === null ? "unattempted" : "pending", ...(issue === null ? {} : { code: issue.code, reason: issue.message }) };
}

function stagesOf(committed: ConnectionCommitResult): readonly ContractMigrationStage[] {
  return [stageOf("vault", committed.vault), reservationStage(committed), stageOf("global", committed.global)];
}

function sameLocator(left: LegacyMigrationLocator, right: Pick<LegacyMigrationLocator, "transactionId" | "vaultId">): boolean {
  return left.transactionId === right.transactionId && left.vaultId === right.vaultId;
}

function fullLocator(left: LegacyMigrationLocator, right: LegacyMigrationLocator): boolean {
  return left.kind === right.kind && left.transactionId === right.transactionId && left.vaultId === right.vaultId && left.targetDigest === right.targetDigest && left.planDigest === right.planDigest;
}

function sameBinding(left: ContractSelectionBinding, right: ContractSelectionBinding): boolean {
  return left.templateId === right.templateId && left.policyRevision === right.policyRevision && left.contractDigest === right.contractDigest && left.sourceIdentity === right.sourceIdentity && left.sourcePath === right.sourcePath && left.sourceDigest === right.sourceDigest && JSON.stringify(left.headingBindings) === JSON.stringify(right.headingBindings);
}

function coordinatorOptions(options: ContractServiceOptions, runtimeRoot: string): ConnectionCoordinatorOptions {
  return {
    registryPath: options.registryPath,
    env: options.env,
    homeDir: options.homeDir,
    runtimeRoot,
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.coordinatorFault === undefined ? {} : { coordinatorFault: options.coordinatorFault }),
    ...(options.publicationFault === undefined ? {} : { publicationFault: options.publicationFault }),
  };
}

type PolicyObservation = { readonly state: "absent" } | { readonly state: "v5"; readonly policy: ContractPolicyV5 } | { readonly state: "legacy" } | { readonly state: "malformed"; readonly reason: string };

async function observePolicy(vault: string): Promise<PolicyObservation> {
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(POLICY_PATH), { expected: "either" });
  if (verified.targetRealPath === null) return { state: "absent" };
  const observed = await readNoFollow(verified.absolutePath, verified.vaultRoot, MAX_TEMPLATE_SOURCE_BYTES, "approved policy");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes); }
  catch { return { state: "malformed", reason: "policy is not valid UTF-8" }; }
  let value: unknown;
  try { value = unambiguousPolicyValue(text); }
  catch (error) { return { state: "malformed", reason: error instanceof Error ? error.message : "policy is not unambiguous JSON" }; }
  const version = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined;
  if (version === 3 || version === 4) return { state: "legacy" };
  if (version !== 5) return { state: "malformed", reason: "policy version is not published V5" };
  try { return { state: "v5", policy: parseContractPolicyV5(value) }; }
  catch (error) { return { state: "malformed", reason: error instanceof Error ? error.message : "published policy is malformed" }; }
}

function migrationRequest(migration: ContractMigrationRequest): { readonly transactionId: string; readonly vaultId: string } {
  return { transactionId: migration.transactionId, vaultId: migration.vaultId };
}

async function freshPreparation(target: WriteTarget, migration: ContractMigrationRequest, settingsPresent: boolean): Promise<Awaited<ReturnType<typeof prepareLegacyVaultMigration>>> {
  const request = migrationRequest(migration);
  return prepareLegacyVaultMigration(target, settingsPresent ? request : { ...request, missingSettings: { content: serializeVaultSettings({ version: 1, vaultId: migration.vaultId, templateRoots: [] }) } });
}

export async function selectContract(input: SelectContractInput, options: ContractServiceOptions = {}): Promise<SelectContractResult> {
  assertSelectInput(input);
  const resolved = resolveRuntime(options);
  const admitted = await admitWriteTarget(input.target);
  if (admitted !== undefined) fail("SELECTION_INVALID", admitted.message);
  const vault = await canonicalPublicRoot(input.target.vault);
  await assertExternalRoot(resolved.runtimeRoot, vault, "runtime root");
  await assertExternalRoot(resolved.sessionsRoot, vault, "sessions root");
  const registryPath = options.registryPath ?? connectionRegistryPath(options.env, options.homeDir);
  await assertExternalRoot(registryPath, vault, "connection registry");
  const migration = input.migration;
  const bound = coordinatorOptions(options, resolved.runtimeRoot);
  if (migration !== undefined && await inspectMigratedConnection({ operationId: migration.operationId, target: input.target }, bound) !== null) {
    return resumeSelection(input, migration, vault, resolved, options);
  }
  const admission = await inspectLegacyVaultPublication(input.target);
  if (!["absent", "publisher-marker", "verified"].includes(admission.status)) return review(admission);
  const observed = await observePolicy(vault);
  const settings = await readVaultSettings(vault);
  if (observed.state === "malformed") return review({ status: "legacy-invalid", markerPath: POLICY_PATH, reasons: [observed.reason], unavailableSources: [] });
  if (observed.state === "v5" && settings !== null) return selectPublished(input, vault, settings, observed.policy, resolved);
  if (observed.state === "v5" || observed.state === "absent") return { state: "setup-required", admission: { ...admissionOf(admission), reasons: [observed.state === "v5" ? "published controls have no portable settings" : "no published contract controls"] } };
  if (admission.status !== "verified") return review(admission);
  if (migration === undefined) return { state: "review-required", admission: admissionOf(admission), reasons: ["Stable migration operation, transaction, and vault IDs are required before selecting a historical contract."] };
  return migrateSelection(input, migration, vault, resolved, options, settings !== null);
}

async function selectPublished(input: SelectContractInput, vault: string, settings: VaultSettings, policy: ContractPolicyV5, resolved: ReturnType<typeof resolveRuntime>): Promise<Extract<SelectContractResult, { state: "selected" }>> {
  const selected = await selectContractV5(vault, policy, input.templateId, input.headingBindings);
  validateOmsSelectionSessionInput({ notePath: input.notePath, selection: selected.binding });
  const reservation = await reserveVaultConnection({ vault, source: input.target.source }, resolved.bound);
  if (reservation.localVaultPath !== vault || reservation.portableVaultId !== settings.vaultId) {
    fail("SELECTION_UNSAFE", "reserved identity does not match the actual vault root and published settings");
  }
  assertCanonicalConnectionId(reservation);
  const current = await requireSettings(vault);
  if (current.vaultId !== settings.vaultId) fail("SELECTION_UNSAFE", "published vault identity changed during selection");
  const session = await createOmsSelectionSession(
    { notePath: input.notePath, selection: selected.binding },
    { sessionsRoot: resolved.sessionsRoot, vaultPath: vault, connectionId: reservation.connectionId, vaultId: reservation.portableVaultId },
  );
  if (session.connectionId !== reservation.connectionId || session.vaultId !== reservation.portableVaultId || session.notePath !== input.notePath) {
    fail("SELECTION_UNSAFE", "stored selection does not match the reserved identity");
  }
  return { state: "selected", locator: { connectionId: session.connectionId, sessionId: session.sessionId }, notePath: session.notePath, selected };
}
async function resumeSelection(input: SelectContractInput, migration: ContractMigrationRequest, vault: string, resolved: ReturnType<typeof resolveRuntime>, options: ContractServiceOptions): Promise<SelectContractResult> {
  const bound = coordinatorOptions(options, resolved.runtimeRoot);
  const locator = await inspectMigratedConnection({ operationId: migration.operationId, target: input.target }, bound);
  if (locator === null) fail("SELECTION_UNSAFE", "migration intent disappeared before resume");
  if (!sameLocator(locator, migration)) fail("SELECTION_INVALID", "sealed migration locator does not match the requested transaction or vault");
  const inspected = await inspectPreparedLegacyMigration(input.target, locator);
  let selected: SelectedContractV5;
  let publication: PreparedLegacyMigration | undefined;
  if (inspected.state === "sealed") {
    const candidate = await validatedCandidate(vault, input, inspected.policy);
    if ("state" in candidate) return candidate;
    selected = candidate;
  } else {
    const prepared = await freshPreparation(input.target, migration, await readVaultSettings(vault) !== null);
    if (prepared.state !== "prepared") return prepared.state === "setup-required" ? { state: "setup-required", admission: admissionOf(prepared.admission) } : review(prepared.admission, prepared.state === "review-required" ? prepared.proposal : undefined);
    if (!fullLocator(legacyMigrationLocator(prepared.publication), locator)) fail("SELECTION_UNSAFE", "fresh migration capability does not match the original locator");
    const candidate = await validatedCandidate(vault, input, prepared.policy);
    if ("state" in candidate) return candidate;
    selected = candidate;
    publication = prepared.publication;
  }
  const resumed = await resumeMigratedConnection({ operationId: migration.operationId, target: input.target, expectedMigration: locator, ...(publication === undefined ? {} : { publication }) }, bound);
  if ("state" in resumed) return pending(migration, [{ stage: "vault", state: "pending", code: "preparation-required", reason: "original native plan is not sealed" }]);
  return finishMigration(input, migration, vault, resolved, resumed, selected.binding);
}

async function migrateSelection(input: SelectContractInput, migration: ContractMigrationRequest, vault: string, resolved: ReturnType<typeof resolveRuntime>, options: ContractServiceOptions, settingsPresent: boolean): Promise<SelectContractResult> {
  const prepared = await freshPreparation(input.target, migration, settingsPresent);
  if (prepared.state !== "prepared") return prepared.state === "setup-required" ? { state: "setup-required", admission: admissionOf(prepared.admission) } : review(prepared.admission, prepared.proposal);
  const locator = legacyMigrationLocator(prepared.publication);
  if (!sameLocator(locator, migration)) fail("SELECTION_UNSAFE", "prepared migration does not match the requested transaction or vault");
  const candidate = await validatedCandidate(vault, input, prepared.policy);
  if ("state" in candidate) return candidate;
  const committed = await commitMigratedConnection(await prepareMigratedConnection({ operationId: migration.operationId, target: input.target, publication: prepared.publication, select: false }, coordinatorOptions(options, resolved.runtimeRoot)), prepared.publication, coordinatorOptions(options, resolved.runtimeRoot));
  if ("state" in committed) return pending(migration, [{ stage: "vault", state: "pending", code: "preparation-required", reason: "original native plan is not sealed" }]);
  return finishMigration(input, migration, vault, resolved, committed, candidate.binding);
}

async function validatedCandidate(vault: string, input: SelectContractInput, candidate: LegacyEquivalenceCandidate): Promise<SelectedContractV5 | Extract<SelectContractResult, { state: "review-required" }>> {
  try {

    const selected = await selectContractV5(vault, candidate.policy, input.templateId, input.headingBindings);
    validateOmsSelectionSessionInput({ notePath: input.notePath, selection: selected.binding });
    return selected;
  } catch (error) {
    if (!(error instanceof ContractV5Error) && !(error instanceof SourceRegistryError) && !(error instanceof ContractServiceError)) throw error;
    return { state: "review-required", admission: { status: "legacy-invalid", markerPath: null, reasons: [error.message], unavailableSources: [] }, reasons: [error.message] };
  }
}

function pending(migration: ContractMigrationRequest, stages: readonly ContractMigrationStage[]): Extract<SelectContractResult, { state: "migration-pending" }> {
  return { state: "migration-pending", operationId: migration.operationId, transactionId: migration.transactionId, vaultId: migration.vaultId, stages };
}

function acceptable(committed: ConnectionCommitResult): boolean {
  if (committed.vault.state !== "complete" || committed.vault.receipt?.status !== "complete" || committed.reservation === null) return false;
  if (committed.global.state === "complete") return true;
  return committed.global.state === "pending" && committed.global.code === "registry-pending";
}

async function finishMigration(input: SelectContractInput, migration: ContractMigrationRequest, vault: string, resolved: ReturnType<typeof resolveRuntime>, committed: ConnectionCommitResult, binding: ContractSelectionBinding): Promise<SelectContractResult> {
  if (committed.vault.receipt !== undefined && committed.vault.receipt.transactionId !== migration.transactionId) return pending(migration, stagesOf(committed));
  if (!acceptable(committed)) return pending(migration, stagesOf(committed));
  const settings = await readVaultSettings(vault);
  if (settings === null || settings.vaultId !== migration.vaultId || committed.reservation?.portableVaultId !== settings.vaultId || committed.reservation.localVaultPath !== vault) {
    return pending(migration, stagesOf(committed));
  }
  const observed = await observePolicy(vault);
  if (observed.state !== "v5") return pending(migration, stagesOf(committed));
  let confirmed: SelectedContractV5;
  try { confirmed = await revalidateContractSelection(vault, observed.policy, binding); }
  catch { return pending(migration, [...stagesOf(committed), { stage: "vault", state: "pending", code: "external-change", reason: "published policy or source drifted from the preselected binding" }]); }
  if (!sameBinding(confirmed.binding, binding)) return pending(migration, stagesOf(committed));
  const session = await createOmsSelectionSession(
    { notePath: input.notePath, selection: confirmed.binding },
    { sessionsRoot: resolved.sessionsRoot, vaultPath: vault, connectionId: committed.reservation.connectionId, vaultId: committed.reservation.portableVaultId },
  );
  return {
    state: "selected",
    locator: { connectionId: session.connectionId, sessionId: session.sessionId },
    notePath: session.notePath,
    selected: confirmed,
    migration: { operationId: migration.operationId, transactionId: migration.transactionId, vaultId: migration.vaultId, stages: stagesOf(committed), sessionLimit: "session persistence and response are not one atomic receipt" },
  };
}

export async function checkContract(input: CheckContractInput, options: ContractServiceOptions = {}): Promise<CheckContractResult> {
  assertCheckInput(input);
  const vault = await canonicalPublicRoot(input.vault);
  const resolved = resolveRuntime(options);
  await assertExternalRoot(resolved.sessionsRoot, vault, "sessions root");
  const settings = await requireSettings(vault);
  const session = await readOmsSelectionSession(input.locator.sessionId, {
    sessionsRoot: resolved.sessionsRoot,
    vaultPath: vault,
    connectionId: input.locator.connectionId,
    vaultId: settings.vaultId,
  });
  if (session === null) fail("SELECTION_MISSING", "selection session is missing");
  if (session.connectionId !== input.locator.connectionId || session.sessionId !== input.locator.sessionId) {
    fail("SELECTION_INVALID", "stored selection does not match its locator");
  }
  const policy = await readActualPolicy(vault);
  const selected = await revalidateContractSelection(vault, policy, session.selection);
  const note = await readSavedNote(vault, session.notePath);
  const currentSettings = await requireSettings(vault);
  if (currentSettings.vaultId !== settings.vaultId) fail("SELECTION_UNSAFE", "published vault identity changed during check");
  const currentPolicy = await readActualPolicy(vault);
  const confirmed = await revalidateContractSelection(vault, currentPolicy, session.selection);
  if (confirmed.binding.contractDigest !== selected.binding.contractDigest || confirmed.binding.sourceDigest !== selected.binding.sourceDigest || confirmed.binding.sourceIdentity !== selected.binding.sourceIdentity || confirmed.binding.sourcePath !== selected.binding.sourcePath) {
    fail("SELECTION_UNSAFE", "observed contract or source changed between revalidation and note capture");
  }
  return {
    locator: { connectionId: session.connectionId, sessionId: session.sessionId },
    notePath: session.notePath,
    result: evaluateContractV5(note.frontmatter, note.body, confirmed.contract, session.selection.headingBindings),
  };
}


/** One registration's review facts. Source text never leaves the review call. */
export interface ContractSourceReviewFacts {
  readonly templateId: string;
  readonly sourceIdentity: string;
  readonly path: string;
  readonly approvedDigest: Digest;
  readonly currentDigest: Digest | null;
  readonly state: ContractSourceReview["state"];
}

export interface ContractSourceReviewResult {
  readonly vault: string;
  readonly revision: number;
  readonly reviews: readonly ContractSourceReviewFacts[];
  readonly held: readonly { readonly templateId: string; readonly reasons: readonly string[] }[];
}

export type ContractSourceCommitResult =
  | { readonly state: "confirmation-required"; readonly review: ContractSourceReviewFacts }
  | { readonly state: "published"; readonly templateId: string; readonly revision: number; readonly receipt: VaultPublicationReceipt };

function reviewFacts(review: ContractSourceReview): ContractSourceReviewFacts {
  return {
    templateId: review.templateId,
    sourceIdentity: review.sourceIdentity,
    path: review.path,
    approvedDigest: review.approvedDigest,
    currentDigest: review.currentDigest,
    state: review.state,
  };
}

async function reviewTarget(target: WriteTarget): Promise<{ readonly vault: string; readonly policy: ContractPolicyV5 }> {
  const admitted = await admitWriteTarget(target);
  if (admitted !== undefined) fail("SELECTION_INVALID", admitted.message);
  const vault = await canonicalPublicRoot(target.vault);
  return { vault, policy: await readActualPolicy(vault) };
}

/**
 * Read-only source review for the published contract. It reports drift, missing,
 * and unreadable registrations without acknowledging or relinking anything.
 */
export async function reviewContractSources(input: {
  readonly target: WriteTarget;
  readonly templateId?: string;
}): Promise<ContractSourceReviewResult> {
  const { vault, policy } = await reviewTarget(input.target);
  if (input.templateId !== undefined && typeof input.templateId !== "string") fail("SELECTION_INVALID", "templateId must be an explicit string");
  const held: { templateId: string; reasons: readonly string[] }[] = [];
  const reviews: ContractSourceReviewFacts[] = [];
  for (const [templateId, entry] of Object.entries(policy.templates)) {
    if (input.templateId !== undefined && templateId !== input.templateId) continue;
    if (entry.status !== "active") {
      held.push({ templateId, reasons: entry.reasons });
      continue;
    }
    reviews.push(reviewFacts(await inspectContractSource(vault, policy, templateId)));
  }
  if (input.templateId !== undefined && reviews.length === 0 && held.length === 0) {
    throw new ContractV5Error("CONTRACT_UNKNOWN_TEMPLATE", `Unknown registered template '${input.templateId}'.`);
  }
  return { vault, revision: policy.revision, reviews, held };
}

async function publishSourceChange(
  vault: string,
  target: WriteTarget,
  locator: ContractSourcePublicationLocator,
  prepared: PreparedContractSourceReview,
  revision: number,
): Promise<ContractSourceCommitResult> {
  const publication = await prepareContractSourcePublication({ vault, source: target.source }, locator, prepared.preparation);
  const receipt = await commitPreparedContractSourcePublication({ vault, source: target.source }, publication);
  return { state: "published", templateId: locator.templateId, revision: revision + 1, receipt };
}

/**
 * Acknowledges reviewed source bytes: the SHA advances, the contract rules do
 * not. Confirmation is required and the caller's observed digest must still be
 * the live one, so a stale confirmation cannot publish a later change.
 */
export async function acknowledgeContractSource(input: {
  readonly target: WriteTarget;
  readonly templateId: string;
  readonly reviewedDigest: string;
  readonly transactionId: string;
  readonly confirmed: boolean;
}): Promise<ContractSourceCommitResult> {
  const { vault, policy } = await reviewTarget(input.target);
  assertLowercaseUuid(input.transactionId, "transactionId");
  const review = await inspectContractSource(vault, policy, input.templateId);
  if (review.currentDigest !== input.reviewedDigest) {
    throw new SourceRegistryError("SOURCE_DRIFT", "The reviewed digest is not the live source digest; review the current bytes again.");
  }
  if (input.confirmed !== true) return { state: "confirmation-required", review: reviewFacts(review) };
  const locator = { transactionId: input.transactionId, kind: "source-review" as const, templateId: input.templateId };
  const prepared = await prepareContractSourceAcknowledgment(vault, serializeContractPolicyV5(policy), locator);
  return publishSourceChange(vault, input.target, locator, prepared, policy.revision);
}

/**
 * Relocates a registration to an explicitly named candidate path. The original
 * source must be genuinely missing and the candidate must already carry the
 * registered bytes; SHA equality is evidence, never permission.
 */
export async function relinkContractSource(input: {
  readonly target: WriteTarget;
  readonly templateId: string;
  readonly candidatePath: string;
  readonly transactionId: string;
  readonly confirmed: boolean;
}): Promise<ContractSourceCommitResult> {
  const { vault, policy } = await reviewTarget(input.target);
  assertLowercaseUuid(input.transactionId, "transactionId");
  if (typeof input.candidatePath !== "string" || input.candidatePath.length === 0) fail("SELECTION_INVALID", "candidatePath must be an explicit vault-relative path");
  const review = await inspectContractSource(vault, policy, input.templateId);
  if (input.confirmed !== true) return { state: "confirmation-required", review: reviewFacts(review) };
  const locator = { transactionId: input.transactionId, kind: "relink" as const, templateId: input.templateId };
  const prepared = await prepareContractSourceRelink(vault, serializeContractPolicyV5(policy), locator, input.candidatePath);
  return publishSourceChange(vault, input.target, locator, prepared, policy.revision);
}


export interface ContractPublicationPlanSummary {
  readonly revision: number;
  readonly addedTemplates: readonly string[];
  readonly removedTemplates: readonly string[];
  readonly changedTemplates: readonly string[];
  readonly commonChanged: boolean;
  readonly propertiesChanged: boolean;
}

export type PublishContractResult =
  | { readonly state: "confirmation-required"; readonly plan: ContractPublicationPlanSummary }
  | { readonly state: "published"; readonly revision: number; readonly receipt: VaultPublicationReceipt };

const CONTRACT_PUBLICATION_DECISION = "published an explicit contract revision";

function summarize(previous: ContractPolicyV5 | null, next: ContractPolicyV5): ContractPublicationPlanSummary {
  const before = previous === null ? {} : previous.templates;
  const ids = new Set([...Object.keys(before), ...Object.keys(next.templates)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const id of [...ids].sort()) {
    const left = before[id];
    const right = next.templates[id];
    if (left === undefined) added.push(id);
    else if (right === undefined) removed.push(id);
    else if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(id);
  }
  return {
    revision: next.revision,
    addedTemplates: added,
    removedTemplates: removed,
    changedTemplates: changed,
    commonChanged: previous === null || JSON.stringify(previous.common) !== JSON.stringify(next.common),
    propertiesChanged: previous === null || JSON.stringify(previous.properties) !== JSON.stringify(next.properties),
  };
}

/** Declared sources are verified live by the publication kernel before any write. */
function declaredSources(policy: ContractPolicyV5): readonly { readonly path: string; readonly digest: Digest }[] {
  const sources: { path: string; digest: Digest }[] = [];
  for (const entry of Object.values(policy.templates)) {
    if (entry.status === "active") sources.push({ path: entry.source.path, digest: entry.source.rawDigest });
  }
  return sources.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * Publishes one explicit contract revision. The document is the caller's own
 * contract meaning: OMS validates, compare-and-swaps it against the exact bytes
 * on disk, and records one history revision. It never derives a rule from a file
 * name, from Markdown syntax, or from an interview it ran itself.
 */
export async function publishContract(input: {
  readonly target: WriteTarget;
  readonly policy: unknown;
  readonly transactionId: string;
  readonly confirmed: boolean;
}): Promise<PublishContractResult> {
  const admitted = await admitWriteTarget(input.target);
  if (admitted !== undefined) fail("SELECTION_INVALID", admitted.message);
  const vault = await canonicalPublicRoot(input.target.vault);
  assertLowercaseUuid(input.transactionId, "transactionId");
  const settings = await requireSettings(vault);
  const next = parseContractPolicyV5(input.policy);
  const observed = await observePolicy(vault);
  if (observed.state === "legacy" || observed.state === "malformed") {
    fail("SELECTION_UNSAFE", "the published policy is not an explicit V5 contract; resolve it before publishing a revision");
  }
  const previous = observed.state === "v5" ? observed.policy : null;
  // The publication kernel starts a first contract at revision 0 and then
  // advances exactly one revision per publication.
  const expectedRevision = previous === null ? 0 : previous.revision + 1;
  if (next.revision !== expectedRevision) {
    throw new ContractV5Error("CONTRACT_POLICY_INVALID", `Published contract must be revision ${expectedRevision}; received ${next.revision}.`);
  }
  if (!input.confirmed) return { state: "confirmation-required", plan: summarize(previous, next) };
  const content = serializeContractPolicyV5(next);
  const expectedDigest = previous === null ? null : digestBytes(serializeContractPolicyV5(previous));
  const target: WriteTarget = { vault, source: input.target.source };
  const plan = await planVaultPublication(target, {
    transactionId: input.transactionId,
    kind: "contract-publication",
    vaultId: settings.vaultId,
    outputs: [{ path: ".oms/template-policy.json", expectedDigest, content }],
    sources: declaredSources(next),
    history: { kind: "publication", decision: CONTRACT_PUBLICATION_DECISION },
  });
  const receipt = await commitVaultPublication(target, plan, plan.planDigest);
  return { state: "published", revision: next.revision, receipt };
}


export interface ContractDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: string;
}

export interface ContractDiagnosis {
  readonly vault: string;
  readonly status: "healthy" | "needs-repair";
  readonly revision: number | null;
  readonly settings: "verified" | "missing";
  readonly diagnostics: readonly ContractDiagnostic[];
}

/**
 * Read-only diagnosis of the published contract. It reports what it observed and
 * repairs nothing: an absent or historical policy, missing portable settings, a
 * held registration, and a drifted, missing, or unreadable source are each
 * reported as their own diagnostic.
 */
export async function diagnoseContract(input: { readonly target: WriteTarget }): Promise<ContractDiagnosis> {
  const admitted = await admitWriteTarget(input.target);
  const vault = admitted === undefined
    ? await canonicalPublicRoot(input.target.vault)
    : path.resolve(input.target.vault);
  const diagnostics: ContractDiagnostic[] = [];
  if (admitted !== undefined) {
    return { vault, status: "needs-repair", revision: null, settings: "missing", diagnostics: [{ code: "TARGET_UNVERIFIED", message: admitted.message }] };
  }
  const settings = await readVaultSettings(vault).catch((error: unknown) => {
    diagnostics.push({ code: "VAULT_SETTINGS_INVALID", message: error instanceof Error ? error.message : String(error), path: ".oms/settings.json" });
    return null;
  });
  if (settings === null) diagnostics.push({ code: "VAULT_SETTINGS_MISSING", message: "no portable vault settings are published; run oms setup", path: ".oms/settings.json" });
  const observed = await observePolicy(vault);
  if (observed.state === "absent") {
    diagnostics.push({ code: "CONTRACT_ABSENT", message: "no explicit contract is published", path: POLICY_PATH });
    return { vault, status: "needs-repair", revision: null, settings: settings === null ? "missing" : "verified", diagnostics };
  }
  if (observed.state !== "v5") {
    diagnostics.push({
      code: observed.state === "legacy" ? "CONTRACT_VERSION_UNSUPPORTED" : "CONTRACT_POLICY_INVALID",
      message: observed.state === "legacy" ? "the published policy is a historical contract and is not a V5 contract" : observed.reason,
      path: POLICY_PATH,
    });
    return { vault, status: "needs-repair", revision: null, settings: settings === null ? "missing" : "verified", diagnostics };
  }
  const policy = observed.policy;
  if (policy.common.status !== "active") {
    for (const reason of policy.common.reasons) diagnostics.push({ code: "CONTRACT_REVIEW_REQUIRED", message: reason });
  }
  for (const [templateId, entry] of Object.entries(policy.templates)) {
    if (entry.status !== "active") {
      for (const reason of entry.reasons) diagnostics.push({ code: "CONTRACT_REVIEW_REQUIRED", message: reason, templateId });
      continue;
    }
    const review = await inspectContractSource(vault, policy, templateId);
    if (review.state === "unchanged") continue;
    diagnostics.push({
      code: review.state === "drift" ? "SOURCE_DRIFT" : review.state === "missing" ? "SOURCE_MISSING" : "SOURCE_UNREADABLE",
      message: review.state === "drift"
        ? "the registered source changed since it was approved; review and acknowledge it"
        : review.state === "missing"
          ? "the registered source is missing; relink it to its new path"
          : "the registered source cannot be read as complete UTF-8",
      path: review.path,
      templateId,
    });
  }
  return {
    vault,
    status: diagnostics.length === 0 ? "healthy" : "needs-repair",
    revision: policy.revision,
    settings: settings === null ? "missing" : "verified",
    diagnostics,
  };
}
