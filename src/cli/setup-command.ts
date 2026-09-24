import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  ConnectionCoordinatorError,
  commitConnection,
  hasConnectionIntent,
  resumeConnection,
  type ConnectionCommitResult,
  type ConnectionResumeResult,
} from "../kernel/install/connection-coordinator.js";
import type { WriteTarget } from "../kernel/capture/safe.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import {
  FreshModelSelectionError,
  acquireModelSet,
  commitFreshModelSelection,
  modelAcquisitionApprovalDigest,
  modelsConfigFromAcquisitionManifest,
  parseModelSetAcquisitionManifest,
  prepareFreshModelSelection,
  type ModelSetAcquisitionManifest,
} from "../kernel/engine/embed/model.js";
import {
  inspectFreshSetup,
  prepareFreshSetup,
  type FreshSetupIdentity,
  type FreshSetupInspection,
  type FreshSetupPreparation,
  type SetupDiagnostic,
} from "../kernel/setup/service.js";
import { digestBytes, parseDigest } from "../kernel/templates/canonical.js";
import type { Digest } from "../kernel/templates/types.js";
import { readVaultSettings } from "../kernel/templates/vault-settings.js";
import { buildClaudeInstallPlan, printClaudeInstallPlan } from "./claude-install-plan.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCES = new Set<WriteTargetSource>(["explicit", "vault", "bridge", "legacy-bridge", "env", "cwd"]);
const TOKEN_VERSION = "oms.setup.v5.approval.v1";
const MAX_TOKEN_BYTES = 64 * 1024;

export type SetupOutcome = "blocked" | "completed";

export async function runSetup(opts: {
  readonly target: WriteTarget;
  readonly yes: boolean;
  readonly installClaude?: boolean;
  readonly dryRun?: boolean;
  readonly approvalToken?: string;
  readonly approvedDigest?: Digest;
  /** Strict setup-only acquisition manifest for one or more model capabilities. */
  readonly modelSetManifest?: ModelSetAcquisitionManifest | unknown;
  /** User-level model cache override, primarily for setup automation/tests. */
  readonly modelCacheDir?: string;
  /** Explicitly waive installing a default model set and preserve vault config. */
  readonly modelsNoDefault?: boolean;
  /** Fetch seam for setup tests; production uses global fetch. */
  readonly modelFetchImpl?: typeof fetch;
}): Promise<SetupOutcome> {
  const {
    target,
    yes,
    installClaude = false,
    dryRun = false,
    approvalToken,
    approvedDigest,
    modelSetManifest,
    modelCacheDir,
    modelsNoDefault = false,
    modelFetchImpl,
  } = opts;
  if (dryRun && (yes || approvalToken !== undefined || approvedDigest !== undefined)) {
    return refuse("SETUP_APPROVAL_CONFLICT", "--dry-run conflicts with --yes, --approval-token, and --approved-digest.");
  }
  if (!dryRun && !yes) return refuse("SETUP_APPROVAL_REQUIRED", "Setup apply requires --yes, the dry-run approval token, and its approval digest.");
  if (modelSetManifest !== undefined && modelsNoDefault) {
    return refuse("SETUP_MODEL_CONFLICT", "Setup model acquisition and --models-no-default are mutually exclusive.");
  }
  if (!SOURCES.has(target.source)) return refuse("target-unverified", `Setup target source is not a known write origin: ${String(target.source)}.`);

  let manifest: ModelSetAcquisitionManifest | undefined;
  try {
    manifest = modelSetManifest === undefined ? undefined : parseModelSetAcquisitionManifest(modelSetManifest);
  } catch (error: unknown) {
    return refuse("SETUP_MODEL_MANIFEST_INVALID", error instanceof Error ? error.message : "Model acquisition manifest is invalid.");
  }
  const proposedConfig = manifest === undefined ? undefined : modelsConfigFromAcquisitionManifest(manifest);
  const manifestDigest = manifest === undefined ? undefined : modelAcquisitionApprovalDigest(manifest);

  if (dryRun) return propose(target, manifest, proposedConfig, manifestDigest, modelsNoDefault);
  if (approvalToken === undefined || approvedDigest === undefined || !DIGEST.test(approvedDigest)) {
    return refuse("SETUP_APPROVAL_REQUIRED", "Setup apply requires the exact approval token and sha256 digest printed by dry-run.");
  }
  return apply({
    target,
    approvalToken,
    approvedDigest: parseDigest(approvedDigest),
    manifest,
    proposedConfig,
    manifestDigest,
    modelsNoDefault,
    modelCacheDir,
    modelFetchImpl,
    installClaude,
  });
}

