import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { digestBytes } from "./canonical.js";
import { scanTemplateSources, type TemplateSourceInventory } from "./census.js";
import { bindContractHeadings } from "./contract-check.js";
import { ContractV5Error, composeContractV5, parseContractPolicyV5, serializeContractPolicyV5, type ActiveTemplateContractV5, type ContractPolicyV5, type EffectiveContractV5 } from "./contract-v5.js";
import { normalizeTemplateSourcePath } from "./paths.js";
import type { Digest } from "./types.js";

export type SourceRegistryErrorCode = "SOURCE_MISSING" | "SOURCE_DRIFT" | "SOURCE_UNREADABLE" | "SOURCE_NOT_MISSING" | "SOURCE_REVIEW_CONFIRMATION_REQUIRED" | "SOURCE_REVIEW_NOT_NEEDED" | "SOURCE_REVIEW_EVIDENCE_INVALID" | "RELINK_CONFIRMATION_REQUIRED" | "RESELECT_REQUIRED" | "HEADING_BINDING_INVALID";
export class SourceRegistryError extends Error {
  constructor(readonly code: SourceRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SourceRegistryError";
  }
}
function explicitCanonicalSourcePath(candidatePath: string): string {
  if (typeof candidatePath !== "string") throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Relink candidate must be an explicit path string.");
  let normalized: string;
  try { normalized = normalizeTemplateSourcePath(candidatePath); }
  catch (error) { throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", `Explicit relink candidate must already be canonical: ${error instanceof Error ? error.message : "invalid source path"}`); }
  if (normalized !== candidatePath) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Explicit relink candidate must already be canonical; normalization must not choose a different path.");
  return normalized;
}
export interface ContractSelectionBinding {
  readonly version: 1;
  readonly templateId: string | null;
  readonly policyRevision: number;
  readonly contractDigest: Digest;
  readonly sourceIdentity: string | null;
  readonly sourcePath: string | null;
  readonly sourceDigest: Digest | null;
  readonly headingBindings: Readonly<Record<string, string>>;
}
export interface SelectedContractV5 {
  readonly contract: EffectiveContractV5;
  readonly binding: ContractSelectionBinding;
  readonly source: { readonly path: string; readonly text: string; readonly rawDigest: Digest } | null;
}
export interface RegisteredSourceDiscovery {
  readonly complete: boolean;
  readonly diagnostics: TemplateSourceInventory["diagnostics"];
  readonly registeredCount: number;
  readonly candidates: readonly { readonly path: string; readonly rawDigest: Digest; readonly readable: boolean; readonly registeredId: string | null }[];
}

/** A raw candidate remains a candidate, even when its bytes happen to match an existing source. */
export async function discoverRegisteredSources(vault: string, policy: ContractPolicyV5, roots: readonly string[]): Promise<RegisteredSourceDiscovery> {
  const parsed = parseContractPolicyV5(policy);
  const inventory = await scanTemplateSources(vault, roots.map(path => ({ path, kind: "folder" })));
  const byPath = new Map<string, string>();
  for (const [id, entry] of Object.entries(parsed.templates)) if (entry.status === "active") byPath.set(entry.source.path, id);
  return {
    complete: inventory.complete,
    diagnostics: inventory.diagnostics,
    registeredCount: Object.keys(parsed.templates).length,
    candidates: inventory.sources.map(source => ({ path: source.path, rawDigest: source.rawDigest, readable: source.text !== null, registeredId: byPath.get(source.path) ?? null })),
  };
}

async function selectedSource(vault: string, entry: ActiveTemplateContractV5): Promise<NonNullable<SelectedContractV5["source"]>> {
  const inventory = await scanTemplateSources(vault, [{ path: entry.source.path, kind: "file" }]);
  const source = inventory.sources.find(candidate => candidate.path === entry.source.path);
  if (source === undefined) {
    const missing = inventory.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_MISSING");
    throw new SourceRegistryError(missing ? "SOURCE_MISSING" : "SOURCE_UNREADABLE", `Registered source '${entry.source.path}' cannot be selected; review its source status.`);
  }
  if (source.rawDigest !== entry.source.rawDigest) throw new SourceRegistryError("SOURCE_DRIFT", `Source '${entry.source.path}' changed since contract approval; review before selecting it.`);
  if (source.text === null || !inventory.complete) throw new SourceRegistryError("SOURCE_UNREADABLE", `Source '${entry.source.path}' cannot be read as a complete UTF-8 template.`);
  return { path: source.path, rawDigest: source.rawDigest, text: source.text };
}

/** Select common alone with null, or one explicit registration. Markdown is returned, never executed. */
export async function selectContractV5(
  vault: string,
  input: ContractPolicyV5,
  templateId: string | null,
  headingBindings: Readonly<Record<string, string>> = {},
): Promise<SelectedContractV5> {
  const policy = parseContractPolicyV5(input);
  const contract = composeContractV5(policy, templateId);
  const bound = bindContractHeadings(contract, headingBindings);
  if (bound.violations.length) throw new SourceRegistryError("HEADING_BINDING_INVALID", bound.violations.map(item => item.message).join(" "));
  let source: SelectedContractV5["source"] = null;
  let sourceIdentity: string | null = null;
  if (templateId !== null) {
    const entry = policy.templates[templateId]!;
    // Composition already rejected inactive entries before any source read.
    if (entry.status !== "active") throw new SourceRegistryError("RESELECT_REQUIRED", "Selected contract requires review.");
    source = await selectedSource(vault, entry);
    sourceIdentity = entry.source.identity;
  }
  return {
    contract,
    source,
    binding: { version: 1, templateId, policyRevision: policy.revision, contractDigest: contract.contractDigest, sourceIdentity, sourcePath: source?.path ?? null, sourceDigest: source?.rawDigest ?? null, headingBindings: { ...headingBindings } },
  };
}

/** Existing saved bindings never silently acquire new rules, source bytes, or heading slots. */
export async function revalidateContractSelection(vault: string, policy: ContractPolicyV5, binding: ContractSelectionBinding): Promise<SelectedContractV5> {
  if (binding.version !== 1 || binding.policyRevision !== policy.revision) throw new SourceRegistryError("RESELECT_REQUIRED", "Policy revision changed; select the contract again.");
  let selected: SelectedContractV5;
  try { selected = await selectContractV5(vault, policy, binding.templateId, binding.headingBindings); }
  catch (error) {
    throw new SourceRegistryError("RESELECT_REQUIRED", `Saved selection is no longer usable: ${error instanceof Error ? error.message : "unknown selection error"}`);
  }
  if (selected.binding.contractDigest !== binding.contractDigest || selected.binding.sourceDigest !== binding.sourceDigest || selected.binding.sourceIdentity !== binding.sourceIdentity || selected.binding.sourcePath !== binding.sourcePath) throw new SourceRegistryError("RESELECT_REQUIRED", "Effective rules or source identity, path or bytes changed; select the contract again.");
  return selected;
}

async function assertSourceMissing(vault: string, entry: ActiveTemplateContractV5): Promise<void> {
  const inventory = await scanTemplateSources(vault, [{ path: entry.source.path, kind: "file" }]);
  if (inventory.sources.some(source => source.path === entry.source.path)) throw new SourceRegistryError("SOURCE_NOT_MISSING", "The original source still exists; another copy is not a source relocation.");
  if (!inventory.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_MISSING" && item.path === entry.source.path)) throw new SourceRegistryError("SOURCE_UNREADABLE", "Cannot establish that the original source is missing; resolve its access status before relinking.");
}

export interface SourceRelinkCandidates {
  readonly templateId: string;
  readonly sourceIdentity: string;
  readonly approvedPath: string;
  readonly candidates: readonly string[];
  readonly complete: boolean;
  readonly diagnostics: TemplateSourceInventory["diagnostics"];
  readonly confirmationRequired: true;
}
/** SHA is candidate evidence, not identity or permission to relink. */
export async function findSourceRelinkCandidates(vault: string, input: ContractPolicyV5, templateId: string, roots: readonly string[]): Promise<SourceRelinkCandidates> {
  const policy = parseContractPolicyV5(input);
  composeContractV5(policy, templateId);
  const entry = policy.templates[templateId]!;
  if (entry.status !== "active") throw new SourceRegistryError("RESELECT_REQUIRED", "Contract must be active before source relinking.");
  await assertSourceMissing(vault, entry);
  const discovery = await discoverRegisteredSources(vault, policy, roots);
  return {
    templateId,
    sourceIdentity: entry.source.identity,
    approvedPath: entry.source.path,
    candidates: discovery.candidates.filter(source => source.path !== entry.source.path && source.rawDigest === entry.source.rawDigest && source.readable && source.registeredId === null).map(source => source.path),
    complete: discovery.complete,
    diagnostics: discovery.diagnostics,
    confirmationRequired: true,
  };
}

export interface SourceRelinkProposal {
  readonly policy: ContractPolicyV5;
  readonly expectedPolicyDigest: Digest;
  readonly templateId: string;
  readonly sourceIdentity: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly rawDigest: Digest;
}

export interface ContractSourceReview {
  readonly templateId: string;
  readonly sourceIdentity: string;
  readonly path: string;
  readonly approvedDigest: Digest;
  readonly currentDigest: Digest | null;
  readonly currentText: string | null;
  readonly previousText: string | null;
  readonly previousBytesAvailable: boolean;
  readonly state: "unchanged" | "drift" | "missing" | "unreadable";
  readonly diagnostics: TemplateSourceInventory["diagnostics"];
}
function activeRegistration(policy: ContractPolicyV5, templateId: string): ActiveTemplateContractV5 {
  const entry = policy.templates[templateId];
  if (entry === undefined) throw new ContractV5Error("CONTRACT_UNKNOWN_TEMPLATE", `Unknown registered template '${templateId}'.`);
  if (entry.status !== "active") throw new SourceRegistryError("RESELECT_REQUIRED", "The contract itself requires review; source acknowledgment cannot activate it.");
  return entry;
}
/** Review is read-only; missing historical bytes are explicit, never replaced with current bytes. */
export async function inspectContractSource(vault: string, input: ContractPolicyV5, templateId: string, previousBytes?: Uint8Array): Promise<ContractSourceReview> {
  const entry = activeRegistration(parseContractPolicyV5(input), templateId);
  let previousText: string | null = null;
  if (previousBytes !== undefined) {
    if (digestBytes(previousBytes) !== entry.source.rawDigest) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Historical bytes do not match the registered source SHA.");
    try { previousText = new TextDecoder("utf-8", { fatal: true }).decode(previousBytes); }
    catch { throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Historical source bytes are not valid UTF-8."); }
  }
  const inventory = await scanTemplateSources(vault, [{ path: entry.source.path, kind: "file" }]);
  const source = inventory.sources.find(candidate => candidate.path === entry.source.path);
  const state = source === undefined
    ? inventory.diagnostics.some(item => item.code === "TEMPLATE_SOURCE_MISSING") ? "missing" : "unreadable"
    : source.text === null || !inventory.complete ? "unreadable" : source.rawDigest === entry.source.rawDigest ? "unchanged" : "drift";
  return { templateId, sourceIdentity: entry.source.identity, path: entry.source.path, approvedDigest: entry.source.rawDigest, currentDigest: source?.rawDigest ?? null, currentText: source?.text ?? null, previousText, previousBytesAvailable: previousBytes !== undefined, state, diagnostics: inventory.diagnostics };
}

export interface SourceAcknowledgmentProposal {
  readonly policy: ContractPolicyV5;
  readonly expectedPolicyDigest: Digest;
  readonly templateId: string;
  readonly sourceIdentity: string;
  readonly path: string;
  readonly previousDigest: Digest;
  readonly reviewedDigest: Digest;
  readonly decision: "source-reviewed";
}
/** An explicit no-contract-change decision still binds exact reviewed bytes and advances policy CAS. */
export async function proposeSourceAcknowledgment(vault: string, policyBytes: string, templateId: string, reviewedDigest: Digest, confirmed: boolean): Promise<SourceAcknowledgmentProposal> {
  if (!confirmed) throw new SourceRegistryError("SOURCE_REVIEW_CONFIRMATION_REQUIRED", "Confirm that the reviewed source change requires no contract change; deferral does not update its SHA.");
  const policy = parseContractPolicyV5(policyBytes);
  const entry = activeRegistration(policy, templateId);
  const review = await inspectContractSource(vault, policy, templateId);
  if (review.state === "missing") throw new SourceRegistryError("SOURCE_MISSING", "The original source is missing; use confirmed source relocation.");
  if (review.state === "unreadable") throw new SourceRegistryError("SOURCE_UNREADABLE", "The original source is unreadable; its SHA cannot be acknowledged.");
  if (review.currentDigest !== reviewedDigest) throw new SourceRegistryError("SOURCE_DRIFT", "Source bytes changed after review; the earlier confirmation cannot be reused.");
  if (review.state === "unchanged") throw new SourceRegistryError("SOURCE_REVIEW_NOT_NEEDED", "The source already matches the registered SHA.");
  const proposed = parseContractPolicyV5({ ...policy, revision: policy.revision + 1, templates: { ...policy.templates, [templateId]: { ...entry, source: { ...entry.source, rawDigest: reviewedDigest } } } });
  serializeContractPolicyV5(proposed);
  return { policy: proposed, expectedPolicyDigest: digestBytes(policyBytes), templateId, sourceIdentity: entry.source.identity, path: entry.source.path, previousDigest: entry.source.rawDigest, reviewedDigest, decision: "source-reviewed" };
}

/** Pure proposal only; a separate verified-target publisher must still CAS the whole policy bytes. */
export async function proposeSourceRelink(vault: string, policyBytes: string, templateId: string, candidatePath: string, confirmed: boolean): Promise<SourceRelinkProposal> {
  if (!confirmed) throw new SourceRegistryError("RELINK_CONFIRMATION_REQUIRED", "Confirm the selected candidate path before proposing a source relocation.");
  const policy = parseContractPolicyV5(policyBytes);
  composeContractV5(policy, templateId);
  const entry = policy.templates[templateId]!;
  if (entry.status !== "active") throw new SourceRegistryError("RESELECT_REQUIRED", "Contract must be active before source relinking.");
  await assertSourceMissing(vault, entry);
  const path = explicitCanonicalSourcePath(candidatePath);
  const source = await selectedSource(vault, { ...entry, source: { ...entry.source, path } });
  const proposed = parseContractPolicyV5({ ...policy, revision: policy.revision + 1, templates: { ...policy.templates, [templateId]: { ...entry, source: { ...entry.source, path: source.path } } } });
  // Validate serializability before handing a candidate to the write kernel.
  serializeContractPolicyV5(proposed);
  return { policy: proposed, expectedPolicyDigest: digestBytes(policyBytes), templateId, sourceIdentity: entry.source.identity, fromPath: entry.source.path, toPath: source.path, rawDigest: source.rawDigest };
}

declare const preparedContractSourceCommitBrand: unique symbol;
export type ContractSourceCommitKind = "source-review" | "relink";
export interface ContractSourcePublicationLocator {
  readonly transactionId: string;
  readonly kind: ContractSourceCommitKind;
  readonly templateId: string;
}
export interface PreparedContractSourceCommit {
  readonly [preparedContractSourceCommitBrand]: never;
}
export interface PreparedContractSourceReview {
  readonly review: ContractSourceReview;
  readonly preparation: PreparedContractSourceCommit;
}
export interface ContractSourceCommitFacts {
  readonly kind: ContractSourceCommitKind;
  readonly transactionId: string;
  readonly templateId: string;
  readonly canonicalVault: string;
  readonly expectedPolicyDigest: Digest;
  readonly policyRevision: number;
  readonly sourceIdentity: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly previousRawDigest: Digest;
  readonly reviewedRawDigest: Digest;
}

const LOCATOR_KEYS = new Set(["transactionId", "kind", "templateId"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const preparations = new WeakMap<PreparedContractSourceCommit, CommitRecord>();

interface CommitRecord {
  readonly kind: ContractSourceCommitKind;
  readonly transactionId: string;
  readonly templateId: string;
  readonly canonicalVault: string;
  readonly expectedPolicyDigest: Digest;
  readonly policyRevision: number;
  readonly sourceIdentity: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly previousRawDigest: Digest;
  readonly reviewedRawDigest: Digest;
}

interface PreparedRequest {
  readonly vault: string;
  readonly policyBytes: string;
  readonly locator: ContractSourcePublicationLocator;
  readonly candidatePath?: string;
}

function copyDiagnostic(item: TemplateSourceInventory["diagnostics"][number]): TemplateSourceInventory["diagnostics"][number] {
  return { code: item.code, message: item.message, ...(item.path === undefined ? {} : { path: item.path }), ...(item.templateId === undefined ? {} : { templateId: item.templateId }) };
}
function copyReview(review: ContractSourceReview): ContractSourceReview {
  return { ...review, diagnostics: review.diagnostics.map(copyDiagnostic) };
}
function factsOf(record: CommitRecord): ContractSourceCommitFacts {
  return {
    kind: record.kind,
    transactionId: record.transactionId,
    templateId: record.templateId,
    canonicalVault: record.canonicalVault,
    expectedPolicyDigest: record.expectedPolicyDigest,
    policyRevision: record.policyRevision,
    sourceIdentity: record.sourceIdentity,
    fromPath: record.fromPath,
    toPath: record.toPath,
    previousRawDigest: record.previousRawDigest,
    reviewedRawDigest: record.reviewedRawDigest,
  };
}
function snapshotRequest(vault: string, policyBytes: string, locator: ContractSourcePublicationLocator, candidatePath?: string): PreparedRequest {
  if (typeof vault !== "string" || vault.includes("\0") || !isAbsolute(vault)) throw new SourceRegistryError("SOURCE_UNREADABLE", "Vault must be an absolute path without NUL.");
  if (typeof policyBytes !== "string") throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Policy bytes must be the exact raw policy text.");
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Publication locator must be an exact object.");
  const keys = Reflect.ownKeys(locator);
  if (keys.length !== LOCATOR_KEYS.size || keys.some(key => typeof key !== "string" || !LOCATOR_KEYS.has(key))) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Publication locator must contain only transactionId, kind, and templateId.");
  const { transactionId, kind, templateId } = locator;
  if (typeof transactionId !== "string" || !UUID.test(transactionId)) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "transactionId must be a lowercase UUID.");
  if (kind !== "source-review" && kind !== "relink") throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Publication kind is malformed.");
  if (typeof templateId !== "string" || templateId.length === 0) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "templateId must be a non-empty string.");
  if (candidatePath !== undefined && typeof candidatePath !== "string") throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Relink candidate must be an explicit path string.");
  return { vault, policyBytes, locator: { transactionId, kind, templateId }, ...(candidatePath === undefined ? {} : { candidatePath }) };
}
async function canonicalPublicRoot(vault: string): Promise<string> {
  let root: string;
  try { root = resolve(await realpath(vault)); }
  catch { throw new SourceRegistryError("SOURCE_UNREADABLE", "Canonical vault root cannot be established."); }
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SourceRegistryError("SOURCE_UNREADABLE", "Canonical vault must be a real directory.");
  return root;
}
function seal(request: PreparedRequest, root: string, policy: ContractPolicyV5, review: ContractSourceReview, entry: ActiveTemplateContractV5, toPath: string, reviewedRawDigest: Digest): PreparedContractSourceReview {
  const preparation = Object.freeze({}) as PreparedContractSourceCommit;
  preparations.set(preparation, {
    kind: request.locator.kind,
    transactionId: request.locator.transactionId,
    templateId: request.locator.templateId,
    canonicalVault: root,
    expectedPolicyDigest: digestBytes(request.policyBytes),
    policyRevision: policy.revision,
    sourceIdentity: entry.source.identity,
    fromPath: entry.source.path,
    toPath,
    previousRawDigest: entry.source.rawDigest,
    reviewedRawDigest,
  });
  return { review: copyReview(review), preparation };
}
/** Fresh confined inspection. The returned capability is process-local and is not commit authority until claimed. */
export async function prepareContractSourceAcknowledgment(vault: string, policyBytes: string, locator: ContractSourcePublicationLocator): Promise<PreparedContractSourceReview> {
  const request = snapshotRequest(vault, policyBytes, locator);
  if (request.locator.kind !== "source-review") throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Acknowledgment requires a source-review locator.");
  const policy = parseContractPolicyV5(request.policyBytes);
  const entry = activeRegistration(policy, request.locator.templateId);
  const root = await canonicalPublicRoot(request.vault);
  const review = await inspectContractSource(root, policy, request.locator.templateId);
  if (review.state === "missing") throw new SourceRegistryError("SOURCE_MISSING", "The original source is missing; use explicit source relocation.");
  if (review.state === "unreadable") throw new SourceRegistryError("SOURCE_UNREADABLE", "The original source is unreadable; its SHA cannot be acknowledged.");
  if (review.state !== "drift" || review.currentDigest === null || review.currentDigest === entry.source.rawDigest) throw new SourceRegistryError("SOURCE_REVIEW_NOT_NEEDED", "Acknowledgment requires an actual source drift.");
  return seal(request, root, policy, review, entry, entry.source.path, review.currentDigest);
}
/** Explicit candidate only. SHA equality is evidence, never permission to choose a path. */
export async function prepareContractSourceRelink(vault: string, policyBytes: string, locator: ContractSourcePublicationLocator, candidatePath: string): Promise<PreparedContractSourceReview> {
  const request = snapshotRequest(vault, policyBytes, locator, candidatePath);
  if (request.locator.kind !== "relink" || request.candidatePath === undefined) throw new SourceRegistryError("SOURCE_REVIEW_EVIDENCE_INVALID", "Relink requires a relink locator and an explicit candidate path.");
  const policy = parseContractPolicyV5(request.policyBytes);
  const entry = activeRegistration(policy, request.locator.templateId);
  const root = await canonicalPublicRoot(request.vault);
  await assertSourceMissing(root, entry);
  const path = explicitCanonicalSourcePath(request.candidatePath);
  const source = await selectedSource(root, { ...entry, source: { ...entry.source, path } });
  if (source.rawDigest !== entry.source.rawDigest) throw new SourceRegistryError("SOURCE_DRIFT", "The explicit candidate does not have the registered source SHA.");
  const review = await inspectContractSource(root, policy, request.locator.templateId);
  if (review.state !== "missing") throw new SourceRegistryError("SOURCE_NOT_MISSING", "The original source is not genuinely missing.");
  return seal(request, root, policy, review, entry, source.path, source.rawDigest);
}
/** One-shot private claim. expected.policyBytes is the publisher's actual raw snapshot, not caller authentication. A mismatch returns null and does not mint facts. */
export async function claimPreparedContractSourceCommit(preparation: unknown, expected: { vault: string; locator: ContractSourcePublicationLocator; policyBytes: string }): Promise<ContractSourceCommitFacts | null> {
  if (preparation === null || typeof preparation !== "object") return null;
  const capability = preparation as PreparedContractSourceCommit;
  const record = preparations.get(capability);
  if (record === undefined) return null;
  let request: PreparedRequest;
  try { request = snapshotRequest(expected.vault, expected.policyBytes, expected.locator); }
  catch { return null; }
  const root = await canonicalPublicRoot(request.vault).catch(() => null);
  if (preparations.get(capability) !== record) return null;
  const policy = (() => { try { return parseContractPolicyV5(request.policyBytes); } catch { return null; } })();
  const suppliedDigest = digestBytes(request.policyBytes);
  const samePolicy = root === record.canonicalVault
    && request.locator.transactionId === record.transactionId
    && request.locator.kind === record.kind
    && request.locator.templateId === record.templateId
    && suppliedDigest === record.expectedPolicyDigest
    && policy?.revision === record.policyRevision;
  const entry = policy?.templates[record.templateId];
  const sameRegistration = entry?.status === "active" && entry.source.identity === record.sourceIdentity && entry.source.path === record.fromPath && entry.source.rawDigest === record.previousRawDigest;
  if (!samePolicy || !sameRegistration || root === null) return null;
  let live: ContractSourceReview | null;
  try { live = await inspectContractSource(root, policy!, record.templateId); }
  catch (error) {
    if (preparations.get(capability) !== record) return null;
    if (error instanceof SourceRegistryError && error.code === "SOURCE_UNREADABLE") throw error;
    live = null;
  }
  if (preparations.get(capability) !== record) return null;
  // An unobservable registration is not a mismatch; refusing loudly keeps a
  // blocked ancestor from looking like a stale capability.
  if (live?.state === "unreadable") throw new SourceRegistryError("SOURCE_UNREADABLE", "The registered source is unreadable, so the prepared claim is refused instead of guessed.");
  const rebound = live === null || live.sourceIdentity !== record.sourceIdentity || live.path !== record.fromPath || live.approvedDigest !== record.previousRawDigest;
  const drifted = record.kind === "source-review" && (live?.state !== "drift" || live.currentDigest !== record.reviewedRawDigest || live.path !== record.toPath);
  const moved = record.kind === "relink" && (live?.state !== "missing" || record.toPath === record.fromPath || record.reviewedRawDigest !== record.previousRawDigest);
  if (rebound || drifted || moved) return null;
  if (record.kind === "relink") {
    const candidate = await selectedSource(root, { ...entry!, source: { ...entry!.source, path: normalizeTemplateSourcePath(record.toPath) } }).catch(() => null);
    if (preparations.get(capability) !== record) return null;
    if (candidate?.path !== record.toPath || candidate.rawDigest !== record.reviewedRawDigest) return null;
  }
  if (preparations.get(capability) !== record) return null;
  preparations.delete(capability);
  return factsOf(record);
}
