import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import {
  ConnectionCoordinatorError,
  prepareConnection,
  settingsPublicationRequest,
  type ConnectionCoordinatorOptions,
  type PreparedConnection,
} from "../install/connection-coordinator.js";
import { ContractV5Error, parseContractPolicyV5, type ContractPolicyV5 } from "../templates/contract-v5.js";
import { proposeTemplateFolders, type TemplateFolderHintResult } from "../templates/hints.js";
import { parseLegacyJson } from "../templates/legacy-json.js";
import { normalizeTemplateControlPath, verifyTemplateControlPath } from "../templates/paths.js";
import type { Digest } from "../templates/types.js";
import { VaultSettingsError, parseVaultSettings } from "../templates/vault-settings.js";
import {
  inspectLegacyVaultMigrationRetry,
  inspectLegacyVaultPublication,
  inspectVaultPublication,
  type LegacyVaultPublicationAdmission,
} from "../templates/vault-publication.js";
import {
  describeFreshSetup,
  type FreshSetupDocument,
  type FreshSetupMigrationRetryAnchor,
  type FreshSetupPolicySummary,
} from "./documents.js";

/**
 * Fresh setup classifies an existing canonical vault and prepares one explicit
 * connection. Inspection and preparation create no root, `.oms`, registry,
 * reservation, policy, model selection, or Markdown.
 */

const POLICY_PATH = ".oms/template-policy.json";
const SETTINGS_PATH = ".oms/settings.json";
const MAX_CONTROL_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FreshSetupState = "contract-configured" | "contract-setup-required" | "held-legacy" | "blocked";

export type FreshSetupIdentity =
  | { readonly kind: "settings-root"; readonly operationId: string; readonly transactionId: string; readonly vaultId: string }
  | { readonly kind: "verified-target"; readonly operationId: string };