async function propose(
  target: WriteTarget,
  manifest: ModelSetAcquisitionManifest | undefined,
  proposedConfig: ReturnType<typeof modelsConfigFromAcquisitionManifest> | undefined,
  manifestDigest: Digest | undefined,
  modelsNoDefault: boolean,
): Promise<SetupOutcome> {
  if (target.source === "cwd" || target.source === "legacy-bridge") {
    return refuse("target-unverified", "Setup refuses a current-directory inference or a legacy bridge; pass an explicit vault or a verified vault, bridge, or env target.");
  }
  let inspection: FreshSetupInspection;
  try {
    inspection = await inspectFreshSetup({ vault: target.vault });
  } catch (error: unknown) {
    return refused(error);
  }
  if (inspection.state === "held-legacy" || inspection.state === "blocked") return blocked(inspection.diagnostics, inspection);
  if (inspection.vault !== await canonicalRoot(target.vault)) return blocked([diagnostic("SETUP_TARGET_MISMATCH", "Inspected vault is not the canonical root.")], inspection);
  const identity = identityFor(inspection);
  if (identity === undefined) return blocked([diagnostic("identity-missing", "Setup cannot choose an identity without actual settings evidence.")], inspection);
  const preparation = await prepareFreshSetup({ target: { vault: inspection.vault, source: target.source }, identity });
  if (preparation.state !== "ready") return blocked(preparation.diagnostics, preparation.inspection);

  let model: ApprovalModel | undefined;
  if (proposedConfig !== undefined && manifest !== undefined && manifestDigest !== undefined) {
    let prepared;
    try {
      prepared = await prepareFreshModelSelection({ target: { vault: inspection.vault, source: target.source }, config: proposedConfig });
    } catch (error: unknown) {
      return refused(error, inspection);
    }
    if (prepared.disposition === "conflict") {
      return blocked([diagnostic("model-conflict", "Existing model selection bytes differ from the requested config and were preserved.")], inspection);
    }
    if (prepared.canonicalVault !== inspection.vault) {
      return blocked([diagnostic("model-target-mismatch", "Model preflight vault does not match the inspected vault.")], inspection);
    }
    model = {
      manifest,
      manifestDigest,
      configDigest: prepared.configDigest,
      expectedCurrent: prepared.expectedCurrent,
    };
  }

  const connection = connectionClaim(preparation, identity);
  const token: ApprovalToken = {
    version: TOKEN_VERSION,
    target: { vault: inspection.vault, source: target.source },
    connection,
    ...(model === undefined ? {} : { model }),
    modelsNoDefault,
  };
  const canonical = canonicalTokenJson(token);
  const approvalDigest = digestBytes(`${TOKEN_VERSION}\0${canonical}`);
  console.log(JSON.stringify({
    status: "proposed",
    state: inspection.state,
    document: inspection.document,
    diagnostics: [...inspection.diagnostics, ...inspection.hints.diagnostics],
    connectionDigest: preparation.connection.digest,
    approvalToken: encodeToken(canonical),
    approvalDigest,
    ...(model === undefined ? {} : { modelsConfig: proposedConfig, model }),
  }, null, 2));
  return "completed";
}

