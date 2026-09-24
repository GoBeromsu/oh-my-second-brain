import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { admitWriteTarget, type WriteTarget } from "../capture/safe.js";
import { digestBytes, hashCanonical, parseDigest } from "./canonical.js";
import { claimPreparedContractSourceCommit, type ContractSourceCommitFacts, type ContractSourcePublicationLocator } from "./source-registry.js";
import { parseContractPolicyV5, serializeContractPolicyV5 } from "./contract-v5.js";
import { VAULT_PUBLICATION_LEASE, acquireTransactionLock, atomicWrite, releaseTransactionLock, syncDirectory } from "./file-lock.js";
import {
  createLegacyEquivalenceArchive,
  executeLegacyDecoderEquivalence,
  LEGACY_DECODER_EXECUTION_VERSION,
  LEGACY_EQUIVALENCE_POLICY_PATH,
  replayLegacyDecoderEquivalence,
  type LegacyEquivalenceArchive,
  type LegacyEquivalenceCandidate,
  type LegacyEquivalenceExecution,
  type LegacyEquivalenceHistoricalSource,
  type LegacyEquivalenceMaterial,
  type LegacyEquivalenceProposal,
} from "./legacy-equivalence.js";
import { inspectLegacyPublicationMarker, legacyPublicationReadSet, verifiedLegacySource, verifyLegacyPublicationEvidence, type LegacyPublicationProof } from "./legacy-publication-evidence.js";
import { normalizeTemplateControlPath, normalizeTemplateSourcePath, verifyTemplateControlPath, verifyTemplateSourcePath } from "./paths.js";
import type { Digest } from "./types.js";
import { parseVaultSettings } from "./vault-settings.js";
import { dirname, join } from "node:path";

export type VaultPublicationKind = "schema-migration" | "contract-publication" | "settings-update";
export type VaultPublicationFault = "after-plan" | "after-backup" | "after-staging" | "after-marker" | "after-output" | "after-complete-marker" | "after-receipt";
export type ContractHistoryKind = "publication" | "migration" | "source-review" | "relink";
export interface PublicationOptions {
  readonly fault?: (point: VaultPublicationFault, path?: string) => void | Promise<void>;
  /** Required only to roll back a completed transaction. It is not a second forward-approval field. */
  readonly rollbackApprovalDigest?: Digest;
}
interface Blob {
  readonly digest: Digest;
  readonly base64: string;
}
export interface VaultPublicationOutput {
  readonly path: string;
  readonly before: Blob | null;
  readonly after: Blob;
}
export interface ContractHistoryRecord {
  readonly version: 1;
  readonly transactionId: string;
  readonly kind: ContractHistoryKind;
  readonly revision: number;
  readonly previousPolicyDigest: Digest | null;
  readonly policyDigest: Digest;
  readonly decision: string;
  readonly review?: Readonly<Record<string, unknown>>;
}
export interface VaultPublicationPlan {
  readonly version: 1;
  readonly transactionId: string;
  readonly kind: VaultPublicationKind;
  readonly vaultId: string;
  /** Opaque proposal affinity; absolute host paths are never written into vault metadata. */
  readonly targetDigest: Digest;
  readonly markerBefore: Blob | null;
  readonly outputs: readonly VaultPublicationOutput[];
  readonly sources: readonly { readonly path: string; readonly digest: Digest }[];
  /** Private source-publication assertion. Omitted plans preserve the historical key absence. */
  readonly absentSources?: readonly string[];
  readonly evidence: readonly { readonly name: string; readonly content: Blob }[];
  readonly planDigest: Digest;
}
export interface VaultPublicationRequest {
  readonly transactionId?: string;
  readonly kind: VaultPublicationKind;
  readonly vaultId: string;
  readonly outputs: readonly { readonly path: string; readonly expectedDigest: Digest | null; readonly content: string }[];
  readonly sources?: readonly { readonly path: string; readonly digest: Digest }[];
  /** Ordinary publication only. Omitted means no absence assertion; source publication derives this privately. */
  readonly absentSources?: readonly string[];
  readonly evidence?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly history?: ContractHistoryInput;
}
export interface ContractHistoryInput {
  readonly kind: ContractHistoryKind;
  readonly decision: string;
  readonly review?: Readonly<Record<string, unknown>>;
}
export interface VaultPublicationReceipt {
  readonly version: 1;
  readonly transactionId: string;
  readonly kind: VaultPublicationKind;
  readonly planDigest: Digest;
  readonly status: "complete" | "rolled-back";
  readonly verified: readonly { readonly path: string; readonly digest: Digest | null }[];
}
interface PublicationMarker {
  readonly version: "oms.vault-publication.v1";
  readonly transactionId: string;
  readonly kind: VaultPublicationKind;
  readonly planDigest: Digest;
  readonly status: "in-progress" | "rolling-back" | "complete" | "rolled-back";
  readonly checksum: Digest;
}
export class VaultPublicationError extends Error {
  constructor(readonly code: "PUBLICATION_INVALID" | "PUBLICATION_CONFLICT" | "PUBLICATION_LOCKED" | "PUBLICATION_APPROVAL_REQUIRED" | "PUBLICATION_TARGET_UNVERIFIED" | "PUBLICATION_RESOURCE_EXHAUSTED", message: string) {
    super(`${code}: ${message}`);
    this.name = "VaultPublicationError";
  }
}

export type LegacyVaultPublicationStatus = "absent" | "publisher-marker" | "legacy-in-progress" | "legacy-invalid" | "legacy-ambiguous" | "legacy-inconsistent" | "legacy-unavailable" | "verified" | "migration-retry";
export interface LegacyVaultPublicationAdmission {
  readonly status: LegacyVaultPublicationStatus;
  readonly markerPath: string | null;
  readonly reasons: readonly string[];
  readonly unavailableSources: readonly { readonly templateId: string; readonly reason: string }[];
}
export interface LegacyVaultMigrationRequest {
  readonly transactionId?: string;
  readonly vaultId: string;
  /** Allowed only when .oms/settings.json is currently absent. */
  readonly missingSettings?: Readonly<{ readonly content: string }>;
}
interface LegacyAdmissionRecord {
  readonly root: string;
  readonly markerPath: string;
  readonly markerBytes: Uint8Array;
  readonly planPath: string;
  readonly planBytes: Uint8Array;
  readonly policyBytes: Uint8Array;
  readonly observedOutputs: ReadonlyMap<string, Uint8Array>;
  readonly proof: LegacyPublicationProof;
}
const legacyAdmissions = new WeakMap<LegacyVaultPublicationAdmission, LegacyAdmissionRecord>();
interface MigrationSlots {
  readonly migration: Uint8Array | null;
  readonly direct: Uint8Array | null;
  readonly backfill: Uint8Array | null;
}
interface MigrationSeal {
  readonly format: "v3" | "v4";
  readonly markerPath: string;
  readonly planPath: string;
  readonly policyDigest: Digest;
  readonly candidateDigest: Digest;
  readonly canonicalPolicy: string;
  readonly sources: readonly { readonly path: string; readonly digest: Digest }[];
  readonly slots: MigrationSlots;
  readonly predecessorPlanDigest: Digest | null;
}
interface MigrationRetryRecord {
  readonly root: string;
  readonly predecessorId: string;
  readonly predecessorDigest: Digest;
  readonly receipt: VaultPublicationReceipt;
  readonly slots: MigrationSlots;
  readonly archive: Omit<LegacyAdmissionRecord, "proof">;
}
const migrationRetryAdmissions = new WeakMap<LegacyVaultPublicationAdmission, MigrationRetryRecord>();
interface RetainedPublicationRecord {
  readonly root: string;
  readonly predecessorId: string;
  readonly predecessorDigest: Digest;
  readonly predecessorKind: VaultPublicationKind;
  readonly retained: Uint8Array;
  readonly slots: MigrationSlots;
}
const retainedPublications = new WeakMap<LegacyVaultPublicationAdmission, RetainedPublicationRecord>();
const MARKER = ".oms/template-transaction.json";
const LEGACY_MARKERS = [".oms/template-migration.json", ".oms/template-transaction.json", ".oms/template-backfill.json"] as const;
const POLICY = ".oms/template-policy.json";
const SETTINGS = ".oms/settings.json";
const HISTORY = /^\.oms\/history\/contracts\/(\d+)\.json$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_OBSERVATION_FILES = 256;
const MIGRATION_DECISION = "automatic historical equivalence; not human authorization";

function invalid(message: string): never { throw new VaultPublicationError("PUBLICATION_INVALID", message); }
function sourceHistoryOf(plan: VaultPublicationPlan): ContractHistoryRecord | null {
  if (plan.kind !== "contract-publication") return null;
  const history = plan.outputs.find(output => historyRevision(output.path) !== null);
  if (history === undefined) return null;
  const record = parseHistory(utf8(bytesOf(history.after)));
  return record.kind === "source-review" || record.kind === "relink" ? record : null;
}
function assertSourcePlanAssertions(plan: VaultPublicationPlan): void {
  const record = sourceHistoryOf(plan);
  if (record === null) return;
  const review = record.review;
  if (review === undefined) invalid("source publication history review is missing");
  const acknowledgment = record.kind === "source-review";
  const fields: readonly string[] = acknowledgment ? SOURCE_REVIEW_FIELDS : SOURCE_RELINK_FIELDS;
  if (Object.keys(review).length !== fields.length || Object.keys(review).some(key => !fields.includes(key))) invalid("source publication history review fields are not exact");
  if (record.decision !== (acknowledgment ? SOURCE_REVIEW_DECISION : SOURCE_RELINK_DECISION) || review.operation !== (acknowledgment ? "source-acknowledgment" : "source-relink")) invalid("source publication history decision is not factual");
  const toPath = record.kind === "source-review" ? review.sourcePath : review.toPath;
  const digest = review.reviewedRawDigest;
  if (typeof toPath !== "string" || typeof digest !== "string") invalid("source publication assertions are not factual");
  if (plan.sources.length !== 1 || plan.sources[0]?.path !== toPath || plan.sources[0]?.digest !== digest) invalid("source publication positive assertion is not exact");
  if (record.kind === "source-review" && plan.absentSources !== undefined) invalid("source acknowledgment cannot assert absence");
  if (record.kind === "relink" && (typeof review.fromPath !== "string" || plan.absentSources?.length !== 1 || plan.absentSources[0] !== review.fromPath)) invalid("source relocation absence assertion is not exact");
}
async function assertSourcePortableIdentity(root: string, plan: VaultPublicationPlan): Promise<void> {
  const settings = await readControl(root, SETTINGS);
  if (settings === null || parseVaultSettings(utf8(settings)).vaultId !== plan.vaultId) conflict("Source publication portable vault identity changed");
}
function conflict(message: string): never { throw new VaultPublicationError("PUBLICATION_CONFLICT", message); }
function blob(bytes: Uint8Array): Blob { return { digest: digestBytes(bytes), base64: Buffer.from(bytes).toString("base64") }; }
function material(plan: VaultPublicationPlan): Omit<VaultPublicationPlan, "planDigest"> {
  const { planDigest: _digest, ...rest } = plan;
  return rest;
}
function planHash(plan: Omit<VaultPublicationPlan, "planDigest">): Digest { return hashCanonical("oms.vault-publication.plan.v1", plan); }
function bytesOf(value: Blob): Buffer {
  if (value === null || typeof value !== "object" || typeof value.base64 !== "string" || typeof value.digest !== "string") invalid("invalid byte snapshot");
  if (value.base64.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4) invalid("snapshot exceeds the explicit 8 MiB publication limit");
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.toString("base64") !== value.base64 || digestBytes(bytes) !== value.digest) invalid("snapshot checksum or encoding mismatch");
  return bytes;
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { invalid("control output must be valid UTF-8"); }
}
function rootFor(plan: Pick<VaultPublicationPlan, "kind" | "transactionId">): string {
  if (!UUID.test(plan.transactionId)) invalid("transactionId must be a lowercase UUID");
  return plan.kind === "schema-migration" ? `.oms/migrations/${plan.transactionId}` : `.oms/.template-transactions/${plan.transactionId}`;
}
function historyRevision(path: string): number | null {
  const match = HISTORY.exec(path);
  if (match === null) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}