export interface SetupDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface FreshSetupInspection {
  readonly vault: string;
  readonly state: FreshSetupState;
  readonly settings: { readonly state: "missing" } | { readonly state: "verified"; readonly vaultId: string };
  readonly document: FreshSetupDocument;
  readonly hints: TemplateFolderHintResult;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export type FreshSetupPreparation =
  | { readonly state: "ready"; readonly inspection: FreshSetupInspection; readonly identity: FreshSetupIdentity; readonly connection: PreparedConnection }
  | { readonly state: "held-legacy" | "blocked"; readonly inspection: FreshSetupInspection; readonly diagnostics: readonly SetupDiagnostic[] };

type ControlBytes = { readonly state: "absent" } | { readonly state: "present"; readonly bytes: Uint8Array };

type SettingsObservation =
  | { readonly state: "missing"; readonly diagnostic: null }
  | { readonly state: "verified"; readonly vaultId: string; readonly diagnostic: null }
  | { readonly state: "malformed"; readonly diagnostic: SetupDiagnostic };

type PolicyObservation =
  | { readonly state: "absent" }
  | { readonly state: "legacy" }
  | { readonly state: "v5"; readonly policy: ContractPolicyV5 }
  | { readonly state: "malformed"; readonly diagnostic: SetupDiagnostic };

/** Read-only. A valid manual V5 policy needs neither a native marker nor settings. */
export async function inspectFreshSetup(input: { readonly vault: string }): Promise<FreshSetupInspection> {
  if (typeof input.vault !== "string" || input.vault.trim() === "") fail("vault must be an existing canonical root");
  const vault = await realpath(input.vault);
  const [settings, policy, hints] = await Promise.all([
    observeSettings(vault),
    observePolicy(vault),
    proposeTemplateFolders(vault, { selected: [] }),
  ]);
  const settingsView = settings.state === "verified" ? { state: "verified" as const, vaultId: settings.vaultId } : { state: "missing" as const };
  const target: WriteTarget = { vault, source: "explicit" };
  const admission = await inspectLegacyVaultPublication(target);
  const held = legacyHold(admission);
  if (held !== null) return compose(vault, "held-legacy", settingsView, policy, hints, [held]);
  if (admission.status === "legacy-invalid" || admission.status === "legacy-ambiguous" || admission.status === "legacy-unavailable") {
    return compose(vault, "blocked", settingsView, policy, hints, [admissionDiagnostic(admission)]);
  }
  if (admission.status === "publisher-marker") {
    const native = await nativeDisposition(target);
    if (native.state !== "clear") return compose(vault, native.state, settingsView, policy, hints, native.diagnostics, native.anchor);
  }
  const diagnostics: SetupDiagnostic[] = [];
  if (settings.state === "malformed") diagnostics.push(settings.diagnostic);
  if (policy.state === "malformed") diagnostics.push(policy.diagnostic);
  if (diagnostics.length > 0) return compose(vault, "blocked", settingsView, policy, hints, diagnostics);
  if (policy.state === "legacy") return compose(vault, "held-legacy", settingsView, policy, hints, [diagnostic("legacy-policy", "Published policy is a historical contract and is not a V5 setup contract.", POLICY_PATH)]);
  return compose(vault, policy.state === "v5" ? "contract-configured" : "contract-setup-required", settingsView, policy, hints, []);
}

/** Read-only preparation. Identity mode mismatch fails and never switches modes. */
export async function prepareFreshSetup(input: {
  readonly target: WriteTarget;
  readonly identity: FreshSetupIdentity;
  readonly coordinatorOptions?: ConnectionCoordinatorOptions;
}): Promise<FreshSetupPreparation> {
  const identity = strictIdentity(input.identity);
  const admitted = await admitWriteTarget(input.target);
  if (admitted !== undefined) {
    const inspection = await unsupported(input.target, diagnostic(admitted.code, admitted.message));
    return { state: "blocked", inspection, diagnostics: inspection.diagnostics };
  }
  const inspection = await inspectFreshSetup({ vault: input.target.vault });
  if (inspection.state === "held-legacy" || inspection.state === "blocked") return { state: inspection.state, inspection, diagnostics: inspection.diagnostics };
  const mismatch = modeMismatch(inspection, identity);
  if (mismatch !== null) return blockedPreparation(inspection, mismatch);
  const preserved: WriteTarget = { vault: inspection.vault, source: input.target.source };
  const publication = identity.kind === "settings-root" ? settingsPublicationRequest(identity.transactionId, identity.vaultId) : null;
  try {
    const connection = await prepareConnection({ operationId: identity.operationId, target: preserved, publication, select: false }, input.coordinatorOptions);
    if (connection.input.select !== false || connection.input.project !== undefined || connection.input.target.source !== input.target.source) {
      return blockedPreparation(inspection, diagnostic("preparation-required", "Connection preparation changed the requested target, selection, or project absence."));
    }
    if (connection.blockers.length > 0) return blockedPreparation(inspection, ...connection.blockers.map(issue => diagnostic(issue.code, issue.message)));
    return { state: "ready", inspection, identity, connection };
  } catch (error) {
    if (error instanceof ConnectionCoordinatorError) return blockedPreparation(inspection, diagnostic(error.code, error.message));
    throw error;
  }
}

async function unsupported(target: WriteTarget, issue: SetupDiagnostic): Promise<FreshSetupInspection> {
  let vault = target.vault;
  try { vault = await realpath(target.vault); } catch { /* report the supplied path when it is not a canonical root */ }
  const hints: TemplateFolderHintResult = { candidates: [], diagnostics: [] };
  return {
    vault,
    state: "blocked",
    settings: { state: "missing" },
    document: describeFreshSetup({ state: "blocked", settingsPresent: false, hints, diagnostics: [issue] }),
    hints,
    diagnostics: [issue],
  };
}

function modeMismatch(inspection: FreshSetupInspection, identity: FreshSetupIdentity): SetupDiagnostic | null {
  if (identity.kind === "settings-root") {
    return inspection.settings.state === "missing" ? null : diagnostic("identity-conflict", "Settings-root preparation requires absent settings and cannot replace published settings.");
  }
  return inspection.settings.state === "verified" ? null : diagnostic("identity-missing", "Verified-target preparation requires actual valid settings and no settings publication.");
}

function strictIdentity(value: FreshSetupIdentity): FreshSetupIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("identity must be a concrete object");
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  assertUuid(record.operationId, "operationId");
  if (record.kind === "verified-target") {
    if (keys.join(",") !== "kind,operationId") fail("verified-target identity contains unexpected fields");
    return { kind: "verified-target", operationId: record.operationId };
  }
  if (record.kind !== "settings-root" || keys.join(",") !== "kind,operationId,transactionId,vaultId") fail("settings-root identity must contain kind, operationId, transactionId, and vaultId");
  assertUuid(record.transactionId, "transactionId");
  assertUuid(record.vaultId, "vaultId");
  return { kind: "settings-root", operationId: record.operationId, transactionId: record.transactionId, vaultId: record.vaultId };
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail(`${label} must be a lowercase UUID`);
}