async function apply(input: {
  readonly target: WriteTarget;
  readonly approvalToken: string;
  readonly approvedDigest: Digest;
  readonly manifest: ModelSetAcquisitionManifest | undefined;
  readonly proposedConfig: ReturnType<typeof modelsConfigFromAcquisitionManifest> | undefined;
  readonly manifestDigest: Digest | undefined;
  readonly modelsNoDefault: boolean;
  readonly modelCacheDir: string | undefined;
  readonly modelFetchImpl: typeof fetch | undefined;
  readonly installClaude: boolean;
}): Promise<SetupOutcome> {
  let decoded: ApprovalToken;
  try {
    decoded = decodeApprovalToken(input.approvalToken, input.approvedDigest);
  } catch (error: unknown) {
    return refused(error);
  }
  if (decoded.target.source === "cwd" || decoded.target.source === "legacy-bridge" || input.target.source === "cwd" || input.target.source === "legacy-bridge") {
    return refuse("target-unverified", "Setup refuses a current-directory inference or a legacy bridge; pass an explicit vault or a verified vault, bridge, or env target.");
  }
  if (decoded.target.source !== input.target.source) {
    return refuse("SETUP_TARGET_MISMATCH", "Approval token source does not match the actual write target.");
  }
  let canonicalVault: string;
  try {
    canonicalVault = await realpath(input.target.vault);
  } catch (error: unknown) {
    return refused(error);
  }
  if (decoded.target.vault !== canonicalVault) return refuse("SETUP_TARGET_MISMATCH", "Approval token vault does not match the canonical write target.");
  if (decoded.modelsNoDefault !== input.modelsNoDefault) return refuse("SETUP_MODEL_MISMATCH", "Approval token model waiver does not match the requested waiver.");
  const requestedModel = input.manifest !== undefined;
  if (requestedModel !== (decoded.model !== undefined)) return refuse("SETUP_MODEL_MISMATCH", "Approval token model binding does not match the requested model flags.");
  if (decoded.model !== undefined) {
    if (input.manifest === undefined || input.proposedConfig === undefined || input.manifestDigest === undefined) {
      return refuse("SETUP_MODEL_MISMATCH", "Approval token names a model that this command did not request.");
    }
    if (decoded.model.manifestDigest !== input.manifestDigest || canonicalTokenJson(decoded.model.manifest) !== canonicalTokenJson(input.manifest)) {
      return refuse("SETUP_MODEL_MISMATCH", "Approval token model manifest does not match the requested manifest.");
    }
    if (canonicalTokenJson(input.proposedConfig) !== canonicalTokenJson(modelsConfigFromAcquisitionManifest(input.manifest))) {
      return refuse("SETUP_MODEL_MISMATCH", "Requested model config does not match the acquisition manifest.");
    }
  }

  const boundTarget: WriteTarget = { vault: canonicalVault, source: input.target.source };
  let inspection: FreshSetupInspection;
  try {
    inspection = await inspectFreshSetup({ vault: canonicalVault });
  } catch (error: unknown) {
    return refused(error);
  }
  if (inspection.vault !== canonicalVault) return refuse("SETUP_TARGET_MISMATCH", "Inspected vault does not match the canonical write target.");
  if (inspection.state === "held-legacy" || inspection.state === "blocked") return blocked(inspection.diagnostics, inspection);
  if (decoded.model !== undefined && input.proposedConfig !== undefined) {
    try {
      const preflight = await prepareFreshModelSelection({ target: boundTarget, config: input.proposedConfig });
      if (!modelPreimageMatches(preflight, decoded.model, canonicalVault)) {
        return blocked([diagnostic("model-conflict", "Model selection does not match the approved config digest and current bytes; no connection or model effect was started.")], inspection);
      }
    } catch (error: unknown) {
      return refused(error, inspection);
    }
  }

  let committed: ConnectionCommitResult;
  try {
    if (await hasConnectionIntent(decoded.connection.operationId)) {
      const resumed = await resumeConnection(
        { operationId: decoded.connection.operationId, target: boundTarget },
        decoded.connection.connectionDigest,
      );
      if (!isCommit(resumed)) {
        return blocked([diagnostic(resumed.state, `Connection ${decoded.connection.operationId} is ${resumed.state} and was not re-prepared.`)], inspection);
      }
      committed = resumed;
    } else {
      const identity = identityFrom(decoded, inspection);
      if (identity === undefined) return refuse("SETUP_CONNECTION_MISMATCH", "Approval token connection mode does not match actual settings.");
      const preparation = await prepareFreshSetup({ target: boundTarget, identity });
      if (preparation.state !== "ready") return blocked(preparation.diagnostics, preparation.inspection);
      if (!sameConnection(preparation, decoded.connection, boundTarget)) {
        return refuse("SETUP_CONNECTION_MISMATCH", "Reconstructed connection does not match the approved target, source, mode, vault identity, or connection digest.");
      }
      committed = await commitConnection(preparation.connection, decoded.connection.connectionDigest);
    }
  } catch (error: unknown) {
    return refused(error, inspection);
  }
  if (!nativeReady(committed, decoded)) return pending(committed, inspection);

  if (decoded.model === undefined || input.manifest === undefined || input.proposedConfig === undefined) {
    finish(input.approvedDigest, committed, undefined, input.modelsNoDefault, input.installClaude, canonicalVault);
    return "completed";
  }
  const vaultId = settingsVaultId(committed, decoded);
  if (vaultId === undefined) return pending(committed, inspection);
  let current;
  try {
    current = await prepareFreshModelSelection({ target: boundTarget, config: input.proposedConfig });
  } catch (error: unknown) {
    return refused(error, inspection);
  }
  if (!modelPreimageMatches(current, decoded.model, canonicalVault)) {
    return blocked([diagnostic("model-stale", "Model selection changed after native completion; no model was acquired or published.")], inspection);
  }
  let acquired;
  try {
    acquired = await acquireModelSet({
      vault: canonicalVault,
      cacheDir: input.modelCacheDir,
      manifest: input.manifest,
      fetchImpl: input.modelFetchImpl,
    });
  } catch (error: unknown) {
    return refused(error, inspection);
  }
  if (canonicalTokenJson(acquired.config) !== canonicalTokenJson(input.proposedConfig)) {
    return refuse("SETUP_MODEL_MISMATCH", "Acquired model config does not match the approved config.");
  }
  let written;
  try {
    written = await commitFreshModelSelection({
      target: boundTarget,
      config: acquired.config,
      expectedCurrent: decoded.model.expectedCurrent,
      expectedConfigDigest: decoded.model.configDigest,
      expectedVaultId: vaultId,
    });
  } catch (error: unknown) {
    return refused(error, inspection);
  }
  const confirmed = await readVaultSettings(canonicalVault);
  if (!written.verified || written.configDigest !== decoded.model.configDigest || confirmed?.vaultId !== vaultId) {
    return refuse("model-readback-failed", "Model publication readback does not match the approved config and vault identity.");
  }
  for (const capability of ["embed", "rerank", "generate"] as const) {
    const model = acquired.config[capability];
    if (model !== undefined) console.log(`Model: ${capability} ${model.provider}/${model.model}@${model.revision} (${written.status})`);
  }
  finish(input.approvedDigest, committed, written, false, input.installClaude, canonicalVault);
  return "completed";
}