function outputPath(kind: VaultPublicationKind, path: string): boolean {
  if (path === POLICY) return kind !== "settings-update";
  if (path === SETTINGS) return kind !== "contract-publication";
  return historyRevision(path) !== null && kind !== "settings-update";
}
function parseHistory(text: string): ContractHistoryRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid("contract history is not JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid("contract history must be a JSON object");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => !["version", "transactionId", "kind", "revision", "previousPolicyDigest", "policyDigest", "decision", "review"].includes(key))) invalid("contract history contains an unapproved member");
  if (record.version !== 1 || !UUID.test(String(record.transactionId)) || !["publication", "migration", "source-review", "relink"].includes(String(record.kind))) invalid("contract history version, transaction or kind is invalid");
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) invalid("contract history revision is invalid");
  if (record.previousPolicyDigest !== null && (typeof record.previousPolicyDigest !== "string" || !DIGEST.test(record.previousPolicyDigest))) invalid("previous policy digest is invalid");
  if (typeof record.policyDigest !== "string" || !DIGEST.test(record.policyDigest) || typeof record.decision !== "string" || record.decision.trim() === "") invalid("policy digest or decision is invalid");
  if (record.review !== undefined && (record.review === null || typeof record.review !== "object" || Array.isArray(record.review))) invalid("history review detail must be a structured object");
  return record as unknown as ContractHistoryRecord;
}
/** Builds the one immutable history payload. It never invents an approval field or hashes the sealed plan. */
export function contractHistoryRecord(input: ContractHistoryInput & { readonly transactionId: string; readonly revision: number; readonly previousPolicyDigest: Digest | null; readonly policyDigest: Digest }): ContractHistoryRecord {
  if (!UUID.test(input.transactionId) || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.decision.trim() === "") invalid("history builder received an incomplete publication decision");
  if (input.previousPolicyDigest !== null) parseDigest(input.previousPolicyDigest);
  parseDigest(input.policyDigest);
  return parseHistory(JSON.stringify({
    version: 1,
    transactionId: input.transactionId,
    kind: input.kind,
    revision: input.revision,
    previousPolicyDigest: input.previousPolicyDigest,
    policyDigest: input.policyDigest,
    decision: input.decision,
    ...(input.review === undefined ? {} : { review: input.review }),
  }));
}
function validateOutputs(plan: Pick<VaultPublicationPlan, "kind" | "transactionId" | "outputs">): void {
  const paths = new Set(plan.outputs.map(output => output.path));
  if (paths.size !== plan.outputs.length || plan.outputs.some(output => !outputPath(plan.kind, output.path))) invalid("output is duplicated or outside the authoritative control allowlist");
  const policy = plan.outputs.find(output => output.path === POLICY);
  const history = plan.outputs.filter(output => historyRevision(output.path) !== null);
  if (plan.kind === "settings-update") {
    if (paths.size !== 1 || !paths.has(SETTINGS)) invalid("settings update allows only settings.json");
    return;
  }
  if (policy === undefined) invalid("policy publication requires template-policy.json");
  if (history.length !== 1 || paths.size > (plan.kind === "schema-migration" ? 3 : 2)) invalid("policy publication requires exactly one new history record");
  if (plan.kind === "contract-publication" && paths.size !== 2) invalid("contract publication allows only policy and one new history record");
  const next = parseContractPolicyV5(utf8(bytesOf(policy.after)));
  const previous = plan.kind === "contract-publication" && policy.before !== null ? parseContractPolicyV5(utf8(bytesOf(policy.before))) : null;
  if (plan.kind === "contract-publication" && next.revision !== (previous === null ? 0 : previous.revision + 1)) invalid("normal policy publication must advance exactly one revision, or start at revision 0");
  const output = history[0]!;
  const record = parseHistory(utf8(bytesOf(output.after)));
  if (output.before !== null) invalid("contract history is immutable and must be absent");
  if (historyRevision(output.path) !== record.revision || record.revision !== next.revision) invalid("history path and revision must match the published policy");
  if (record.transactionId !== plan.transactionId || record.policyDigest !== policy.after.digest || record.previousPolicyDigest !== (policy.before?.digest ?? null)) invalid("history must bind this transaction and the exact raw policy bytes");
  if (plan.kind === "schema-migration" && record.kind !== "migration") invalid("schema migration history kind must be migration");
  if (plan.kind === "contract-publication" && record.kind === "migration") invalid("ordinary publication cannot claim a migration history kind");
}
function validatePlan(plan: VaultPublicationPlan): void {
  if (!plan || plan.version !== 1 || !["schema-migration", "contract-publication", "settings-update"].includes(plan.kind) || !UUID.test(plan.vaultId) || !DIGEST.test(plan.targetDigest)) invalid("invalid publication version, kind or target identity");
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_BLOB_BYTES) invalid("sealed plan exceeds the explicit 8 MiB publication limit");
  rootFor(plan);
  if (!Array.isArray(plan.outputs) || plan.outputs.length === 0 || plan.outputs.length > 3) invalid("output is duplicated or outside the closed output manifest");
  for (const output of plan.outputs) {
    if (output.before !== null) bytesOf(output.before);
    const bytes = bytesOf(output.after);
    const text = utf8(bytes);
    if (output.path === SETTINGS) {
      if (parseVaultSettings(text).vaultId !== plan.vaultId) invalid("settings must preserve the approved portable vault identity");
      if (output.before !== null && parseVaultSettings(bytesOf(output.before).toString("utf8")).vaultId !== plan.vaultId) invalid("settings must not replace an existing portable vault identity");
    }
  }
  validateOutputs(plan);
  if (plan.markerBefore !== null) bytesOf(plan.markerBefore);
  if (!Array.isArray(plan.sources) || !Array.isArray(plan.evidence)) invalid("source and evidence inventories must be arrays");
  const sources = new Set<string>();
  for (const source of plan.sources) {
    if (normalizeTemplateSourcePath(source.path) !== source.path || !DIGEST.test(source.digest) || sources.has(source.path)) invalid("source expectation must be unique, canonical and SHA-bound");
    sources.add(source.path);
  }
  if (plan.absentSources !== undefined) {
    if (plan.kind !== "contract-publication" || !Array.isArray(plan.absentSources)) invalid("absent source inventory belongs only to ordinary contract publication");
    const absent = new Set<string>();
    for (const path of plan.absentSources) {
      if (typeof path !== "string" || normalizeTemplateSourcePath(path) !== path || absent.has(path) || sources.has(path)) invalid("absent source expectation must be unique, canonical and disjoint from positive sources");
      absent.add(path);
    }
  }
  const names = new Set<string>();
  for (const evidence of plan.evidence) {
    if (!/^[a-z][a-z0-9.-]{0,80}$/.test(evidence.name) || names.has(evidence.name)) invalid("evidence name must be unique and confined");
    names.add(evidence.name);
    bytesOf(evidence.content);
  }
  if (planHash(material(plan)) !== plan.planDigest) invalid("plan digest mismatch");
  assertSourcePlanAssertions(plan);
}
async function admitted(target: WriteTarget): Promise<string> {
  if (await admitWriteTarget(target) !== undefined || !["explicit", "vault", "bridge", "env"].includes(target.source)) throw new VaultPublicationError("PUBLICATION_TARGET_UNVERIFIED", "A verified vault target is required for publication or recovery.");
  return realpath(target.vault);
}
async function control(root: string, path: string): Promise<string> {
  if (normalizeTemplateControlPath(path) !== path) invalid("noncanonical control path");
  const verified = await verifyTemplateControlPath(root, normalizeTemplateControlPath(path), { expected: "either" });
  if (verified.targetRealPath !== null) {
    const stat = await lstat(verified.absolutePath);
    if (!stat.isFile() || stat.nlink !== 1) invalid("control leaf must be a regular file without hard links");
  }
  return verified.absolutePath;
}
async function readControl(root: string, path: string): Promise<Buffer | null> {
  const absolute = await control(root, path);
  try {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BLOB_BYTES) invalid("control file is unsafe or oversized");
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
function matches(bytes: Buffer | null, expected: Blob | null): boolean { return bytes === null ? expected === null : expected !== null && digestBytes(bytes) === expected.digest; }
async function ensureParent(root: string, relativePath: string): Promise<void> {
  await control(root, relativePath);
  let parent = root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    const next = join(parent, part);
    try { await mkdir(next, { mode: 0o700 }); await syncDirectory(parent); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = await lstat(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("publication directory was replaced or is unsafe");
    parent = next;
  }
}

async function ensureLeaseDirectory(root: string): Promise<void> {
  const relativePath = dirname(VAULT_PUBLICATION_LEASE);
  let parent = root;
  for (const part of relativePath.split("/")) {
    const next = join(parent, part);
    const relation = relative(root, next);
    if (relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) invalid("publication lock escapes the vault");
    try {
      const stat = await lstat(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) invalid("publication lock directory was replaced or is unsafe");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(next, { mode: 0o700 });
      await syncDirectory(parent);
      const created = await lstat(next);
      if (created.isSymbolicLink() || !created.isDirectory()) invalid("publication lock directory was replaced or is unsafe");
    }
    parent = next;
  }
}
async function put(root: string, path: string, bytes: Uint8Array): Promise<void> {
  await ensureParent(root, path);
  await atomicWrite(await control(root, path), bytes);
}
async function seal(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const existing = await readControl(root, path);
  if (existing !== null) {
    if (!existing.equals(Buffer.from(bytes))) conflict(`Sealed evidence changed: ${path}`);
    return;
  }
  await put(root, path, bytes);
}
function markerBytes(plan: VaultPublicationPlan, status: PublicationMarker["status"]): Buffer {
  const value = { version: "oms.vault-publication.v1" as const, transactionId: plan.transactionId, kind: plan.kind, planDigest: plan.planDigest, status };
  return Buffer.from(`${JSON.stringify({ ...value, checksum: hashCanonical("oms.vault-publication.marker.v1", value) })}\n`);
}
function parseMarker(bytes: Buffer): PublicationMarker {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid("publication marker is malformed"); }
  if (!parsed || typeof parsed !== "object") invalid("publication marker is not an object");
  const marker = parsed as PublicationMarker;
  const { checksum, ...value } = marker;
  if (marker.version !== "oms.vault-publication.v1" || !UUID.test(marker.transactionId) || !["schema-migration", "contract-publication", "settings-update"].includes(marker.kind) || !["in-progress", "rolling-back", "complete", "rolled-back"].includes(marker.status) || checksum !== hashCanonical("oms.vault-publication.marker.v1", value)) invalid("publication marker fields or checksum are invalid");
  return marker;
}
async function verifyAbsentSources(root: string, plan: VaultPublicationPlan): Promise<void> {
  for (const path of plan.absentSources ?? []) {
    const normalized = normalizeTemplateSourcePath(path);
    const ancestors: { path: string; stat: Stats }[] = [];
    let current = root;
    let missingParent: string | undefined;
    for (const segment of ["", ...normalized.split("/").slice(0, -1)]) {
      if (segment !== "") current = join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) conflict(`Absent source ancestor is unsafe: ${path}`);
        ancestors.push({ path: current, stat });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        missingParent = current;
        break;
      }
    }
    const verified = await verifyTemplateSourcePath(root, normalized, { expected: "absent" });
    if (verified.vaultRoot !== root || verified.targetRealPath !== null) conflict(`Absent source changed before publication: ${path}`);
    for (const ancestor of ancestors) {
      const after = await lstat(ancestor.path);
      if (ancestor.stat.dev !== after.dev || ancestor.stat.ino !== after.ino || after.isSymbolicLink() || !after.isDirectory()) conflict(`Absent source ancestor changed before publication: ${path}`);
    }
    if (missingParent !== undefined) {
      try {
        await lstat(missingParent);
        conflict(`Absent source ancestor appeared during observation: ${path}`);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    try {
      await lstat(verified.absolutePath);
      conflict(`Absent source reappeared before publication: ${path}`);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}
/**
 * Directory identities that carried the observed absence when the private
 * capability was prepared. A later substitution of one of these directories
 * can hide a still-present original source, so it is recorded, not re-derived.
 */
async function observeAbsentSourceAncestors(root: string, plan: VaultPublicationPlan): Promise<readonly { readonly path: string; readonly dev: number; readonly ino: number }[]> {
  const observed: { path: string; dev: number; ino: number }[] = [];
  for (const path of plan.absentSources ?? []) {
    const normalized = normalizeTemplateSourcePath(path);
    let current = root;
    for (const segment of ["", ...normalized.split("/").slice(0, -1)]) {
      if (segment !== "") current = join(current, segment);
      let stat: Stats;
      try { stat = await lstat(current); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        break;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) conflict(`Absent source ancestor is unsafe: ${path}`);
      observed.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
  }
  return observed;
}
async function assertPreparedAbsentAncestors(observed: readonly { readonly path: string; readonly dev: number; readonly ino: number }[]): Promise<void> {
  for (const ancestor of observed) {
    let stat: Stats;
    try { stat = await lstat(ancestor.path); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      conflict(`Absent source ancestor changed before publication: ${ancestor.path}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino) {
      conflict(`Absent source ancestor changed before publication: ${ancestor.path}`);
    }
  }
}
async function verifyPublicationSources(root: string, plan: VaultPublicationPlan): Promise<void> {
  if (sourceHistoryOf(plan) !== null) await assertSourcePortableIdentity(root, plan);
  await verifySources(root, plan);
  await verifyAbsentSources(root, plan);
}
async function verifySources(root: string, plan: VaultPublicationPlan): Promise<void> {
  for (const source of plan.sources) {
    const verified = await verifyTemplateSourcePath(root, normalizeTemplateSourcePath(source.path));
    const handle = await open(verified.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BLOB_BYTES || digestBytes(await handle.readFile()) !== source.digest) conflict(`Source changed before publication: ${source.path}`);
    } finally { await handle.close(); }
  }
}
function historyContent(request: VaultPublicationRequest, policy: { readonly path: string; readonly content: string; readonly expectedDigest: Digest | null }, revision: number): string {
  if (request.history === undefined || request.transactionId === undefined) invalid("policy publication requires an explicit history decision and transaction id");
  return `${JSON.stringify(contractHistoryRecord({ ...request.history, transactionId: request.transactionId, revision, previousPolicyDigest: policy.expectedDigest, policyDigest: digestBytes(policy.content) }))}\n`;
}

/** Read-only proposal; source Markdown, ordinary notes, indexes and caches cannot be outputs. */
export async function planVaultPublication(target: WriteTarget, request: VaultPublicationRequest): Promise<VaultPublicationPlan> {
  target = { vault: target.vault, source: target.source };
  request = structuredClone(request);
  if (request.history?.kind === "source-review" || request.history?.kind === "relink") invalid("source publication requires the dedicated private source planner");
  const root = await admitted(target);
  const plan = await planOrdinaryPublication(root, request);
  if (sourceHistoryOf(plan) !== null) invalid("source publication requires the dedicated private source planner");
  return plan;
}
async function planOrdinaryPublication(root: string, request: VaultPublicationRequest): Promise<VaultPublicationPlan> {
  if (request.kind === "schema-migration") invalid("schema migration requires the dedicated private-admission planner");
  if (request.kind !== "contract-publication" && request.absentSources !== undefined) invalid("absence assertions belong only to ordinary contract publication");
  const inspected = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
  if (inspected.status !== "absent" && inspected.status !== "publisher-marker") conflict(`Historical publication marker blocks ordinary publication: ${inspected.status}`);
  const carrier = retainedPublications.get(inspected);
  if ((request.evidence ?? []).some(item => item.name === "retained-v3")) invalid("retained v3 provenance is derived privately and cannot be supplied");
  const policy = request.outputs.find(output => output.path === POLICY);
  const supplied = [...request.outputs];
  if (policy !== undefined && request.kind !== "settings-update" && !supplied.some(output => historyRevision(output.path) !== null)) {
    const parsed = parseContractPolicyV5(policy.content);
    supplied.push({ path: `.oms/history/contracts/${parsed.revision}.json`, expectedDigest: null, content: historyContent(request, policy, parsed.revision) });
  }
  const outputs: VaultPublicationOutput[] = [];
  for (const output of supplied) {
    if (!outputPath(request.kind, output.path)) invalid("output is outside the authoritative control allowlist");
    const before = await readControl(root, output.path);
    if ((before === null ? null : digestBytes(before)) !== output.expectedDigest) conflict(`Proposal preimage changed: ${output.path}`);
    outputs.push({ path: output.path, before: before === null ? null : blob(before), after: blob(Buffer.from(output.content)) });
  }
  const oldMarker = await readControl(root, MARKER);
  if (oldMarker !== null) {
    const prior = parseMarker(oldMarker);
    if (prior.status === "in-progress" || prior.status === "rolling-back") conflict("A prior publication must be recovered first");
    await assertOrdinaryPredecessor(root, prior);
  }
  const planned = {
    version: 1 as const,
    transactionId: request.transactionId ?? randomUUID(),
    kind: request.kind,
    vaultId: request.vaultId,
    targetDigest: digestBytes(root),
    markerBefore: oldMarker === null ? null : blob(oldMarker),
    outputs,
    sources: (request.sources ?? []).map(source => ({ path: source.path, digest: source.digest })),
    ...(request.absentSources === undefined ? {} : { absentSources: [...request.absentSources] }),
    evidence: [...(carrier === undefined ? [] : [{ name: "retained-v3", content: blob(carrier.retained) }]), ...(request.evidence ?? []).map(item => ({ name: item.name, content: blob(item.bytes) }))],
  };
  const plan = { ...planned, planDigest: planHash(planned) };
  validatePlan(plan);
  await verifyPublicationSources(root, plan);
  return plan;
}

async function locked<T>(root: string, body: () => Promise<T>): Promise<T> {
  const directory = join(root, dirname(VAULT_PUBLICATION_LEASE));
  const lock = join(root, VAULT_PUBLICATION_LEASE);
  await ensureLeaseDirectory(root);
  const token = await acquireTransactionLock(directory, lock);
  if (token === null) throw new VaultPublicationError("PUBLICATION_LOCKED", "Another vault publication or recovery holds the shared lock.");
  try { return await body(); }
  finally { await releaseTransactionLock(lock, token); }
}
async function loadPlan(root: string, kind: VaultPublicationKind, transactionId: string): Promise<VaultPublicationPlan> {
  const bytes = await readControl(root, `${rootFor({ kind, transactionId })}/plan.json`);
  if (bytes === null) invalid("sealed publication plan is missing");
  let plan: VaultPublicationPlan;
  try { plan = JSON.parse(bytes.toString("utf8")) as VaultPublicationPlan; } catch { invalid("sealed publication plan is malformed"); }
  validatePlan(plan);
  if (plan.transactionId !== transactionId || plan.kind !== kind) invalid("sealed plan belongs to another transaction root");
  return plan;
}
async function verifySealed(root: string, plan: VaultPublicationPlan): Promise<void> {
  const base = rootFor(plan);
  for (const [index, output] of plan.outputs.entries()) {
    const before = await readControl(root, `${base}/backups/${index}.bin`);
    const expected = output.before === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytesOf(output.before)]);
    if (before === null || !before.equals(expected)) invalid("publication backup is missing or changed");
    const after = await readControl(root, `${base}/staged/${index}.bin`);
    if (after === null || !after.equals(bytesOf(output.after))) invalid("publication staged output is missing or changed");
  }
  for (const evidence of plan.evidence) {
    const bytes = await readControl(root, `${base}/evidence/${evidence.name}.bin`);
    if (bytes === null || !bytes.equals(bytesOf(evidence.content))) invalid("immutable publication evidence is missing or changed");
  }
}
function receiptBytes(value: VaultPublicationReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
function sealedReceipt(bytes: Buffer, expected: VaultPublicationReceipt): VaultPublicationReceipt | null {
  if (!bytes.equals(receiptBytes(expected))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) return null;
  return expected;
}
async function receipt(root: string, plan: VaultPublicationPlan, rollback: boolean): Promise<VaultPublicationReceipt> {
  const verified: { path: string; digest: Digest | null }[] = [];
  for (const output of plan.outputs) {
    const expected = rollback ? output.before : output.after;
    if (!matches(await readControl(root, output.path), expected)) conflict(`Publication postcondition failed: ${output.path}`);
    verified.push({ path: output.path, digest: expected?.digest ?? null });
  }
  return { version: 1, transactionId: plan.transactionId, kind: plan.kind, planDigest: plan.planDigest, status: rollback ? "rolled-back" : "complete", verified };
}
/** A sealed terminal receipt is completion evidence even when the marker crash left it non-terminal. */
async function observedTerminalReceipt(root: string, plan: VaultPublicationPlan, rollback: boolean): Promise<VaultPublicationReceipt | null> {
  const terminal = rollback ? "rolled-back" : "complete";
  const existing = await readControl(root, `${rootFor(plan)}/${terminal}-receipt.json`);
  if (existing === null) return null;
  const expected: VaultPublicationReceipt = { version: 1, transactionId: plan.transactionId, kind: plan.kind, planDigest: plan.planDigest, status: terminal, verified: plan.outputs.map(output => { const image = rollback ? output.before : output.after; return { path: output.path, digest: image?.digest ?? null }; }) };
  const parsed = sealedReceipt(existing, expected);
  if (parsed === null) invalid(`sealed ${terminal} receipt does not match the sealed publication plan`);
  return parsed;
}
async function assertOrdinaryPredecessor(root: string, marker: PublicationMarker): Promise<void> {
  if (marker.kind === "schema-migration" && marker.status === "rolled-back") conflict("Rolled-back migration requires explicit migration retry before ordinary publication");
  if (marker.status !== "complete" && marker.status !== "rolled-back") conflict("A prior publication must be recovered first");
  const predecessor = await loadPlan(root, marker.kind, marker.transactionId);
  if (predecessor.planDigest !== marker.planDigest) invalid("predecessor marker and sealed plan disagree");
  await verifySealed(root, predecessor);
  if (await observedTerminalReceipt(root, predecessor, marker.status === "rolled-back") === null) invalid("predecessor terminal receipt is missing");
}
async function revalidatePublicationPhase(root: string, plan: VaultPublicationPlan, rollback: boolean): Promise<void> {
  if (sourceHistoryOf(plan) !== null) await assertSourcePortableIdentity(root, plan);
  if (plan.kind === "schema-migration") await admitMigrationPhase(root, plan, rollback ? "rollback" : "commit");
  else await admitRetainedPublication(root, plan);
  const current = await readControl(root, MARKER);
  if (current === null) conflict("Publication marker disappeared before transition");
  const marker = parseMarker(current);
  if (marker.kind !== plan.kind || marker.transactionId !== plan.transactionId || marker.planDigest !== plan.planDigest) conflict("Another publication owns the vault marker");
  if (!rollback && (marker.status === "rolling-back" || marker.status === "rolled-back")) conflict("This publication is rolling back; it cannot be resumed forward");
}
async function verifyTerminalPostimages(root: string, plan: VaultPublicationPlan, sealed: VaultPublicationReceipt): Promise<void> {
  for (const output of plan.outputs) {
    const expected = sealed.status === "rolled-back" ? output.before : output.after;
    if (!matches(await readControl(root, output.path), expected)) conflict(`Publication postcondition failed: sealed ${sealed.status} receipt requires its live ${sealed.status === "rolled-back" ? "preimages" : "postimages"}: ${output.path}`);
  }
}
async function finalizeSealedReceipt(root: string, plan: VaultPublicationPlan, marker: PublicationMarker, rollback: boolean, sealed: VaultPublicationReceipt): Promise<VaultPublicationReceipt> {
  await verifyTerminalPostimages(root, plan, sealed);
  if (marker.status !== sealed.status) {
    await revalidatePublicationPhase(root, plan, rollback);
    await put(root, MARKER, markerBytes(plan, sealed.status));
  }
  return sealed;
}
function rollbackApproval(plan: VaultPublicationPlan): Digest {
  return hashCanonical("oms.vault-publication.rollback.v1", { transactionId: plan.transactionId, planDigest: plan.planDigest, postimages: plan.outputs.map(output => ({ path: output.path, digest: output.after.digest, before: output.before?.digest ?? null })) });
}
/** Read-only digest over the sealed plan, paths, preimages and postimages. It authorizes completed rollback only. */
export function prepareRollbackApprovalDigest(plan: VaultPublicationPlan): Digest {
  validatePlan(plan);
  return rollbackApproval(plan);
}
async function applyOutputs(root: string, plan: VaultPublicationPlan, rollback: boolean, options: PublicationOptions): Promise<void> {
  for (const output of rollback ? [...plan.outputs].reverse() : plan.outputs) {
    const expected = rollback ? output.before : output.after;
    const current = await readControl(root, output.path);
    if (matches(current, expected)) continue;
    if (!matches(current, rollback ? output.after : output.before)) conflict(`External bytes changed during recovery: ${output.path}`);
    if (expected === null) {
      await rm(await control(root, output.path));
      await syncDirectory(dirname(join(root, output.path)));
    } else await put(root, output.path, bytesOf(expected));
    await options.fault?.("after-output", output.path);
  }
}
async function publishPrepared(root: string, plan: VaultPublicationPlan, rollback: boolean, options: PublicationOptions): Promise<VaultPublicationReceipt> {
  await verifySealed(root, plan);
  const currentMarker = await readControl(root, MARKER);
  if (currentMarker === null) conflict("Publication marker disappeared");
  const marker = parseMarker(currentMarker);
  if (marker.transactionId !== plan.transactionId || marker.planDigest !== plan.planDigest || marker.kind !== plan.kind) conflict("Another publication owns the vault marker");
  const terminal = rollback ? "rolled-back" : "complete";
  const receiptPath = `${rootFor(plan)}/${terminal}-receipt.json`;
  const forwardReceipt = await observedTerminalReceipt(root, plan, false);
  if (marker.status === "complete" && forwardReceipt === null) invalid("complete marker requires its already sealed receipt; a missing receipt is not invented");
  if (!rollback && (marker.status === "rolling-back" || marker.status === "rolled-back")) conflict("This publication is rolling back; it cannot be resumed forward");
  const sealed = rollback ? await observedTerminalReceipt(root, plan, true) : forwardReceipt;
  if (rollback && (marker.status === "complete" || forwardReceipt !== null) && options.rollbackApprovalDigest !== rollbackApproval(plan)) throw new VaultPublicationError("PUBLICATION_APPROVAL_REQUIRED", "Completed rollback requires a separate approval bound to the sealed plan and postimages.");
  if (sealed !== null) return finalizeSealedReceipt(root, plan, marker, rollback, sealed);
  if (marker.status === terminal) invalid("complete marker requires its already sealed receipt; a missing receipt is not invented");
  for (const output of plan.outputs) {
    const current = await readControl(root, output.path);
    if (!matches(current, output.before) && !matches(current, output.after)) conflict(`External bytes block recovery: ${output.path}`);
  }
  if (!rollback) await verifyPublicationSources(root, plan);
  await revalidatePublicationPhase(root, plan, rollback);
  if (rollback && marker.status !== "rolling-back") await put(root, MARKER, markerBytes(plan, "rolling-back"));
  await applyOutputs(root, plan, rollback, options);
  const result = await receipt(root, plan, rollback);
  await revalidatePublicationPhase(root, plan, rollback);
  if (!rollback) await verifyPublicationSources(root, plan);
  await seal(root, receiptPath, receiptBytes(result));
  await options.fault?.("after-receipt");
  await revalidatePublicationPhase(root, plan, rollback);
  await put(root, MARKER, markerBytes(plan, terminal));
  await options.fault?.("after-complete-marker");
  return result;
}

export async function commitVaultPublication(target: WriteTarget, plan: VaultPublicationPlan, approvedDigest: Digest, options: PublicationOptions = {}): Promise<VaultPublicationReceipt> {
  const privatelyAdmitted = admittedSourcePlans.has(plan);
  plan = structuredClone(plan);
  target = { vault: target.vault, source: target.source };
  validatePlan(plan);
  if (approvedDigest !== plan.planDigest) throw new VaultPublicationError("PUBLICATION_APPROVAL_REQUIRED", "Approval must bind this exact publication plan.");
  const root = await admitted(target);
  if (digestBytes(root) !== plan.targetDigest) conflict("The approved proposal belongs to another vault target");
  const sourceHistory = sourceHistoryOf(plan);
  if (sourceHistory !== null && (sourceHistory.kind === "source-review" || sourceHistory.kind === "relink")) {
    const templateId = sourceHistory.review?.templateId;
    if (typeof templateId !== "string") invalid("source publication template identity is missing");
    assertRecoveredSourcePlan(plan, { transactionId: plan.transactionId, kind: sourceHistory.kind, templateId }, root);
  }
  const assertSourceAdmission = async (): Promise<void> => {
    if (sourceHistory === null) return;
    await assertSourcePortableIdentity(root, plan);
    if (privatelyAdmitted) return;
    const storedPlan = await readControl(root, `${rootFor(plan)}/plan.json`);
    if (storedPlan === null || storedPlan.toString("utf8") !== `${JSON.stringify(plan)}\n`) invalid("source publication first seal requires the private factory plan");
  };
  await assertSourceAdmission();
  if (plan.kind === "schema-migration") await validateMigrationPlan(root, plan);
  return locked(root, async () => {
    await assertSourceAdmission();
    if (plan.kind === "schema-migration") await admitMigrationPhase(root, plan, "commit");
    else { await refuseLegacyPublication(root); await admitRetainedPublication(root, plan); }
    const base = rootFor(plan);
    const stored = await readControl(root, `${base}/plan.json`);
    if (stored !== null) {
      const existing = await loadPlan(root, plan.kind, plan.transactionId);
      if (existing.planDigest !== plan.planDigest) conflict("Transaction id already identifies another sealed plan");
    }
    const currentMarker = await readControl(root, MARKER);
    if (!matches(currentMarker, plan.markerBefore)) {
      if (currentMarker === null) conflict("Marker changed since proposal");
      const marker = parseMarker(currentMarker);
      if (stored === null || marker.transactionId !== plan.transactionId || marker.planDigest !== plan.planDigest) conflict("Marker changed since proposal");
      return publishPrepared(root, plan, false, options);
    }
    if (plan.kind !== "schema-migration" && currentMarker !== null) await assertOrdinaryPredecessor(root, parseMarker(currentMarker));
    for (const output of plan.outputs) if (!matches(await readControl(root, output.path), output.before)) conflict(`Control preimage changed: ${output.path}`);
    await verifyPublicationSources(root, plan);
    if (plan.kind === "schema-migration") await validateMigrationPlan(root, plan);
    await seal(root, `${base}/plan.json`, Buffer.from(`${JSON.stringify(plan)}\n`));
    await options.fault?.("after-plan");
    for (const [index, output] of plan.outputs.entries()) {
      await seal(root, `${base}/backups/${index}.bin`, output.before === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytesOf(output.before)]));
      await options.fault?.("after-backup", output.path);
      await seal(root, `${base}/staged/${index}.bin`, bytesOf(output.after));
      await options.fault?.("after-staging", output.path);
    }
    for (const evidence of plan.evidence) await seal(root, `${base}/evidence/${evidence.name}.bin`, bytesOf(evidence.content));
    for (const output of plan.outputs) if (!matches(await readControl(root, output.path), output.before)) conflict(`Control changed during staging: ${output.path}`);
    if (plan.kind === "schema-migration") await validateMigrationPlan(root, plan);
    else {
      await admitRetainedPublication(root, plan);
      const predecessorMarker = await readControl(root, MARKER);
      if (predecessorMarker !== null) await assertOrdinaryPredecessor(root, parseMarker(predecessorMarker));
    }
    await verifyPublicationSources(root, plan);
    if (!matches(await readControl(root, MARKER), plan.markerBefore)) conflict("Marker changed during staging");
    await put(root, MARKER, markerBytes(plan, "in-progress"));
    await options.fault?.("after-marker");
    return publishPrepared(root, plan, false, options);
  });
}

export async function recoverVaultPublication(target: WriteTarget, kind: VaultPublicationKind, transactionId: string, approvedDigest: Digest, mode: "resume" | "rollback", options: PublicationOptions = {}): Promise<VaultPublicationReceipt> {
  const root = await admitted(target);
  const plan = await loadPlan(root, kind, transactionId);
  if (digestBytes(root) !== plan.targetDigest) conflict("Recovery target differs from the approved publication target");
  const sourceHistory = sourceHistoryOf(plan);
  if (sourceHistory !== null && (sourceHistory.kind === "source-review" || sourceHistory.kind === "relink")) {
    const templateId = sourceHistory.review?.templateId;
    if (typeof templateId !== "string") invalid("source publication template identity is missing");
    assertRecoveredSourcePlan(plan, { transactionId: plan.transactionId, kind: sourceHistory.kind, templateId }, root);
    await assertSourcePortableIdentity(root, plan);
  }
  if (plan.kind === "schema-migration") await validateMigrationPlan(root, plan);
  else await admitRetainedPublication(root, plan);
  if (approvedDigest !== plan.planDigest) throw new VaultPublicationError("PUBLICATION_APPROVAL_REQUIRED", "Recovery approval does not match the sealed plan.");
  if (mode === "resume") return commitVaultPublication(target, plan, approvedDigest, options);
  return locked(root, async () => {
    if (plan.kind === "schema-migration") await admitMigrationPhase(root, plan, "rollback");
    else { await refuseLegacyPublication(root); await admitRetainedPublication(root, plan); }
    return publishPrepared(root, plan, true, options);
  });
}

/** Read-only inspection; never migrates, resumes, interviews or creates .oms. */
export async function inspectVaultPublication(vault: string): Promise<{ readonly status: "absent" | PublicationMarker["status"]; readonly marker?: PublicationMarker }> {
  const root = await realpath(vault);
  const bytes = await readControl(root, MARKER);
  if (bytes === null) return { status: "absent" };
  const marker = parseMarker(bytes);
  const plan = await loadPlan(root, marker.kind, marker.transactionId);
  if (plan.planDigest !== marker.planDigest) invalid("marker and sealed plan disagree");
  return { status: marker.status, marker };
}

function legacyAdmission(status: LegacyVaultPublicationStatus, markerPath: string | null, reasons: readonly string[], unavailableSources: readonly { readonly templateId: string; readonly reason: string }[] = []): LegacyVaultPublicationAdmission {
  return { status, markerPath, reasons, unavailableSources };
}
type LegacyRead = { readonly status: "absent" } | { readonly status: "present"; readonly bytes: Uint8Array } | { readonly status: "invalid" | "unavailable"; readonly reason: string };
function legacyReadFault(_error: unknown, relativePath: string): LegacyRead {
  return { status: "unavailable", reason: `legacy observation is not readable: ${relativePath}` };
}
function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 && left.size === right.size;
}
function legacyPath(relativePath: string): LegacyRead | null {
  if (relativePath.length === 0 || relativePath.length > 240 || relativePath.includes("\0") || relativePath.includes("\\") || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return { status: "invalid", reason: `legacy observation path is not confined: ${relativePath}` };
  try { if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(relativePath)) !== relativePath) return { status: "invalid", reason: "legacy observation path is not a Unicode scalar" }; } catch { return { status: "invalid", reason: "legacy observation path is not a Unicode scalar" }; }
  if (relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) return { status: "invalid", reason: `legacy observation path is not confined: ${relativePath}` };
  return null;
}
/** Optional strict reader. Absence is only a genuine ENOENT; it never uses the write-control allowlist. */
async function readLegacyFile(root: string, relativePath: string, budget: { total: number }, optional: boolean): Promise<LegacyRead> {
  const confined = legacyPath(relativePath);
  if (confined !== null) return confined;
  const absolute = resolve(root, relativePath);
  if (!contained(root, absolute)) return { status: "invalid", reason: `legacy observation path escapes the vault: ${relativePath}` };
  let current = root;
  let leaf: Stats | null = null;
  const ancestors: { readonly path: string; readonly stat: Stats }[] = [];
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { status: "invalid", reason: "legacy observation root is not a real directory" };
    ancestors.push({ path: root, stat: rootStat });
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return { status: "invalid", reason: `legacy observation follows a symlink: ${relativePath}` };
      if (current === absolute) {
        if (!stat.isFile() || stat.nlink !== 1) return { status: "invalid", reason: `legacy observation must be one regular file: ${relativePath}` };
        if (!Number.isSafeInteger(stat.size) || stat.size > MAX_BLOB_BYTES || budget.total > MAX_BLOB_BYTES - stat.size) return { status: "unavailable", reason: "legacy observation exceeds the explicit 8 MiB publication limit" };
        leaf = stat;
      } else if (!stat.isDirectory()) return { status: "invalid", reason: `legacy observation ancestor is not a directory: ${relativePath}` };
      else ancestors.push({ path: current, stat });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return optional ? { status: "absent" } : legacyReadFault(error, relativePath);
    return legacyReadFault(error, relativePath);
  }
  if (leaf === null) return { status: "unavailable", reason: `legacy observation is missing: ${relativePath}` };
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { return legacyReadFault(error, relativePath); }
  try {
    const opened = await handle.stat();
    if (!sameIdentity(leaf, opened)) return { status: "unavailable", reason: `legacy observation changed while reading: ${relativePath}` };
    const probe = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < probe.length) {
      const chunk = await handle.read(probe, offset, probe.length - offset, offset);
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    if (offset !== opened.size) return { status: "unavailable", reason: `legacy observation changed while reading: ${relativePath}` };
    const after = await handle.stat();
    if (!sameIdentity(opened, after)) return { status: "unavailable", reason: `legacy observation changed while reading: ${relativePath}` };
    for (const ancestor of ancestors) {
      const stat = await lstat(ancestor.path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== ancestor.stat.dev || stat.ino !== ancestor.stat.ino) return { status: "unavailable", reason: `legacy observation changed while reading: ${relativePath}` };
    }
    const currentLeaf = await lstat(absolute);
    if (currentLeaf.isSymbolicLink() || !sameIdentity(opened, currentLeaf)) return { status: "unavailable", reason: `legacy observation changed while reading: ${relativePath}` };
    budget.total += opened.size;
    return { status: "present", bytes: Uint8Array.from(probe.subarray(0, opened.size)) };
  } catch (error) {
    return legacyReadFault(error, relativePath);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      return legacyReadFault(error, relativePath);
    }
  }
}
function sameObservation(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
function contained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}
function decodeObservation(bytes: Uint8Array): { readonly text: string } | { readonly reason: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return sameObservation(new TextEncoder().encode(text), bytes) ? { text } : { reason: "legacy observation is not exact UTF-8" };
  } catch { return { reason: "legacy observation is not exact UTF-8" }; }
}
async function requireLegacyFile(root: string, relativePath: string, budget: { total: number }): Promise<Uint8Array | LegacyVaultPublicationAdmission> {
  const read = await readLegacyFile(root, relativePath, budget, false);
  if (read.status === "present") return read.bytes;
  return legacyAdmission(read.status === "invalid" ? "legacy-invalid" : "legacy-unavailable", null, [read.status === "absent" ? `legacy observation is missing: ${relativePath}` : read.reason]);
}
/** Read-only historical admission. Verified consistency is not authorization to publish or migrate. */
export async function inspectLegacyVaultPublication(target: WriteTarget): Promise<LegacyVaultPublicationAdmission> {
  const root = await admitted(target);
  const budget = { total: 0 };
  const present: { path: string; bytes: Uint8Array }[] = [];
  for (const path of LEGACY_MARKERS) {
    const read = await readLegacyFile(root, path, budget, true);
    if (read.status === "absent") continue;
    if (read.status !== "present") return legacyAdmission(read.status === "invalid" ? "legacy-invalid" : "legacy-unavailable", path, [read.reason]);
    present.push({ path, bytes: read.bytes });
  }
  if (present.length === 0) return legacyAdmission("absent", null, []);
  const direct = present.find(marker => marker.path === MARKER);
  if (direct !== undefined && publisherMarkerBytes(direct.bytes)) {
    const retained = await retainedPublication(root, direct.bytes);
    if (retained !== null) return retained;
    if (present.length === 1) return legacyAdmission("publisher-marker", direct.path, []);
    return legacyAdmission("legacy-inconsistent", direct.path, ["publisher marker is accompanied by a historical slot that is not its sealed retained record"]);
  }
  if (present.length > 1) return legacyAdmission("legacy-ambiguous", null, ["multiple historical publication markers are present"]);
  const selected = present[0]!;
  if (selected.path === MARKER) {
    try {
      parseMarker(Buffer.from(selected.bytes));
      return legacyAdmission("publisher-marker", selected.path, []);
    } catch (error) {
      if (!(error instanceof VaultPublicationError)) return legacyAdmission("legacy-unavailable", selected.path, ["publisher marker could not be inspected"]);
    }
  }
  const decodedMarker = decodeObservation(selected.bytes);
  if ("reason" in decodedMarker) return legacyAdmission("legacy-invalid", selected.path, [decodedMarker.reason]);
  const markerText = decodedMarker.text;
  const located = inspectLegacyPublicationMarker(selected.path, markerText);
  if (located.status === "malformed" || located.status === "unknown" || located.format === "unknown" || located.planPath === null) return legacyAdmission("legacy-invalid", selected.path, located.reasons);
  if (located.status === "in-progress") return legacyAdmission("legacy-in-progress", selected.path, ["historical publication is in progress"]);
  const planRead = await requireLegacyFile(root, located.planPath, budget);
  if (!(planRead instanceof Uint8Array)) return { ...planRead, markerPath: selected.path };
  const decodedPlan = decodeObservation(planRead);
  if ("reason" in decodedPlan) return legacyAdmission("legacy-invalid", selected.path, [decodedPlan.reason]);
  const planText = decodedPlan.text;
  const readSet = legacyPublicationReadSet(located.format, selected.path, markerText, located.planPath, planText);
  if (readSet.reasons.length > 0 || readSet.paths.length === 0) return legacyAdmission("legacy-invalid", selected.path, readSet.reasons);
  if (readSet.paths.length > MAX_LEGACY_OBSERVATION_FILES) return legacyAdmission("legacy-unavailable", selected.path, [`legacy observation exceeds the explicit ${MAX_LEGACY_OBSERVATION_FILES}-file limit`]);
  const observed = new Map<string, Uint8Array>();
  for (const path of readSet.paths) {
    if (path === selected.path || path === located.planPath) continue;
    const output = await requireLegacyFile(root, path, budget);
    if (!(output instanceof Uint8Array)) return { ...output, markerPath: selected.path };
    observed.set(path, output);
  }
  const policy = observed.get(POLICY);
  if (policy === undefined) return legacyAdmission("legacy-invalid", selected.path, ["sealed historical plan does not require the policy observation"]);
  const verification = verifyLegacyPublicationEvidence({
    format: located.format,
    markerPath: selected.path,
    markerBytes: markerText,
    planPath: located.planPath,
    planBytes: planText,
    policyBytes: policy,
    observedOutputs: Object.fromEntries([...observed].map(([path, bytes]) => [path, bytes])),
  });
  if (verification.status !== "verified") return legacyAdmission(verification.status === "invalid" ? "legacy-invalid" : "legacy-unavailable", selected.path, verification.reasons);
  const rereadBudget = { total: 0 };
  const rereadMarker = await readLegacyFile(root, selected.path, rereadBudget, true);
  const rereadPlan = await readLegacyFile(root, located.planPath, rereadBudget, false);
  if (rereadMarker.status !== "present" || rereadPlan.status !== "present" || !sameObservation(rereadMarker.bytes, selected.bytes) || !sameObservation(rereadPlan.bytes, planRead)) {
    return legacyAdmission("legacy-inconsistent", selected.path, ["historical publication changed during inspection"]);
  }
  for (const [path, bytes] of observed) {
    const current = await readLegacyFile(root, path, rereadBudget, false);
    if (current.status !== "present" || !sameObservation(current.bytes, bytes)) return legacyAdmission("legacy-inconsistent", selected.path, [`historical observation changed during inspection: ${path}`]);
  }

  for (const path of LEGACY_MARKERS) {
    const slot = await readLegacyFile(root, path, rereadBudget, true);
    const original = present.find(marker => marker.path === path);
    if (original === undefined) {
      if (slot.status !== "absent") return legacyAdmission("legacy-inconsistent", selected.path, [`historical marker appeared during inspection: ${path}`]);
      continue;
    }
    if (slot.status !== "present" || !sameObservation(slot.bytes, original.bytes)) return legacyAdmission("legacy-inconsistent", selected.path, [`historical marker changed during inspection: ${path}`]);
  }
  const admission = legacyAdmission("verified", selected.path, [], verification.unavailableSources);
  legacyAdmissions.set(admission, {
    root,
    markerPath: selected.path,
    markerBytes: Uint8Array.from(selected.bytes),
    planPath: located.planPath,
    planBytes: Uint8Array.from(planRead),
    policyBytes: Uint8Array.from(policy),
    observedOutputs: new Map([...observed].map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
    proof: verification.proof,
  });
  return admission;
}
async function retainedPublication(root: string, direct: Uint8Array): Promise<LegacyVaultPublicationAdmission | null> {
  let marker: PublicationMarker;
  try { marker = parseMarker(Buffer.from(direct)); } catch { return null; }
  let predecessor: VaultPublicationPlan;
  try { predecessor = await loadPlan(root, marker.kind, marker.transactionId); } catch { return null; }
  if (predecessor.planDigest !== marker.planDigest || predecessor.kind !== marker.kind) return null;
  const retainedEvidence = predecessor.evidence.find(item => item.name === "retained-v3");
  if (retainedEvidence === undefined) return null;
  const slots = await currentSlots(root);
  const retained = bytesOf(retainedEvidence.content);
  if (!sameOptional(slots.direct, direct) || !sameOptional(slots.migration, retained) || slots.backfill !== null) return legacyAdmission("legacy-inconsistent", MARKER, ["retained v3 slots changed after publication"]);
  const admission = legacyAdmission("publisher-marker", MARKER, []);
  retainedPublications.set(admission, { root, predecessorId: marker.transactionId, predecessorDigest: marker.planDigest, predecessorKind: marker.kind, retained: Uint8Array.from(retained), slots });
  return admission;
}
/** Returns one verifier-bound historical source. An output path or public admission cannot forge it. */
export function verifiedLegacyVaultSource(admission: unknown, templateId: string): { readonly identity: string; readonly path: string; readonly rawDigest: Digest; readonly historicalBytes: Uint8Array } | null {
  if (typeof admission !== "object" || admission === null) return null;
  const record = legacyAdmissions.get(admission as LegacyVaultPublicationAdmission);
  if (record === undefined) return null;
  const source = verifiedLegacySource(record.proof, record.policyBytes, templateId);
  return source === null ? null : { ...source, historicalBytes: Uint8Array.from(source.historicalBytes) };
}
async function refuseLegacyPublication(root: string): Promise<void> {
  const admission = await inspectLegacyVaultPublication({ vault: root, source: "explicit" });
  if (admission.status === "absent" || admission.status === "publisher-marker") return;
  conflict(`Historical publication marker blocks ordinary publication: ${admission.status}`);
}
async function admitRetainedPublication(root: string, plan: VaultPublicationPlan): Promise<void> {
  if (plan.kind === "schema-migration") return;
  if (plan.evidence.filter(item => item.name === "retained-v3").length > 1) invalid("retained v3 provenance is duplicated");
  const retained = plan.evidence.find(item => item.name === "retained-v3");
  const slots = await currentSlots(root);
  if (retained === undefined) {
    if (slots.migration !== null || slots.backfill !== null) conflict("ordinary publication cannot adopt an unsealed historical marker");
    return;
  }
  if (plan.evidence.filter(item => item.name === "retained-v3").length !== 1 || slots.backfill !== null || !sameOptional(slots.migration, bytesOf(retained.content))) conflict("retained v3 marker changed since ordinary planning");
  const marker = await readControl(root, MARKER);
  if (marker === null || !publisherMarkerBytes(marker)) conflict("ordinary publication lost its owned marker");
  const parsed = parseMarker(marker);
  if (parsed.kind === plan.kind && parsed.transactionId === plan.transactionId && parsed.planDigest === plan.planDigest) return;
  const predecessor = await loadPlan(root, parsed.kind, parsed.transactionId);
  if (predecessor.planDigest !== parsed.planDigest || !predecessor.evidence.some(item => item.name === "retained-v3" && sameBytes(bytesOf(item.content), bytesOf(retained.content)))) conflict("ordinary retained marker is not the immediate sealed predecessor record");
}

function exhausted(message: string): never { throw new VaultPublicationError("PUBLICATION_RESOURCE_EXHAUSTED", message); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
function archiveRecord(record: Omit<LegacyAdmissionRecord, "proof">, format: "v3" | "v4"): LegacyEquivalenceArchive {
  return createLegacyEquivalenceArchive({
    format,
    markerPath: record.markerPath,
    markerBytes: Uint8Array.from(record.markerBytes),
    planPath: record.planPath,
    planBytes: Uint8Array.from(record.planBytes),
    policyPath: LEGACY_EQUIVALENCE_POLICY_PATH,
    policyBytes: Uint8Array.from(record.policyBytes),
    observedOutputs: new Map([...record.observedOutputs].map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
  });
}
/** Private admission only. A public object, proof, or serialized brand cannot select the archive. */
export function executeLegacyVaultEquivalence(admission: unknown): LegacyEquivalenceExecution | null {
  if (typeof admission !== "object" || admission === null) return null;
  const publicAdmission = admission as LegacyVaultPublicationAdmission;
  const verified = legacyAdmissions.get(publicAdmission);
  const retry = migrationRetryAdmissions.get(publicAdmission);
  const selected = verified !== undefined && publicAdmission.status === "verified"
    ? { record: verified, format: verified.markerPath === MARKER ? "v4" as const : "v3" as const }
    : retry !== undefined && publicAdmission.status === "migration-retry"
      ? { record: retry.archive, format: retry.archive.markerPath === MARKER ? "v4" as const : retry.archive.markerPath === ".oms/template-migration.json" ? "v3" as const : null }
      : null;
  if (selected?.format == null) return null;
  const execution = executeLegacyDecoderEquivalence(archiveRecord(selected.record, selected.format));
  if (execution.disposition !== "proved") return execution;
  if (execution.proposal.material.decoderExecutionVersion !== LEGACY_DECODER_EXECUTION_VERSION || execution.proposal.candidate.sourceVersion === null || execution.proposal.unavailableHistoricalSources.length > 0) return null;
  return execution;
}
function activeSources(candidate: LegacyEquivalenceCandidate, witnesses: readonly LegacyEquivalenceHistoricalSource[]): { readonly path: string; readonly digest: Digest }[] {
  const active = Object.entries(candidate.policy.templates).filter((entry): entry is [string, Extract<(typeof candidate.policy.templates)[string], { status: "active" }>] => entry[1].status === "active");
  const sources: { path: string; digest: Digest }[] = [];
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const [templateId, template] of active) {
    const witness = witnesses.find(item => item.templateId === templateId);
    if (witness === undefined || witness.identity !== template.source.identity || witness.path !== template.source.path || witness.rawDigest !== template.source.rawDigest) invalid("active registration has no exact private historical witness");
    if (identities.has(witness.identity) || paths.has(witness.path) || witness.path.startsWith(".oms/")) invalid("active historical witness is duplicated or is only an observed managed output");
    identities.add(witness.identity);
    paths.add(witness.path);
    sources.push({ path: witness.path, digest: witness.rawDigest });
  }
  return sources.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
interface MigrationComponents { readonly markerPath: string; readonly marker: Uint8Array; readonly planPath: string; readonly plan: Uint8Array; readonly policy: Uint8Array; readonly observed: readonly { readonly path: string; readonly bytes: Uint8Array }[]; }
function encodedBlob(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString("base64");
}
function migrationDocument(components: MigrationComponents, materialValue: LegacyEquivalenceMaterial, candidate: LegacyEquivalenceCandidate, retained: Uint8Array | null, slots: MigrationSlots, sources: readonly { readonly path: string; readonly digest: Digest }[], predecessorPlanDigest: Digest | null): Record<string, unknown> {
  const canonical = serializeContractPolicyV5(candidate.policy);
  if (canonical !== candidate.canonicalPolicy) invalid("canonical migration candidate does not round-trip");
  return {
    version: "oms.legacy-vault-migration.v1",
    decoderExecutionVersion: LEGACY_DECODER_EXECUTION_VERSION,
    format: materialValue.format,
    marker: { path: components.markerPath, digest: digestBytes(components.marker), base64: encodedBlob(components.marker) },
    plan: { path: components.planPath, digest: digestBytes(components.plan), base64: encodedBlob(components.plan) },
    policy: { path: LEGACY_EQUIVALENCE_POLICY_PATH, digest: digestBytes(components.policy), base64: encodedBlob(components.policy) },
    observed: components.observed.map(item => ({ path: item.path, digest: digestBytes(item.bytes), base64: encodedBlob(item.bytes) })),
    materialDigest: materialValue.archiveDigest,
    candidateDigest: candidate.candidateDigest,
    canonicalPolicy: canonical,
    retainedV3: encodedBlob(retained),
    seal: {
      candidateDigest: candidate.candidateDigest,
      canonicalPolicy: canonical,
      sources,
      slots: { migration: encodedBlob(slots.migration), direct: encodedBlob(slots.direct), backfill: encodedBlob(slots.backfill) },
      predecessorPlanDigest,
    },
  };
}
function componentOf(value: unknown, label: string): { readonly path: string; readonly bytes: Uint8Array } {
  if (value === null || typeof value !== "object") invalid(`${label} is malformed`);
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.base64 !== "string" || typeof record.digest !== "string" || !DIGEST.test(record.digest)) invalid(`${label} is malformed`);
  const bytes = Buffer.from(record.base64, "base64");
  if (bytes.toString("base64") !== record.base64 || digestBytes(bytes) !== record.digest) invalid(`${label} checksum mismatch`);
  return { path: record.path, bytes: Uint8Array.from(bytes) };
}
function rawBlob(value: unknown, label: string): Uint8Array | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid(`${label} is malformed`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) invalid(`${label} encoding mismatch`);
  return Uint8Array.from(bytes);
}
function decodePayload(bytes: Uint8Array): { readonly components: MigrationComponents; readonly materialDigest: Digest; readonly seal: MigrationSeal } {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(bytes)); } catch { invalid("sealed migration payload is malformed"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid("sealed migration payload is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.version !== "oms.legacy-vault-migration.v1" || value.decoderExecutionVersion !== LEGACY_DECODER_EXECUTION_VERSION || (value.format !== "v3" && value.format !== "v4")) invalid("sealed migration payload version is unsupported");
  if (typeof value.materialDigest !== "string" || !DIGEST.test(value.materialDigest) || !Array.isArray(value.observed) || value.seal === null || typeof value.seal !== "object" || Array.isArray(value.seal)) invalid("sealed migration payload is incomplete");
  const marker = componentOf(value.marker, "sealed marker");
  const plan = componentOf(value.plan, "sealed plan");
  const policy = componentOf(value.policy, "sealed policy");
  if (policy.path !== LEGACY_EQUIVALENCE_POLICY_PATH || (value.format === "v4" && marker.path !== MARKER) || (value.format === "v3" && marker.path !== ".oms/template-migration.json")) invalid("sealed migration archive paths do not match its format");
  const observed = value.observed.map(item => componentOf(item, "sealed observation"));
  if (new Set(observed.map(item => item.path)).size !== observed.length) invalid("sealed migration observations are duplicated");
  const seal = value.seal as Record<string, unknown>;
  const keys = Object.keys(seal);
  if (keys.some(key => !["candidateDigest", "canonicalPolicy", "sources", "slots", "predecessorPlanDigest"].includes(key)) || typeof seal.candidateDigest !== "string" || !DIGEST.test(seal.candidateDigest) || typeof seal.canonicalPolicy !== "string" || !Array.isArray(seal.sources) || seal.slots === null || typeof seal.slots !== "object" || Array.isArray(seal.slots)) invalid("migration seal is incomplete");
  const slots = seal.slots as Record<string, unknown>;
  if (Object.keys(slots).some(key => !["migration", "direct", "backfill"].includes(key))) invalid("migration seal invents a slot");
  const retained = rawBlob(value.retainedV3, "retained v3 marker");
  const sealedSlots = { migration: rawBlob(slots.migration, "retained migration slot"), direct: rawBlob(slots.direct, "direct marker slot"), backfill: rawBlob(slots.backfill, "backfill slot") };
  if (!sameOptional(sealedSlots.migration, value.format === "v3" ? marker.bytes : null) || !sameOptional(retained, sealedSlots.migration)) invalid("migration seal slots are not the actual archived marker");
  const predecessorPlanDigest = seal.predecessorPlanDigest === null ? null : typeof seal.predecessorPlanDigest === "string" && DIGEST.test(seal.predecessorPlanDigest) ? parseDigest(seal.predecessorPlanDigest) : invalid("predecessor seal is malformed");
  if (predecessorPlanDigest === null) {
    if (!sameOptional(sealedSlots.direct, value.format === "v4" ? marker.bytes : null)) invalid("initial migration direct slot does not match the sealed historical state");
  } else {
    if (sealedSlots.direct === null) invalid("migration retry has no sealed predecessor marker");
    const predecessor = parseMarker(Buffer.from(sealedSlots.direct));
    if (predecessor.kind !== "schema-migration" || predecessor.status !== "rolled-back" || predecessor.planDigest !== predecessorPlanDigest) invalid("migration predecessor marker is not the sealed rolled-back plan");
  }
  return {
    components: { markerPath: marker.path, marker: marker.bytes, planPath: plan.path, plan: plan.bytes, policy: policy.bytes, observed },
    materialDigest: parseDigest(value.materialDigest),
    seal: { format: value.format, markerPath: marker.path, planPath: plan.path, policyDigest: digestBytes(policy.bytes), candidateDigest: parseDigest(seal.candidateDigest), canonicalPolicy: seal.canonicalPolicy, sources: seal.sources.map(item => { if (item === null || typeof item !== "object" || Array.isArray(item)) invalid("migration source seal is malformed"); const source = item as Record<string, unknown>; if (Object.keys(source).some(key => key !== "path" && key !== "digest") || typeof source.path !== "string" || typeof source.digest !== "string" || !DIGEST.test(source.digest)) invalid("migration source seal is malformed"); return { path: source.path, digest: parseDigest(source.digest) }; }), slots: sealedSlots, predecessorPlanDigest },
  };
}
function publisherMarkerBytes(bytes: Uint8Array): boolean {
  try { parseMarker(Buffer.from(bytes)); return true; }
  catch { return false; }
}
async function currentSlots(root: string): Promise<MigrationSlots> {
  const read = async (path: string): Promise<Uint8Array | null> => {
    const current = await readLegacyFile(root, path, { total: 0 }, true);
    if (current.status === "absent") return null;
    if (current.status !== "present") invalid(`migration slot is not a regular file: ${path}`);
    return current.bytes;
  };
  return { migration: await read(".oms/template-migration.json"), direct: await read(MARKER), backfill: await read(".oms/template-backfill.json") };
}
function sameOptional(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && sameBytes(left, right);
}
async function freshExecution(payload: ReturnType<typeof decodePayload>): Promise<Extract<LegacyEquivalenceExecution, { disposition: "proved" }>> {
  const execution = executeLegacyDecoderEquivalence(createLegacyEquivalenceArchive({ format: payload.seal.format, markerPath: payload.components.markerPath, markerBytes: Uint8Array.from(payload.components.marker), planPath: payload.components.planPath, planBytes: Uint8Array.from(payload.components.plan), policyPath: LEGACY_EQUIVALENCE_POLICY_PATH, policyBytes: Uint8Array.from(payload.components.policy), observedOutputs: new Map(payload.components.observed.map(item => [item.path, Uint8Array.from(item.bytes)])) }));
  if (execution.disposition !== "proved" || execution.proposal.material.archiveDigest !== payload.materialDigest || execution.proposal.material.format !== payload.seal.format || execution.proposal.candidate.candidateDigest !== payload.seal.candidateDigest || execution.proposal.candidate.canonicalPolicy !== payload.seal.canonicalPolicy || execution.proposal.candidate.sourceVersion !== (payload.seal.format === "v3" ? 3 : 4)) invalid("fresh migration execution does not match the sealed material or candidate");
  return execution;
}
async function namedPredecessor(root: string, payload: ReturnType<typeof decodePayload>): Promise<VaultPublicationPlan | null> {
  if (payload.seal.predecessorPlanDigest === null) return null;
  const marker = payload.seal.slots.direct;
  if (marker === null) invalid("named migration predecessor marker is missing from the seal");
  const parsed = parseMarker(Buffer.from(marker));
  if (parsed.kind !== "schema-migration" || parsed.status !== "rolled-back" || parsed.planDigest !== payload.seal.predecessorPlanDigest) invalid("migration retry predecessor is not the sealed rolled-back plan");
  const predecessor = await loadPlan(root, "schema-migration", parsed.transactionId);
  if (predecessor.planDigest !== parsed.planDigest) invalid("named migration predecessor does not match its sealed plan");
  await verifySealed(root, predecessor);
  const receipt = await observedTerminalReceipt(root, predecessor, true);
  if (receipt?.status !== "rolled-back") invalid("named migration predecessor has no sealed rollback receipt");
  const previous = decodePayload(bytesOf(predecessor.evidence.find(item => item.name === "legacy-migration")?.content ?? invalid("named predecessor has no sealed archive")));
  if (!sameOptional(previous.seal.slots.migration, payload.seal.slots.migration) || !sameOptional(previous.seal.slots.backfill, payload.seal.slots.backfill) || previous.components.markerPath !== payload.components.markerPath || !sameBytes(previous.components.marker, payload.components.marker)) invalid("retry does not copy the rolled-back archive");
  await freshExecution(previous);
  return predecessor;
}
async function verifyMigrationReadSet(root: string, payload: ReturnType<typeof decodePayload>): Promise<void> {
  const budget = { total: 0 };
  const expected = [
    { path: payload.components.planPath, bytes: payload.components.plan },
    { path: POLICY, bytes: payload.components.policy },
    ...payload.components.observed,
  ];
  if (payload.seal.predecessorPlanDigest === null) expected.unshift({ path: payload.components.markerPath, bytes: payload.components.marker });
  for (const item of expected) {
    const current = await readLegacyFile(root, item.path, budget, false);
    if (current.status !== "present" || !sameBytes(current.bytes, item.bytes)) conflict(`Historical read set changed since admission: ${item.path}`);
  }
}
async function validateMigrationPlan(root: string, plan: VaultPublicationPlan): Promise<void> {
  const evidence = plan.evidence.find(item => item.name === "legacy-migration");
  if (evidence === undefined || plan.evidence.some(item => item.name !== "legacy-migration" && item.name !== "retained-v3")) invalid("schema migration evidence is not the sealed private archive");
  const payload = decodePayload(bytesOf(evidence.content));
  const execution = await freshExecution(payload);
  const sources = activeSources(execution.proposal.candidate, execution.proposal.availableHistoricalSources);
  if (JSON.stringify(plan.sources) !== JSON.stringify(sources) || JSON.stringify([...plan.sources].sort((left, right) => left.path < right.path ? -1 : 1)) !== JSON.stringify([...payload.seal.sources].sort((left, right) => left.path < right.path ? -1 : 1))) invalid("migration source observations do not match the private witnesses");
  const policy = plan.outputs.find(output => output.path === POLICY);
  const histories = plan.outputs.filter(output => historyRevision(output.path) !== null);
  const settings = plan.outputs.find(output => output.path === SETTINGS);
  if (policy === undefined || histories.length !== 1 || utf8(bytesOf(policy.after)) !== payload.seal.canonicalPolicy || utf8(bytesOf(policy.after)) !== execution.proposal.candidate.canonicalPolicy) invalid("migration policy output does not match the sealed candidate");
  if (policy.before === null || !sameBytes(bytesOf(policy.before), payload.components.policy) || policy.before.digest !== payload.seal.policyDigest) invalid("migration policy preimage does not match the private archive");
  const revision = execution.proposal.candidate.policy.revision;
  const expectedHistory = `${JSON.stringify(contractHistoryRecord({
    transactionId: plan.transactionId,
    kind: "migration",
    decision: MIGRATION_DECISION,
    revision,
    previousPolicyDigest: policy.before.digest,
    policyDigest: policy.after.digest,
  }))}\n`;
  if (historyRevision(histories[0]!.path) !== revision || utf8(bytesOf(histories[0]!.after)) !== expectedHistory) invalid("migration history does not match the sealed candidate");
  if (settings !== undefined && (settings.before !== null || parseVaultSettings(utf8(bytesOf(settings.after))).vaultId !== plan.vaultId)) invalid("migration settings are not an absent-only identity-preserving payload");
  const retained = plan.evidence.find(item => item.name === "retained-v3");
  if (payload.seal.format === "v3") {
    if (retained === undefined || !sameBytes(bytesOf(retained.content), payload.components.marker)) invalid("v3 retained marker does not match its sealed archive");
  } else if (retained !== undefined) invalid("v4 migration cannot retain a v3 marker");
  if (payload.seal.predecessorPlanDigest !== null) {
    const predecessor = await namedPredecessor(root, payload);
    if (predecessor === null || predecessor.planDigest !== payload.seal.predecessorPlanDigest) invalid("migration retry is not bound to its rolled-back predecessor");
  } else if (payload.seal.slots.backfill !== null || (payload.seal.format === "v3" && payload.seal.slots.direct !== null)) invalid("initial migration slots are not the exact legacy state");
  await admitMigrationPhase(root, plan, "validate");
  if (matches(await readControl(root, MARKER), plan.markerBefore)) await verifyMigrationReadSet(root, payload);
}
async function admitMigrationPhase(root: string, plan: VaultPublicationPlan, phase: "commit" | "rollback" | "validate"): Promise<void> {
  const payload = decodePayload(bytesOf(plan.evidence.find(item => item.name === "legacy-migration")?.content ?? invalid("schema migration plan has no sealed private archive")));
  const slots = await currentSlots(root);
  const marker = await readControl(root, MARKER);
  const initial = payload.seal.predecessorPlanDigest === null;
  if (!sameOptional(slots.migration, payload.seal.slots.migration) || !sameOptional(slots.backfill, payload.seal.slots.backfill)) conflict("historical publication slots changed since migration planning");
  if (marker !== null && sameOptional(slots.direct, marker) && publisherMarkerBytes(marker)) {
    const owned = parseMarker(marker);
    if (owned.kind === plan.kind && owned.transactionId === plan.transactionId && owned.planDigest === plan.planDigest) {
      const stored = await loadPlan(root, plan.kind, plan.transactionId);
      if (stored.planDigest !== plan.planDigest) conflict("owned migration marker does not match its sealed plan");
      await verifySealed(root, stored);
      return;
    }
  }
  if (initial) {
    if (payload.seal.format === "v4" && !sameOptional(slots.direct, payload.seal.slots.direct)) conflict("historical publication slots changed since migration planning");
    if (payload.seal.format === "v3" && slots.direct !== null) conflict("v3 migration cannot replace another direct marker");
    if (phase === "rollback" && marker === null) conflict("migration rollback marker disappeared");
    return;
  }
  if (marker === null || !sameOptional(slots.direct, marker) || !sameOptional(marker, payload.seal.slots.direct) || !publisherMarkerBytes(marker)) conflict("owned migration marker changed");
  const parsed = parseMarker(marker);
  if (parsed.status !== "rolled-back" || parsed.planDigest !== payload.seal.predecessorPlanDigest || parsed.transactionId === plan.transactionId || parsed.kind !== "schema-migration") conflict("owned migration marker is not the immediate rolled-back predecessor");
}
/** Replays only the caller proof against the privately selected archive. Caller outputs, sources, and brands are not inputs. */
export async function planLegacyVaultMigration(target: WriteTarget, admission: unknown, proof: unknown, request: LegacyVaultMigrationRequest): Promise<VaultPublicationPlan> {
  if (request === null || typeof request !== "object" || !UUID.test(request.vaultId)) invalid("migration request vault identity is invalid");
  if ("outputs" in request || "sources" in request || "candidate" in request || "archive" in request || "approved" in request) invalid("migration request cannot supply outputs, sources, or authority");
  const root = await admitted(target);
  const publicAdmission = typeof admission === "object" && admission !== null ? admission as LegacyVaultPublicationAdmission : null;
  const verified = publicAdmission?.status === "verified" ? legacyAdmissions.get(publicAdmission) : undefined;
  const retry = publicAdmission?.status === "migration-retry" ? migrationRetryAdmissions.get(publicAdmission) : undefined;
  if ((verified === undefined) === (retry === undefined) || (verified !== undefined && verified.root !== root) || (retry !== undefined && retry.root !== root)) invalid("migration admission is not a private record bound to this vault");
  const selected = verified ?? await verifiedRetryArchive(root, retry!);
  const predecessorDigest = retry?.predecessorDigest ?? null;
  const livePolicy = await readLegacyFile(root, POLICY, { total: 0 }, false);
  if (livePolicy.status !== "present" || !sameBytes(livePolicy.bytes, selected.policyBytes)) invalid("live policy does not match the private historical archive");
  for (const [path, bytes] of selected.observedOutputs) {
    const current = await readLegacyFile(root, path, { total: 0 }, false);
    if (current.status !== "present" || !sameBytes(current.bytes, bytes)) invalid(`live historical observation changed: ${path}`);
  }
  const slots = await currentSlots(root);
  if (verified !== undefined && ((slots.migration === null) !== (selected.markerPath !== ".oms/template-migration.json") || (selected.markerPath === MARKER && !sameOptional(slots.direct, selected.markerBytes)) || slots.backfill !== null)) invalid("historical marker slots changed since admission");
  const format = selected.markerPath === MARKER ? "v4" as const : "v3" as const;
  const recovered = replayLegacyDecoderEquivalence(proof, archiveRecord(selected, format));
  if (recovered.disposition !== "recovered" || recovered.material.decoderExecutionVersion !== LEGACY_DECODER_EXECUTION_VERSION || recovered.candidate.sourceVersion === null || recovered.material.format !== format) invalid("caller proof does not replay against the private archive");
  const sources = activeSources(recovered.candidate, recovered.availableHistoricalSources);
  const retained = format === "v3" ? selected.markerBytes : null;
  const settings = await readControl(root, SETTINGS);
  if (request.missingSettings !== undefined && settings !== null) invalid("existing settings are never rewritten by automatic migration");
  if (request.missingSettings !== undefined && parseVaultSettings(request.missingSettings.content).vaultId !== request.vaultId) invalid("missing settings must preserve the approved portable vault identity");
  if (settings !== null && parseVaultSettings(settings.toString("utf8")).vaultId !== request.vaultId) invalid("existing settings identity does not match the migration request");
  const transactionId = request.transactionId ?? randomUUID();
  const policyText = recovered.candidate.canonicalPolicy;
  const nextRevision = recovered.candidate.policy.revision;
  const publishedPolicy = policyText;
  const historyPath = `.oms/history/contracts/${nextRevision}.json`;
  if (await readControl(root, historyPath) !== null) invalid("migration history revision is already occupied");
  const history = `${JSON.stringify(contractHistoryRecord({ transactionId, kind: "migration", decision: MIGRATION_DECISION, revision: nextRevision, previousPolicyDigest: digestBytes(livePolicy.bytes), policyDigest: digestBytes(publishedPolicy) }))}\n`;
  const outputs = [{ path: POLICY, before: livePolicy.bytes, after: Buffer.from(publishedPolicy) }, { path: historyPath, before: null as Buffer | null, after: Buffer.from(history) }];
  if (request.missingSettings !== undefined) outputs.push({ path: SETTINGS, before: null, after: Buffer.from(request.missingSettings.content) });
  const plannedSlots = { migration: retained, direct: slots.direct, backfill: slots.backfill };
  const payload = Buffer.from(JSON.stringify(migrationDocument({ markerPath: selected.markerPath, marker: selected.markerBytes, planPath: selected.planPath, plan: selected.planBytes, policy: selected.policyBytes, observed: [...selected.observedOutputs].map(([path, bytes]) => ({ path, bytes })) }, recovered.material, recovered.candidate, retained, plannedSlots, sources, predecessorDigest)));
  const planned = { version: 1 as const, transactionId, kind: "schema-migration" as const, vaultId: request.vaultId, targetDigest: digestBytes(root), markerBefore: slots.direct === null ? null : blob(slots.direct), outputs: outputs.map(output => ({ path: output.path, before: output.before === null ? null : blob(output.before), after: blob(output.after) })), sources, evidence: [{ name: "legacy-migration", content: blob(payload) }, ...(retained === null ? [] : [{ name: "retained-v3", content: blob(retained) }])] };
  const serialized = `${JSON.stringify({ ...planned, planDigest: planHash(planned) })}\n`;
  if (Buffer.byteLength(serialized) > MAX_BLOB_BYTES) exhausted("exact serialized migration plan exceeds the explicit 8 MiB publication limit");
  const plan = JSON.parse(serialized) as VaultPublicationPlan;
  await validateMigrationPlan(root, plan);
  await verifyPublicationSources(root, plan);
  return plan;
}
async function verifiedRetryArchive(root: string, retry: MigrationRetryRecord): Promise<Omit<LegacyAdmissionRecord, "proof">> {
  if (retry.root !== root) invalid("migration retry belongs to another vault");
  const marker = await readControl(root, MARKER);
  if (marker === null || !sameOptional(marker, retry.slots.direct)) invalid("migration retry requires the current rolled-back publisher marker");
  const parsed = parseMarker(marker);
  if (parsed.status !== "rolled-back" || parsed.kind !== "schema-migration" || parsed.transactionId !== retry.predecessorId || parsed.planDigest !== retry.predecessorDigest) invalid("migration retry marker does not match its terminal predecessor");
  const receipt = await readControl(root, `${rootFor(parsed)}/rolled-back-receipt.json`);
  if (receipt === null || sealedReceipt(receipt, retry.receipt) === null) invalid("migration retry receipt is missing or is not the native sealed rollback receipt");
  const predecessor = await loadPlan(root, "schema-migration", retry.predecessorId);
  for (const output of predecessor.outputs) if (!matches(await readControl(root, output.path), output.before)) invalid(`migration retry preimage changed: ${output.path}`);
  const slots = await currentSlots(root);
  if (!sameOptional(slots.migration, retry.slots.migration) || !sameOptional(slots.direct, retry.slots.direct) || !sameOptional(slots.backfill, retry.slots.backfill)) invalid("migration retry slots changed");
  const payload = decodePayload(bytesOf(predecessor.evidence.find(item => item.name === "legacy-migration")?.content ?? invalid("migration retry predecessor has no archive")));
  if (!sameBytes(payload.components.marker, retry.archive.markerBytes) || payload.components.markerPath !== retry.archive.markerPath || !sameBytes(payload.components.plan, retry.archive.planBytes) || !sameBytes(payload.components.policy, retry.archive.policyBytes)) invalid("migration retry archive does not match the sealed predecessor");
  await validateMigrationPlan(root, predecessor);
  const execution = await freshExecution(payload);
  if (execution.proposal.availableHistoricalSources.length !== activeSources(execution.proposal.candidate, execution.proposal.availableHistoricalSources).length) invalid("migration retry witness set changed");
  return { root: retry.archive.root, markerPath: retry.archive.markerPath, markerBytes: Uint8Array.from(retry.archive.markerBytes), planPath: retry.archive.planPath, planBytes: Uint8Array.from(retry.archive.planBytes), policyBytes: Uint8Array.from(retry.archive.policyBytes), observedOutputs: new Map([...retry.archive.observedOutputs].map(([path, bytes]) => [path, Uint8Array.from(bytes)])) };
}
/** Explicit rolled-back retry only. It does not restore an old marker or authorize a new publication. */
export async function inspectLegacyVaultMigrationRetry(target: WriteTarget): Promise<LegacyVaultPublicationAdmission> {
  const root = await admitted(target);
  const marker = await readControl(root, MARKER);
  if (marker === null) return legacyAdmission("absent", null, ["no publisher marker is available for migration retry"]);
  let parsed: PublicationMarker;
  try { parsed = parseMarker(marker); } catch { return legacyAdmission("legacy-invalid", MARKER, ["publisher marker is not a migration retry candidate"]); }
  if (parsed.kind !== "schema-migration" || parsed.status !== "rolled-back") return legacyAdmission("legacy-invalid", MARKER, ["migration retry requires a terminal rolled-back schema migration"]);
  let predecessor: VaultPublicationPlan;
  try { predecessor = await loadPlan(root, parsed.kind, parsed.transactionId); } catch { return legacyAdmission("legacy-invalid", MARKER, ["rolled-back migration plan is missing"]); }
  const storedReceipt = await readControl(root, `${rootFor(parsed)}/rolled-back-receipt.json`);
  let expected: VaultPublicationReceipt | null;
  try { expected = await observedTerminalReceipt(root, predecessor, true); }
  catch (error) {
    if (!(error instanceof VaultPublicationError) || error.code !== "PUBLICATION_INVALID") throw error;
    return legacyAdmission("legacy-invalid", MARKER, ["terminal rollback receipt does not match the sealed publication plan"]);
  }
  if (storedReceipt === null || expected === null || sealedReceipt(storedReceipt, expected) === null) return legacyAdmission("legacy-unavailable", MARKER, ["terminal rollback receipt does not match live preimages"]);
  let payload: ReturnType<typeof decodePayload>;
  try { payload = decodePayload(bytesOf(predecessor.evidence.find(item => item.name === "legacy-migration")?.content ?? invalid("missing"))); await freshExecution(payload); }
  catch { return legacyAdmission("legacy-invalid", MARKER, ["rolled-back migration archive does not fresh-execute"]); }
  const slots = await currentSlots(root);
  if (!sameOptional(slots.direct, marker) || !sameOptional(slots.backfill, payload.seal.slots.backfill) || !sameOptional(slots.migration, payload.seal.slots.migration)) return legacyAdmission("legacy-inconsistent", MARKER, ["migration retry slots do not match the sealed predecessor"]);
  for (const output of predecessor.outputs) if (!matches(await readControl(root, output.path), output.before)) return legacyAdmission("legacy-inconsistent", MARKER, [`migration retry preimage changed: ${output.path}`]);
  const admission = legacyAdmission("migration-retry", MARKER, []);
  migrationRetryAdmissions.set(admission, { root, predecessorId: parsed.transactionId, predecessorDigest: parsed.planDigest, receipt: expected, slots, archive: { root, markerPath: payload.components.markerPath, markerBytes: Uint8Array.from(payload.components.marker), planPath: payload.components.planPath, planBytes: Uint8Array.from(payload.components.plan), policyBytes: Uint8Array.from(payload.components.policy), observedOutputs: new Map(payload.components.observed.map(item => [item.path, Uint8Array.from(item.bytes)])) } });
  return admission;
}

declare const preparedLegacyMigrationBrand: unique symbol;
/** Opaque in-process capability. Metadata and a serialized brand are not this object. */
export interface PreparedLegacyMigration { readonly [preparedLegacyMigrationBrand]: never }
export interface LegacyMigrationLocator {
  readonly kind: "schema-migration";
  readonly transactionId: string;
  readonly vaultId: string;
  readonly targetDigest: Digest;
  readonly planDigest: Digest;
}
export interface SettingsPublicationLocator {
  readonly kind: "settings-update";
  readonly transactionId: string;
  readonly vaultId: string;
  readonly targetDigest: Digest;
  readonly planDigest: Digest;
}
export type SealedSettingsPublicationRecovery =
  | { readonly state: "not-sealed"; readonly locator: SettingsPublicationLocator }
  | { readonly state: "sealed"; readonly receipt: VaultPublicationReceipt };
export type LegacyMigrationPreparation =
  | { readonly state: "prepared"; readonly publication: PreparedLegacyMigration; readonly policy: LegacyEquivalenceCandidate }
  | { readonly state: "review-required"; readonly admission: LegacyVaultPublicationAdmission; readonly proposal?: LegacyEquivalenceProposal }
  | { readonly state: "setup-required"; readonly admission: LegacyVaultPublicationAdmission };
interface PreparedMigrationRecord { readonly root: string; readonly plan: VaultPublicationPlan; readonly policy: LegacyEquivalenceCandidate; readonly locator: LegacyMigrationLocator }
const preparedMigrations = new WeakMap<PreparedLegacyMigration, PreparedMigrationRecord>();
function migrationLocator(plan: VaultPublicationPlan): LegacyMigrationLocator {
  return { kind: "schema-migration", transactionId: plan.transactionId, vaultId: plan.vaultId, targetDigest: plan.targetDigest, planDigest: plan.planDigest };
}
function sameLocator(left: LegacyMigrationLocator, right: LegacyMigrationLocator): boolean {
  return left.kind === right.kind && left.transactionId === right.transactionId && left.vaultId === right.vaultId && left.targetDigest === right.targetDigest && left.planDigest === right.planDigest;
}
function cloneCandidate(candidate: LegacyEquivalenceCandidate): LegacyEquivalenceCandidate {
  return { sourceVersion: candidate.sourceVersion, policy: parseContractPolicyV5(candidate.canonicalPolicy), canonicalPolicy: candidate.canonicalPolicy, candidateDigest: candidate.candidateDigest };
}
function preparedRecord(publication: unknown): PreparedMigrationRecord | undefined {
  return typeof publication === "object" && publication !== null ? preparedMigrations.get(publication as PreparedLegacyMigration) : undefined;
}
/** Private inspect, execute, and plan. Existing policy without proof is review-required, never setup overwrite. */
export async function prepareLegacyVaultMigration(target: WriteTarget, request: LegacyVaultMigrationRequest): Promise<LegacyMigrationPreparation> {
  if (!UUID.test(request.transactionId ?? "")) invalid("prepared migration requires a stable transaction identity");
  const admission = await inspectLegacyVaultPublication(target);
  if (admission.status === "absent" && await readControl(await admitted(target), POLICY) !== null) return { state: "review-required", admission: { ...admission, status: "legacy-invalid", reasons: ["existing policy has no verified historical marker"] } };
  if (admission.status === "absent") return { state: "setup-required", admission };
  if (admission.status !== "verified" && admission.status !== "migration-retry") return { state: "review-required", admission };
  const execution = executeLegacyVaultEquivalence(admission);
  if (execution?.disposition !== "proved") return { state: "review-required", admission, ...(execution?.disposition === "proposed" ? { proposal: execution.proposal } : {}) };
  const plan = await planLegacyVaultMigration(target, admission, execution.proof, request);
  const capability = Object.create(null) as PreparedLegacyMigration;
  const policy = cloneCandidate(execution.proposal.candidate);
  const returnedPolicy = cloneCandidate(policy);
  preparedMigrations.set(capability, { root: await admitted(target), plan, policy, locator: migrationLocator(plan) });
  return { state: "prepared", publication: capability, policy: returnedPolicy };
}
export function legacyMigrationLocator(publication: PreparedLegacyMigration): LegacyMigrationLocator {
  const record = preparedRecord(publication);
  if (record === undefined) invalid("legacy migration capability is not registered in this process");
  return { ...record.locator };
}
/** Commits only the original privately stored plan. A public plan or locator cannot enter. */
export async function commitPreparedLegacyMigration(target: WriteTarget, publication: PreparedLegacyMigration, options: PublicationOptions = {}): Promise<VaultPublicationReceipt> {
  const record = preparedRecord(publication);
  const root = await admitted(target);
  if (record === undefined || record.root !== root) invalid("legacy migration capability is not bound to this vault");
  return commitVaultPublication(target, record.plan, record.plan.planDigest, options);
}
async function readStoredMigrationPlan(root: string, locator: LegacyMigrationLocator): Promise<VaultPublicationPlan | "absent" | "unreadable"> {
  let bytes: Buffer | null;
  try { bytes = await readControl(root, `${rootFor(locator)}/plan.json`); }
  catch (error) { if (error instanceof VaultPublicationError && error.code === "PUBLICATION_INVALID") return "unreadable"; throw error; }
  if (bytes === null) return "absent";
  try {
    const plan = await loadPlan(root, locator.kind, locator.transactionId);
    if (!sameLocator(migrationLocator(plan), locator) || digestBytes(root) !== locator.targetDigest) return "unreadable";
    return plan;
  } catch (error) {
    if (error instanceof VaultPublicationError && (error.code === "PUBLICATION_INVALID" || error.code === "PUBLICATION_CONFLICT")) return "unreadable";
    throw error;
  }
}
/** Loads the original sealed plan. Absence is preparation-required; corrupt bytes are not absence. */
export async function recoverPreparedLegacyMigration(target: WriteTarget, locator: LegacyMigrationLocator, publication?: PreparedLegacyMigration, options: PublicationOptions = {}): Promise<VaultPublicationReceipt | { readonly state: "preparation-required"; readonly locator: LegacyMigrationLocator }> {
  if (locator.kind !== "schema-migration" || !UUID.test(locator.transactionId) || !UUID.test(locator.vaultId) || !DIGEST.test(locator.targetDigest) || !DIGEST.test(locator.planDigest)) invalid("legacy migration locator is malformed");
  const root = await admitted(target);
  if (digestBytes(root) !== locator.targetDigest) conflict("Recovery target differs from the approved publication target");
  const stored = await readStoredMigrationPlan(root, locator);
  if (stored === "unreadable") invalid("sealed migration plan is unreadable");
  const record = publication === undefined ? undefined : preparedRecord(publication);
  if (stored === "absent") {
    if (record === undefined || record.root !== root || !sameLocator(record.locator, locator)) return { state: "preparation-required", locator: { ...locator } };
    return commitVaultPublication(target, record.plan, record.plan.planDigest, options);
  }
  if (record !== undefined && (record.root !== root || !sameLocator(record.locator, locator) || record.plan.planDigest !== stored.planDigest)) conflict("fresh migration capability does not match the sealed plan");
  return recoverVaultPublication(target, stored.kind, stored.transactionId, stored.planDigest, "resume", options);
}

/** Reads the original sealed candidate. Absence is preparation-required; the returned copy is not commit authority. */
export async function inspectPreparedLegacyMigration(target: WriteTarget, locator: LegacyMigrationLocator): Promise<{ readonly state: "sealed"; readonly policy: LegacyEquivalenceCandidate } | { readonly state: "preparation-required"; readonly locator: LegacyMigrationLocator }> {
  if (locator.kind !== "schema-migration" || !UUID.test(locator.transactionId) || !UUID.test(locator.vaultId) || !DIGEST.test(locator.targetDigest) || !DIGEST.test(locator.planDigest)) invalid("legacy migration locator is malformed");
  const root = await admitted(target);
  if (digestBytes(root) !== locator.targetDigest) conflict("Recovery target differs from the approved publication target");
  const stored = await readStoredMigrationPlan(root, locator);
  if (stored === "unreadable") invalid("sealed migration plan is unreadable");
  if (stored === "absent") return { state: "preparation-required", locator: { ...locator } };
  const payload = decodePayload(bytesOf(stored.evidence.find(item => item.name === "legacy-migration")?.content ?? invalid("sealed migration plan has no original archive")));
  const policy = parseContractPolicyV5(payload.seal.canonicalPolicy);
  return { state: "sealed", policy: cloneCandidate({ sourceVersion: payload.seal.format === "v3" ? 3 : 4, policy, canonicalPolicy: payload.seal.canonicalPolicy, candidateDigest: payload.seal.candidateDigest }) };
}

/** Recovers one exact sealed settings plan. A missing transaction root is not-sealed; corruption is never absence. */
export async function recoverSealedSettingsPublication(target: WriteTarget, locator: SettingsPublicationLocator, options: PublicationOptions = {}): Promise<SealedSettingsPublicationRecovery> {
  if (locator.kind !== "settings-update" || !UUID.test(locator.transactionId) || !UUID.test(locator.vaultId) || !DIGEST.test(locator.targetDigest) || !DIGEST.test(locator.planDigest)) invalid("settings publication locator is malformed");
  const root = await admitted(target);
  if (digestBytes(root) !== locator.targetDigest) conflict("Recovery target differs from the approved publication target");
  const relativeRoot = rootFor({ kind: "settings-update", transactionId: locator.transactionId });
  const availability = await settingsTransactionRoot(root, relativeRoot);
  if (availability === "absent") {
    if (await settingsPublicationBegan(root, locator)) conflict("Settings publication evidence exists without its sealed transaction root");
    return { state: "not-sealed", locator: { ...locator } };
  }
  if (availability === "partial") invalid("settings publication namespace is incomplete");
  const plan = await loadPlan(root, "settings-update", locator.transactionId);
  if (plan.kind !== "settings-update" || plan.transactionId !== locator.transactionId || plan.vaultId !== locator.vaultId || plan.targetDigest !== locator.targetDigest || plan.planDigest !== locator.planDigest) conflict("sealed settings plan does not match the approved locator");
  const receipt = await recoverVaultPublication(target, plan.kind, plan.transactionId, plan.planDigest, "resume", options);
  if (receipt.kind !== plan.kind || receipt.transactionId !== plan.transactionId || receipt.planDigest !== plan.planDigest) conflict("settings recovery did not return the original sealed plan");
  return { state: "sealed", receipt };
}

async function settingsTransactionRoot(root: string, relativeRoot: string): Promise<"absent" | "partial" | "present"> {
  const verified = await verifyTemplateControlPath(root, normalizeTemplateControlPath(relativeRoot), { expected: "either" });
  if (verified.targetRealPath === null) return "absent";
  const stat = await lstat(verified.absolutePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("settings publication root is not a real directory");
  return await readControl(root, `${relativeRoot}/plan.json`) === null ? "partial" : "present";
}

async function settingsPublicationBegan(root: string, locator: SettingsPublicationLocator): Promise<boolean> {
  const marker = await readControl(root, MARKER);
  if (marker === null) return false;
  let parsed: PublicationMarker;
  try { parsed = parseMarker(marker); } catch { return true; }
  return parsed.transactionId === locator.transactionId || parsed.planDigest === locator.planDigest;
}

declare const preparedContractSourcePublicationBrand: unique symbol;
const admittedSourcePlans = new WeakSet<VaultPublicationPlan>();
/** Opaque in-process source publication. A serialized object or public plan is not this capability. */
export interface PreparedContractSourcePublication { readonly [preparedContractSourcePublicationBrand]: never }
export type ContractSourcePublicationInspection =
  | { readonly status: "absent"; readonly locator: ContractSourcePublicationLocator }
  | { readonly status: "sealed"; readonly locator: ContractSourcePublicationLocator }
  | { readonly status: "complete"; readonly receipt: VaultPublicationReceipt }
  | { readonly status: "rolled-back"; readonly receipt: VaultPublicationReceipt };
interface PreparedSourcePublicationRecord {
  readonly root: string;
  readonly locator: ContractSourcePublicationLocator;
  readonly plan: VaultPublicationPlan;
  readonly admitted: true;
  readonly absentAncestors: readonly { readonly path: string; readonly dev: number; readonly ino: number }[];
}
const preparedSourcePublications = new WeakMap<PreparedContractSourcePublication, PreparedSourcePublicationRecord>();
const SOURCE_LOCATOR_KEYS = new Set(["transactionId", "kind", "templateId"]);
const SOURCE_REVIEW_DECISION = "requested source acknowledgment; contract rules unchanged";
const SOURCE_RELINK_DECISION = "requested source relocation; contract rules unchanged";
const SOURCE_REVIEW_FIELDS = ["operation", "templateId", "sourceIdentity", "sourcePath", "previousRawDigest", "reviewedRawDigest"] as const;
const SOURCE_RELINK_FIELDS = ["operation", "templateId", "sourceIdentity", "fromPath", "toPath", "previousRawDigest", "reviewedRawDigest"] as const;

function exactSourceLocator(locator: ContractSourcePublicationLocator): ContractSourcePublicationLocator {
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) invalid("source publication locator must be an exact object");
  const keys = Reflect.ownKeys(locator);
  if (keys.length !== SOURCE_LOCATOR_KEYS.size || keys.some(key => typeof key !== "string" || !SOURCE_LOCATOR_KEYS.has(key))) invalid("source publication locator must contain only transactionId, kind, and templateId");
  const transactionId = locator.transactionId;
  const kind = locator.kind;
  const templateId = locator.templateId;
  if (typeof transactionId !== "string" || !UUID.test(transactionId) || (kind !== "source-review" && kind !== "relink") || typeof templateId !== "string" || templateId.length === 0) invalid("source publication locator fields are malformed");
  return { transactionId, kind, templateId };
}
function sourcePublicationOf(publication: unknown): PreparedSourcePublicationRecord | undefined {
  return typeof publication === "object" && publication !== null ? preparedSourcePublications.get(publication as PreparedContractSourcePublication) : undefined;
}
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sourceChangedPolicy(before: ReturnType<typeof parseContractPolicyV5>, facts: ContractSourceCommitFacts): ReturnType<typeof parseContractPolicyV5> {
  const current = before.templates[facts.templateId];
  if (current?.status !== "active") invalid("source publication template is not active");
  const source = facts.kind === "source-review"
    ? { ...current.source, rawDigest: facts.reviewedRawDigest }
    : { ...current.source, path: facts.toPath };
  return { ...before, revision: before.revision + 1, templates: { ...before.templates, [facts.templateId]: { ...current, source } } };
}
function assertSourceDelta(beforeText: string, afterText: string, facts: ContractSourceCommitFacts): void {
  const before = parseContractPolicyV5(beforeText);
  const after = parseContractPolicyV5(afterText);
  if (serializeContractPolicyV5(sourceChangedPolicy(before, facts)) !== afterText || serializeContractPolicyV5(after) !== afterText) invalid("source publication policy is not the exact permitted one-field delta");
  if (after.revision !== before.revision + 1) invalid("source publication must advance exactly one revision");
  for (const [id, entry] of Object.entries(after.templates)) {
    const previous = before.templates[id];
    if (previous === undefined) invalid("source publication cannot add a template");
    if (id !== facts.templateId) {
      if (!sameJson(entry, previous)) invalid("source publication changed an unrelated template");
      continue;
    }
    if (entry.status !== "active" || previous.status !== "active") invalid("source publication cannot change template status");
    const { source: nextSource, ...nextRules } = entry;
    const { source: previousSource, ...previousRules } = previous;
    if (!sameJson(nextRules, previousRules) || nextSource.identity !== previousSource.identity || nextSource.identity !== facts.sourceIdentity) invalid("source publication changed contract rules or source identity");
    if (facts.kind === "source-review" && (nextSource.path !== previousSource.path || nextSource.path !== facts.toPath || previousSource.rawDigest !== facts.previousRawDigest || nextSource.rawDigest !== facts.reviewedRawDigest || facts.previousRawDigest === facts.reviewedRawDigest)) invalid("source acknowledgment may change only the selected source digest");
    if (facts.kind === "relink" && (nextSource.rawDigest !== previousSource.rawDigest || nextSource.rawDigest !== facts.reviewedRawDigest || previousSource.path !== facts.fromPath || nextSource.path !== facts.toPath || facts.fromPath === facts.toPath || facts.previousRawDigest !== facts.reviewedRawDigest)) invalid("source relocation may change only the selected source path");
  }
  if (!sameJson(after.properties, before.properties) || !sameJson(after.common, before.common) || Object.keys(after.templates).length !== Object.keys(before.templates).length) invalid("source publication changed policy outside the selected source");
}
function sourceReview(facts: ContractSourceCommitFacts): Record<string, string> {
  if (facts.kind === "source-review") return { operation: "source-acknowledgment", templateId: facts.templateId, sourceIdentity: facts.sourceIdentity, sourcePath: facts.toPath, previousRawDigest: facts.previousRawDigest, reviewedRawDigest: facts.reviewedRawDigest };
  return { operation: "source-relink", templateId: facts.templateId, sourceIdentity: facts.sourceIdentity, fromPath: facts.fromPath, toPath: facts.toPath, previousRawDigest: facts.previousRawDigest, reviewedRawDigest: facts.reviewedRawDigest };
}
function assertSourceHistory(plan: VaultPublicationPlan, facts: ContractSourceCommitFacts, beforeText: string, afterText: string): void {
  assertSourcePlanAssertions(plan);
  const history = plan.outputs.find(output => historyRevision(output.path) !== null);
  if (history === undefined) invalid("source publication history is missing");
  const record = parseHistory(utf8(bytesOf(history.after)));
  if (!sameJson(record.review, sourceReview(facts)) || record.decision !== (facts.kind === "source-review" ? SOURCE_REVIEW_DECISION : SOURCE_RELINK_DECISION)) invalid("source publication history does not bind the claimed source facts");
  assertSourceDelta(beforeText, afterText, facts);
}
async function planContractSourcePublication(root: string, locator: ContractSourcePublicationLocator, facts: ContractSourceCommitFacts, beforeText: string): Promise<VaultPublicationPlan> {
  const before = parseContractPolicyV5(beforeText);
  const afterText = serializeContractPolicyV5(sourceChangedPolicy(before, facts));
  assertSourceDelta(beforeText, afterText, facts);
  const positive = [{ path: facts.toPath, digest: facts.reviewedRawDigest }];
  const absent = facts.kind === "relink" ? [facts.fromPath] : [];
  const settings = await readControl(root, SETTINGS);
  const vaultId = settings === null ? invalid("source publication requires existing settings") : parseVaultSettings(utf8(settings)).vaultId;
  if (!UUID.test(vaultId)) invalid("source publication has no portable vault identity");
  const request: VaultPublicationRequest = {
    transactionId: locator.transactionId,
    kind: "contract-publication",
    vaultId,
    outputs: [{ path: POLICY, expectedDigest: digestBytes(beforeText), content: afterText }],
    sources: positive.map(source => ({ ...source })),
    ...(facts.kind === "relink" ? { absentSources: absent } : {}),
    history: { kind: facts.kind, decision: facts.kind === "source-review" ? SOURCE_REVIEW_DECISION : SOURCE_RELINK_DECISION, review: sourceReview(facts) },
  };
  const plan = await planOrdinaryPublication(root, request);
  assertSourceHistory(plan, facts, beforeText, afterText);
  admittedSourcePlans.add(plan);
  return plan;
}
async function sourceTransactionRoot(root: string, relativeRoot: string): Promise<"absent" | "partial" | "present" | "unreadable"> {
  let verified: Awaited<ReturnType<typeof verifyTemplateControlPath>>;
  try { verified = await verifyTemplateControlPath(root, normalizeTemplateControlPath(relativeRoot), { expected: "either" }); }
  catch (error) { if (error instanceof VaultPublicationError) return "unreadable"; throw error; }
  if (verified.targetRealPath === null) return "absent";
  const stat = await lstat(verified.absolutePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return "unreadable";
  try { return await readControl(root, `${relativeRoot}/plan.json`) === null ? "partial" : "present"; }
  catch (error) { if (error instanceof VaultPublicationError) return "unreadable"; throw error; }
}
async function sourceOperationBegan(root: string, locator: ContractSourcePublicationLocator): Promise<boolean> {
  const marker = await readControl(root, MARKER);
  if (marker === null) return false;
  let parsed: PublicationMarker;
  try { parsed = parseMarker(marker); } catch { return true; }
  return parsed.transactionId === locator.transactionId;
}
type SourceReceiptState = { readonly receipt: VaultPublicationReceipt } | "sealed" | "corrupt" | "foreign" | "rolling-back";
async function sourceReceiptState(root: string, plan: VaultPublicationPlan): Promise<SourceReceiptState> {
  await assertSourcePortableIdentity(root, plan);
  const completePath = `${rootFor(plan)}/complete-receipt.json`;
  const rolledPath = `${rootFor(plan)}/rolled-back-receipt.json`;
  const completeBytes = await readControl(root, completePath);
  const rolledBytes = await readControl(root, rolledPath);
  const currentMarker = await readControl(root, MARKER);
  let marker: PublicationMarker | null = null;
  if (currentMarker !== null) {
    try { marker = parseMarker(currentMarker); } catch { return "corrupt"; }
  }
  const owned = marker !== null && marker.transactionId === plan.transactionId && marker.planDigest === plan.planDigest && marker.kind === plan.kind;
  if (completeBytes === null && rolledBytes === null) {
    if (owned && (marker?.status === "complete" || marker?.status === "rolled-back")) return "corrupt";
    if (owned && marker?.status === "rolling-back") return "rolling-back";
    if (owned || matches(currentMarker, plan.markerBefore)) return "sealed";
    return "foreign";
  }
  if (!owned) return "foreign";
  let terminal: VaultPublicationReceipt | null;
  try {
    const complete = await observedTerminalReceipt(root, plan, false);
    const rolled = await observedTerminalReceipt(root, plan, true);
    if (completeBytes !== null && complete === null) return "corrupt";
    if (rolledBytes !== null && rolled === null) return "corrupt";
    terminal = rolled ?? complete;
  } catch (error) {
    if (error instanceof VaultPublicationError) return "corrupt";
    throw error;
  }
  if (terminal === null) return "corrupt";
  await verifySealed(root, plan);
  await revalidatePublicationPhase(root, plan, terminal.status === "rolled-back");
  await verifyTerminalPostimages(root, plan, terminal);
  return { receipt: terminal };
}
function assertRecoveredSourcePlan(plan: VaultPublicationPlan, locator: ContractSourcePublicationLocator, root: string): void {
  if (plan.kind !== "contract-publication" || plan.transactionId !== locator.transactionId || digestBytes(root) !== plan.targetDigest) invalid("sealed source plan belongs to another transaction");
  const history = plan.outputs.find(output => historyRevision(output.path) !== null);
  const policy = plan.outputs.find(output => output.path === POLICY);
  if (history === undefined || policy?.before === null || policy === undefined) invalid("sealed source plan has no policy delta");
  const record = parseHistory(utf8(bytesOf(history.after)));
  if (record.kind !== locator.kind || record.transactionId !== locator.transactionId) invalid("sealed source plan belongs to another source operation");
  const review = record.review;
  if (review === undefined || review.templateId !== locator.templateId) invalid("sealed source plan belongs to another template");
  const beforeText = utf8(bytesOf(policy.before));
  const afterText = utf8(bytesOf(policy.after));
  const before = parseContractPolicyV5(beforeText);
  const entry = before.templates[locator.templateId];
  if (entry?.status !== "active" || typeof review.sourceIdentity !== "string" || typeof review.previousRawDigest !== "string" || typeof review.reviewedRawDigest !== "string") invalid("sealed source plan history is not factual");
  const facts: ContractSourceCommitFacts = locator.kind === "source-review"
    ? { kind: locator.kind, transactionId: locator.transactionId, templateId: locator.templateId, canonicalVault: root, expectedPolicyDigest: digestBytes(beforeText), policyRevision: before.revision, sourceIdentity: review.sourceIdentity, fromPath: entry.source.path, toPath: entry.source.path, previousRawDigest: review.previousRawDigest as Digest, reviewedRawDigest: review.reviewedRawDigest as Digest }
    : { kind: locator.kind, transactionId: locator.transactionId, templateId: locator.templateId, canonicalVault: root, expectedPolicyDigest: digestBytes(beforeText), policyRevision: before.revision, sourceIdentity: review.sourceIdentity, fromPath: typeof review.fromPath === "string" ? review.fromPath : invalid("sealed relink has no original path"), toPath: typeof review.toPath === "string" ? review.toPath : invalid("sealed relink has no destination path"), previousRawDigest: review.previousRawDigest as Digest, reviewedRawDigest: review.reviewedRawDigest as Digest };
  assertSourceHistory(plan, facts, beforeText, afterText);
}
/** Reads one named source transaction. Absence is only a genuinely missing root with no same-operation marker. */
export async function inspectContractSourcePublication(target: WriteTarget, locator: ContractSourcePublicationLocator): Promise<ContractSourcePublicationInspection> {
  const exact = exactSourceLocator(locator);
  const root = await admitted(target);
  const relativeRoot = rootFor({ kind: "contract-publication", transactionId: exact.transactionId });
  const availability = await sourceTransactionRoot(root, relativeRoot);
  if (availability === "absent") {
    if (await sourceOperationBegan(root, exact)) conflict("Source publication evidence exists without its sealed transaction root");
    return { status: "absent", locator: exact };
  }
  if (availability !== "present") invalid("source publication namespace is incomplete or unreadable");
  let plan: VaultPublicationPlan;
  try { plan = await loadPlan(root, "contract-publication", exact.transactionId); }
  catch (error) { if (error instanceof VaultPublicationError) invalid("sealed source publication plan is missing, malformed, or mismatched"); throw error; }
  assertRecoveredSourcePlan(plan, exact, root);
  const terminal = await sourceReceiptState(root, plan);
  if (terminal === "corrupt") invalid("sealed source receipt is corrupt");
  if (terminal === "foreign") conflict("Another publication owns the vault marker");
  if (terminal === "rolling-back") conflict("Source publication is rolling back; forward resume is refused");
  if (terminal === "sealed") return { status: "sealed", locator: exact };
  return { status: terminal.receipt.status, receipt: terminal.receipt };
}
/** Claims actual policy bytes, derives the one permitted delta, and retains only the opaque plan. */
export async function prepareContractSourcePublication(target: WriteTarget, locator: ContractSourcePublicationLocator, preparation: unknown): Promise<PreparedContractSourcePublication> {
  const exact = exactSourceLocator(locator);
  const root = await admitted(target);
  const existing = await inspectContractSourcePublication(target, exact);
  if (existing.status !== "absent") conflict("An existing sealed source publication cannot be replanned");
  const before = await readControl(root, POLICY);
  if (before === null) invalid("source publication requires the current policy");
  const policyBytes = utf8(before);
  const facts = await claimPreparedContractSourceCommit(preparation, { vault: root, locator: exact, policyBytes });
  if (facts === null || facts.canonicalVault !== root || facts.transactionId !== exact.transactionId || facts.kind !== exact.kind || facts.templateId !== exact.templateId || facts.expectedPolicyDigest !== digestBytes(policyBytes)) invalid("source publication capability did not match the actual current policy");
  const plan = await planContractSourcePublication(root, exact, facts, policyBytes);
  const absentAncestors = await observeAbsentSourceAncestors(root, plan);
  const opaque = Object.freeze({}) as PreparedContractSourcePublication;
  preparedSourcePublications.set(opaque, { root, locator: exact, plan, admitted: true, absentAncestors });
  return opaque;
}
/** Commits only the plan privately retained by the opaque factory. */
export async function commitPreparedContractSourcePublication(target: WriteTarget, publication: PreparedContractSourcePublication, options: PublicationOptions = {}): Promise<VaultPublicationReceipt> {
  const record = sourcePublicationOf(publication);
  const root = await admitted(target);
  if (record === undefined || record.admitted !== true || record.root !== root) invalid("source publication capability is not bound to this vault");
  await assertPreparedAbsentAncestors(record.absentAncestors);
  return commitVaultPublication(target, record.plan, record.plan.planDigest, options);
}
/** Resumes the original sealed plan. A fresh capability or caller hash cannot replace it. */
export async function resumeContractSourcePublication(target: WriteTarget, locator: ContractSourcePublicationLocator, options: PublicationOptions = {}): Promise<VaultPublicationReceipt> {
  const exact = exactSourceLocator(locator);
  const root = await admitted(target);
  const relativeRoot = rootFor({ kind: "contract-publication", transactionId: exact.transactionId });
  const availability = await sourceTransactionRoot(root, relativeRoot);
  if (availability === "absent") {
    if (await sourceOperationBegan(root, exact)) conflict("Source publication evidence exists without its sealed transaction root");
    invalid("source publication is not sealed");
  }
  if (availability !== "present") invalid("source publication namespace is incomplete or unreadable");
  const plan = await loadPlan(root, "contract-publication", exact.transactionId);
  assertRecoveredSourcePlan(plan, exact, root);
  const terminal = await sourceReceiptState(root, plan);
  if (terminal === "corrupt") invalid("sealed source receipt is corrupt");
  if (terminal === "foreign") conflict("Another publication owns the vault marker");
  if (terminal === "rolling-back") conflict("Source publication is rolling back; forward resume is refused");
  if (terminal === "sealed" || terminal.receipt.status === "complete") return recoverVaultPublication(target, plan.kind, plan.transactionId, plan.planDigest, "resume", options);
  return conflict("A rolled-back source publication cannot be resumed forward");
}