function fail(message: string): never {
  throw new ConnectionCoordinatorError("invalid-input", message);
}

function legacyHold(admission: LegacyVaultPublicationAdmission): SetupDiagnostic | null {
  if (admission.status !== "verified" && admission.status !== "legacy-inconsistent" && admission.status !== "legacy-in-progress") return null;
  return admissionDiagnostic(admission);
}

function admissionDiagnostic(admission: LegacyVaultPublicationAdmission): SetupDiagnostic {
  return diagnostic(admission.status, admission.reasons[0] ?? `Historical publication admission is ${admission.status}.`, admission.markerPath ?? undefined);
}

async function nativeDisposition(target: WriteTarget): Promise<{ readonly state: "clear" } | { readonly state: "held-legacy" | "blocked"; readonly diagnostics: readonly SetupDiagnostic[]; readonly anchor?: FreshSetupMigrationRetryAnchor }> {
  let inspected: Awaited<ReturnType<typeof inspectVaultPublication>>;
  try { inspected = await inspectVaultPublication(target.vault); }
  catch (error) { return { state: "blocked", diagnostics: [diagnostic("publication-blocked", error instanceof Error ? error.message : "Publisher marker could not be inspected.")] }; }
  if (inspected.status === "absent" || inspected.status === "complete" || inspected.marker === undefined) return { state: "clear" };
  if (inspected.status === "in-progress" || inspected.status === "rolling-back") {
    return { state: "blocked", diagnostics: [diagnostic(inspected.status, `Publisher marker is ${inspected.status} and must be recovered before setup.`, ".oms/template-transaction.json")] };
  }
  if (inspected.marker.kind !== "schema-migration") {
    return { state: "blocked", diagnostics: [diagnostic("rolled-back", "Only a rolled-back schema migration is a setup retry anchor.", ".oms/template-transaction.json")] };
  }
  const retry = await inspectLegacyVaultMigrationRetry(target);
  if (retry.status === "migration-retry") {
    return {
      state: "held-legacy",
      diagnostics: [diagnostic("migration-retry", "Rolled-back schema migration remains unchanged as the retry anchor.", ".oms/template-transaction.json")],
      anchor: anchorFrom(inspected.marker.transactionId, inspected.marker.planDigest),
    };
  }
  return { state: retry.status === "legacy-inconsistent" ? "held-legacy" : "blocked", diagnostics: [admissionDiagnostic(retry)] };
}

function anchorFrom(transactionId: string, planDigest: Digest): FreshSetupMigrationRetryAnchor {
  return { kind: "schema-migration", status: "rolled-back", transactionId, planDigest };
}

async function observeSettings(vault: string): Promise<SettingsObservation> {
  let bytes: Uint8Array;
  try { const read = await readControl(vault, SETTINGS_PATH); if (read.state === "absent") return { state: "missing", diagnostic: null }; bytes = read.bytes; }
  catch (error) { return { state: "malformed", diagnostic: controlDiagnostic(error, "settings", SETTINGS_PATH) }; }
  const text = utf8(bytes);
  if (typeof text !== "string") return { state: "malformed", diagnostic: diagnostic("settings-invalid-utf8", "settings are not exact UTF-8", SETTINGS_PATH) };
  try {
    const parsed = parseLegacyJson(text);
    if (parsed.members !== "unique") return { state: "malformed", diagnostic: diagnostic("settings-duplicate-json", `settings JSON members are ${parsed.members}`, SETTINGS_PATH) };
    return { state: "verified", vaultId: parseVaultSettings(text).vaultId, diagnostic: null };
  } catch (error) {
    return { state: "malformed", diagnostic: controlDiagnostic(error, "settings", SETTINGS_PATH) };
  }
}