function finish(
  approvalDigest: Digest,
  committed: ConnectionCommitResult,
  model: { readonly status: "written" | "unchanged"; readonly path: string; readonly configDigest: Digest; readonly verified: true } | undefined,
  modelsNoDefault: boolean,
  installClaude: boolean,
  vault: string,
): void {
  console.log(JSON.stringify({
    status: "completed",
    approvalDigest,
    connectionDigest: committed.planDigest,
    native: {
      vault: stageReceipt(committed.vault),
      global: stageReceipt(committed.global),
      project: stageReceipt(committed.project),
      reservation: committed.reservation === null ? null : {
        connectionId: committed.reservation.connectionId,
        portableVaultId: committed.reservation.portableVaultId,
      },
    },
    ...(model === undefined ? {} : { model }),
  }));
  if (modelsNoDefault) console.log("Models: no default (explicit waiver)");
  if (installClaude) printClaudeInstallPlan(buildClaudeInstallPlan({ vault }));
}

function stageReceipt(stage: { readonly state: string; readonly code?: string }): { readonly state: string; readonly code?: string } {
  return { state: stage.state, ...(stage.code === undefined ? {} : { code: stage.code }) };
}

function modelPreimageMatches(
  prepared: { readonly canonicalVault: string; readonly configDigest: Digest; readonly expectedCurrent: Digest | "sha256:absent"; readonly disposition: "create" | "unchanged" | "conflict" },
  approved: ApprovalModel,
  canonicalVault: string,
): boolean {
  if (prepared.canonicalVault !== canonicalVault || prepared.configDigest !== approved.configDigest || prepared.disposition === "conflict") return false;
  return prepared.expectedCurrent === approved.expectedCurrent
    || (approved.expectedCurrent === "sha256:absent" && prepared.disposition === "unchanged");
}

function identityFor(inspection: FreshSetupInspection): FreshSetupIdentity | undefined {
  const operationId = randomUUID();
  if (inspection.settings.state === "missing") {
    return { kind: "settings-root", operationId, transactionId: randomUUID(), vaultId: randomUUID() };
  }
  if (inspection.settings.state === "verified") return { kind: "verified-target", operationId };
  return undefined;
}

function identityFrom(token: ApprovalToken, inspection: FreshSetupInspection): FreshSetupIdentity | undefined {
  if (token.connection.mode === "settings-root") {
    if (inspection.settings.state !== "missing" || token.connection.vaultId === undefined || token.connection.transactionId === undefined) return undefined;
    return {
      kind: "settings-root",
      operationId: token.connection.operationId,
      transactionId: token.connection.transactionId,
      vaultId: token.connection.vaultId,
    };
  }
  if (inspection.settings.state !== "verified" || inspection.settings.vaultId !== token.connection.vaultId) return undefined;
  return { kind: "verified-target", operationId: token.connection.operationId };
}

function connectionClaim(preparation: Extract<FreshSetupPreparation, { state: "ready" }>, identity: FreshSetupIdentity): ApprovalConnection {
  const connection = preparation.connection;
  if (connection.input.select !== false || connection.input.project !== undefined) {
    throw new SetupCommandError("preparation-required", "Setup preparation must not select a project or change global selection.");
  }
  if (identity.kind === "settings-root") {
    return {
      mode: "settings-root",
      operationId: identity.operationId,
      transactionId: identity.transactionId,
      vaultId: identity.vaultId,
      connectionDigest: connection.digest,
    };
  }
  const vaultId = connection.portableVaultId;
  if (vaultId === null) throw new SetupCommandError("identity-missing", "Verified-target preparation has no portable vault identity.");
  return { mode: "verified-target", operationId: identity.operationId, vaultId, connectionDigest: connection.digest };
}

function sameConnection(preparation: Extract<FreshSetupPreparation, { state: "ready" }>, claim: ApprovalConnection, target: WriteTarget): boolean {
  const connection = preparation.connection;
  return connection.digest === claim.connectionDigest
    && connection.operationId === claim.operationId
    && connection.canonicalTarget === target.vault
    && connection.input.target.source === target.source
    && connection.input.select === false
    && connection.input.project === undefined
    && connection.portableVaultId === claim.vaultId
    && (claim.mode === "settings-root"
      ? connection.input.publication?.kind === "settings-update"
        && connection.input.publication.transactionId === claim.transactionId
        && connection.input.publication.vaultId === claim.vaultId
      : connection.input.publication === null);
}

function nativeReady(result: ConnectionCommitResult, token: ApprovalToken): boolean {
  const settingsPublication = token.connection.mode === "settings-root";
  return (settingsPublication ? result.vault.state === "complete" : result.vault.state === "not-requested")
    && result.global.state === "complete"
    && result.project.state === "not-requested"
    && result.reservation?.connectionId !== undefined
    && result.reservation.portableVaultId === token.connection.vaultId
    && result.reservation.localVaultPath === token.target.vault;
}

function settingsVaultId(result: ConnectionCommitResult, token: ApprovalToken): string | undefined {
  return result.reservation?.portableVaultId === token.connection.vaultId ? token.connection.vaultId : undefined;
}

function isCommit(value: ConnectionResumeResult): value is ConnectionCommitResult {
  return "vault" in value && "global" in value && "project" in value;
}