async function observePolicy(vault: string): Promise<PolicyObservation> {
  let bytes: Uint8Array;
  try { const read = await readControl(vault, POLICY_PATH); if (read.state === "absent") return { state: "absent" }; bytes = read.bytes; }
  catch (error) { return { state: "malformed", diagnostic: controlDiagnostic(error, "policy", POLICY_PATH) }; }
  const text = utf8(bytes);
  if (typeof text !== "string") return { state: "malformed", diagnostic: diagnostic("policy-invalid-utf8", "policy is not exact UTF-8", POLICY_PATH) };
  let parsed: ReturnType<typeof parseLegacyJson>;
  try { parsed = parseLegacyJson(text); }
  catch (error) { return { state: "malformed", diagnostic: controlDiagnostic(error, "policy", POLICY_PATH) }; }
  if (parsed.members !== "unique") return { state: "malformed", diagnostic: diagnostic("policy-duplicate-json", `policy JSON members are ${parsed.members}`, POLICY_PATH) };
  const version = versionOf(parsed.value);
  if (version === 3 || version === 4) return { state: "legacy" };
  if (version !== 5) return { state: "malformed", diagnostic: diagnostic("policy-malformed", "policy version is not a published V5 contract", POLICY_PATH) };
  try { return { state: "v5", policy: parseContractPolicyV5(parsed.value) }; }
  catch (error) { return { state: "malformed", diagnostic: controlDiagnostic(error, "policy", POLICY_PATH) }; }
}

function versionOf(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined;
}

async function readControl(vault: string, relative: string): Promise<ControlBytes> {
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(relative), { expected: "either" });
  if (verified.targetRealPath === null) return { state: "absent" };
  const handle = await open(verified.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size > MAX_CONTROL_BYTES) {
      throw Object.assign(new Error(`${relative} is not one bounded regular control file`), { code: "control-malformed" });
    }
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength !== stat.size) throw Object.assign(new Error(`${relative} changed while reading`), { code: "control-malformed" });
    return { state: "present", bytes };
  } finally { await handle.close(); }
}

function utf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    return encoded.byteLength === bytes.byteLength && encoded.every((byte, index) => byte === bytes[index]) ? text : null;
  } catch { return null; }
}

function controlDiagnostic(error: unknown, label: string, path: string): SetupDiagnostic {
  if (error instanceof ContractV5Error || error instanceof VaultSettingsError) return diagnostic(error.code, error.message, path);
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : `${label}-malformed`;
  return diagnostic(code, error instanceof Error ? error.message : `${label} is malformed`, path);
}

function diagnostic(code: string, message: string, path?: string): SetupDiagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

function summary(policy: ContractPolicyV5): FreshSetupPolicySummary {
  return { version: 5, revision: policy.revision, commonStatus: policy.common.status };
}

function compose(
  vault: string,
  state: FreshSetupState,
  settings: FreshSetupInspection["settings"],
  policy: PolicyObservation,
  hints: TemplateFolderHintResult,
  diagnostics: readonly SetupDiagnostic[],
  anchor?: FreshSetupMigrationRetryAnchor,
): FreshSetupInspection {
  const actual = policy.state === "v5" ? summary(policy.policy) : undefined;
  return {
    vault,
    state,
    settings,
    document: describeFreshSetup({
      state,
      settingsPresent: settings.state === "verified",
      ...(actual === undefined ? {} : { policy: actual }),
      ...(anchor === undefined ? {} : { migrationRetryAnchor: anchor }),
      hints,
      diagnostics,
    }),
    hints,
    diagnostics,
  };
}

function blockedPreparation(inspection: FreshSetupInspection, ...issues: readonly SetupDiagnostic[]): FreshSetupPreparation {
  const diagnostics = [...inspection.diagnostics, ...issues];
  const next: FreshSetupInspection = {
    ...inspection,
    state: "blocked",
    diagnostics,
    document: describeFreshSetup({
      state: "blocked",
      settingsPresent: inspection.settings.state === "verified",
      ...(inspection.document.policy === undefined ? {} : { policy: inspection.document.policy }),
      ...(inspection.document.migrationRetryAnchor === undefined ? {} : { migrationRetryAnchor: inspection.document.migrationRetryAnchor }),
      hints: inspection.hints,
      diagnostics,
    }),
  };
  return { state: "blocked", inspection: next, diagnostics };
}