function pending(result: ConnectionCommitResult, inspection: FreshSetupInspection): SetupOutcome {
  const stages = (["vault", "global", "project"] as const).map(stage => ({
    stage,
    state: result[stage].state,
    ...(result[stage].code === undefined ? {} : { code: result[stage].code }),
    ...(result[stage].reason === undefined ? {} : { message: result[stage].reason }),
  }));
  return blocked([
    ...inspection.diagnostics,
    diagnostic("connection-pending", "Native connection stages are not complete; no model was acquired or published."),
    ...stages.filter(stage => stage.state === "pending" || stage.state === "blocked").map(stage => diagnostic(stage.code ?? stage.state, stage.message ?? `${stage.stage} is ${stage.state}.`)),
  ], inspection);
}

class SetupCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SetupCommandError";
  }
}

function refuse(code: string, message: string): SetupOutcome {
  console.log(JSON.stringify({ status: "blocked", diagnostics: [diagnostic(code, message)] }, null, 2));
  process.exitCode = 1;
  return "blocked";
}

function blocked(diagnostics: readonly SetupDiagnostic[], inspection?: FreshSetupInspection): SetupOutcome {
  console.log(JSON.stringify({
    status: "blocked",
    ...(inspection === undefined ? {} : { state: inspection.state, document: inspection.document }),
    diagnostics,
  }, null, 2));
  process.exitCode = 1;
  return "blocked";
}

function refused(error: unknown, inspection?: FreshSetupInspection): SetupOutcome {
  if (error instanceof SetupCommandError || error instanceof ConnectionCoordinatorError) return blocked([diagnostic(error.code, error.message)], inspection);
  if (error instanceof FreshModelSelectionError) return blocked([diagnostic(error.reason, error.message)], inspection);
  const message = error instanceof Error ? error.message : "Setup failed.";
  return blocked([diagnostic("SETUP_FAILED", message)], inspection);
}

function diagnostic(code: string, message: string): SetupDiagnostic {
  return { code, message };
}

interface ApprovalConnection {
  readonly mode: "settings-root" | "verified-target";
  readonly operationId: string;
  readonly transactionId?: string;
  readonly vaultId: string;
  readonly connectionDigest: Digest;
}

interface ApprovalModel {
  readonly manifest: ModelSetAcquisitionManifest;
  readonly manifestDigest: Digest;
  readonly configDigest: Digest;
  readonly expectedCurrent: Digest | "sha256:absent";
}

interface ApprovalToken {
  readonly version: typeof TOKEN_VERSION;
  readonly target: { readonly vault: string; readonly source: WriteTargetSource };
  readonly connection: ApprovalConnection;
  readonly model?: ApprovalModel;
  readonly modelsNoDefault: boolean;
}

function decodeApprovalToken(encoded: string, approvedDigest: Digest): ApprovalToken {
  if (encoded.trim() === "" || encoded !== encoded.trim() || /[\s]/.test(encoded)) {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token must be one canonical base64url value.");
  }
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token is not canonical base64url.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TOKEN_BYTES || Buffer.from(bytes).toString("base64url") !== encoded) {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token is not canonical base64url within 64 KiB.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token is not exact UTF-8.");
  }
  if (Buffer.from(text).toString("base64url") !== encoded) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token UTF-8 does not round-trip.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token is not JSON.");
  }
  if (canonicalTokenJson(parsed) !== text) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token is not canonical JSON.");
  if (digestBytes(`${TOKEN_VERSION}\0${text}`) !== approvedDigest) {
    throw new SetupCommandError("SETUP_APPROVAL_MISMATCH", "Approved digest does not match the approval token.");
  }
  return strictToken(parsed);
}

function strictToken(value: unknown): ApprovalToken {
  const record = object(value, "approval token");
  exact(record, ["version", "target", "connection", "model", "modelsNoDefault"], "approval token", ["model"]);
  if (record.version !== TOKEN_VERSION) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token version is invalid.");
  if (typeof record.modelsNoDefault !== "boolean") throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token modelsNoDefault must be boolean.");
  const target = object(record.target, "approval target");
  exact(target, ["vault", "source"], "approval target");
  if (typeof target.vault !== "string" || target.vault === "" || !SOURCES.has(target.source as WriteTargetSource)) {
    throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token target is invalid.");
  }
  const connection = object(record.connection, "approval connection");
  const mode = connection.mode;
  if (mode !== "settings-root" && mode !== "verified-target") throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token connection mode is invalid.");
  exact(connection, mode === "settings-root"
    ? ["mode", "operationId", "transactionId", "vaultId", "connectionDigest"]
    : ["mode", "operationId", "vaultId", "connectionDigest"], "approval connection");
  uuid(connection.operationId, "operationId");
  uuid(connection.vaultId, "vaultId");
  if (mode === "settings-root") uuid(connection.transactionId, "transactionId");
  const connectionDigest = digest(connection.connectionDigest, "connectionDigest");
  let model: ApprovalModel | undefined;
  if ("model" in record) {
    const member = object(record.model, "approval model");
    exact(member, ["manifest", "manifestDigest", "configDigest", "expectedCurrent"], "approval model");
    const parsedManifest = parseModelSetAcquisitionManifest(member.manifest);
    if (canonicalTokenJson(member.manifest) !== canonicalTokenJson(parsedManifest)) {
      throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token model manifest is not the strict acquisition manifest.");
    }
    const manifestDigest = digest(member.manifestDigest, "manifestDigest");
    if (manifestDigest !== modelAcquisitionApprovalDigest(parsedManifest)) {
      throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token model manifest digest does not match its manifest.");
    }
    model = {
      manifest: parsedManifest,
      manifestDigest,
      configDigest: digest(member.configDigest, "configDigest"),
      expectedCurrent: member.expectedCurrent === "sha256:absent" ? "sha256:absent" : digest(member.expectedCurrent, "expectedCurrent"),
    };
  }
  return {
    version: TOKEN_VERSION,
    target: { vault: target.vault, source: target.source as WriteTargetSource },
    connection: mode === "settings-root"
      ? { mode, operationId: connection.operationId as string, transactionId: connection.transactionId as string, vaultId: connection.vaultId as string, connectionDigest }
      : { mode, operationId: connection.operationId as string, vaultId: connection.vaultId as string, connectionDigest },
    ...(model === undefined ? {} : { model }),
    modelsNoDefault: record.modelsNoDefault,
  };
}


function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (new Set(keys).size !== keys.length) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} contains duplicate JSON members.`);
  for (const key of keys) if (!allowed.includes(key)) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} contains unexpected field ${key}.`);
  for (const key of allowed) if (!optional.includes(key) && !Object.hasOwn(value, key)) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} is missing ${key}.`);
}

function uuid(value: unknown, label: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} must be a lowercase UUID.`);
}

function digest(value: unknown, label: string): Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new SetupCommandError("SETUP_TOKEN_INVALID", `${label} must be sha256:<64hex>.`);
  return parseDigest(value);
}

function encodeToken(canonical: string): string {
  return Buffer.from(canonical, "utf8").toString("base64url");
}

function canonicalTokenJson(value: unknown): string {
  return serialize(normalize(value));
}

type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

function normalize(value: unknown): Canonical {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return rawString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token numbers must be safe integers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object") throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token contains an unsupported JSON value.");
  const result: Record<string, Canonical> = Object.create(null);
  for (const [key, member] of Object.entries(value)) {
    const rawKey = rawString(key);
    if (Object.hasOwn(result, rawKey)) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token keys collide.");
    result[rawKey] = normalize(member);
  }
  return result;
}

function rawString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token contains an unpaired surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SetupCommandError("SETUP_TOKEN_INVALID", "Approval token contains an unpaired surrogate.");
    }
  }
  return value;
}

function serialize(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const objectValue = value as { readonly [key: string]: Canonical };
  return `{${Object.keys(objectValue).sort(compare).map(key => `${quote(key)}:${serialize(objectValue[key]!)}`).join(",")}}`;
}

function compare(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function quote(value: string): string {
  let output = "\"";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === "\"") output += "\\\"";
    else if (character === "\\") output += "\\\\";
    else if (code <= 0x1f) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

async function canonicalRoot(vault: string): Promise<string> {
  return realpath(vault);
}
