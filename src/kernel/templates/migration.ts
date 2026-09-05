import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../conventions/note-exclude.js";
import { loadObsidianTypes } from "../contracts/index.js";
import { approvalDigest, canonicalJson, inputDigest, outputDigest } from "./canonical.js";
import { parseTemplate } from "./extract.js";
import { parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { composeResolvedTemplateFields, sourceSignature, taxonomyRouting } from "./resolver.js";
import { isTemplateSourceInFolder, normalizeTemplateSourcePath, validateTemplateId, verifyTemplateControlPath, normalizeTemplateControlPath, verifyTemplateFolderPath, verifyTemplateSourcePath } from "./paths.js";
import { executeTemplateTransaction } from "./transaction.js";
import type { AuthorityEntry, BaseContract, DerivedProjection, Digest, Extensions, FileExpectation, GuardedTemplateRequest, InputV2, JsonValue, TemplateBinding, TemplateCompositionManifest, TemplateFolderPath, TemplateFolderRegistration, TemplateId, TemplatePolicy, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export type MigrationDiagnosticCode = "MIGRATION_UNRESOLVED_MAPPING" | "TEMPLATE_ID_DUPLICATE" | "TEMPLATE_SOURCE_DUPLICATE" | "MIGRATION_TEMPLATE_UNSAFE" | "MIGRATION_TEMPLATE_INVALID" | "MIGRATION_NOTE_INVALID" | "MIGRATION_NOTE_IDENTITY_UNRESOLVED" | "MIGRATION_TAXONOMY_INVALID" | "TEMPLATE_FOLDER_SELECTION_REQUIRED" | "TEMPLATE_PLACEMENT_UNDECLARED" | "TEMPLATE_POLICY_VERSION_UNSUPPORTED";
export interface MigrationDiagnostic { readonly code: MigrationDiagnosticCode; readonly message: string; readonly path?: string; readonly templateId?: TemplateId; }
export interface RegisteredTemplate { readonly templateId: string; readonly sourcePath: string; }
export interface TemplateCandidate { readonly templateId: TemplateId; readonly sourceFolder: TemplateFolderPath; readonly sourcePath: TemplateSourcePath; readonly bytes: Uint8Array; readonly destinationClass: TemplateBinding["destinationClass"]; }
export interface ExistingNoteIdentity { readonly path: string; readonly templateId: string | null; }
export interface MigrationProposal {
  readonly templateFolders: readonly TemplateFolderRegistration[];
  readonly candidates: readonly TemplateCandidate[];
  readonly bindings: readonly TemplateBinding[];
  readonly existingNotes: readonly ExistingNoteIdentity[];
  readonly input?: InputV2;
  readonly inputDigest?: Digest;
  readonly managedSourcePaths: readonly TemplateSourcePath[];
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly unresolved: readonly MigrationDiagnostic[];
  readonly policyState: VerifiedFileState;
  readonly currentPolicy?: TemplatePolicy;
  /** Names explicitly replaced in the approval diff; never inferred legacy semantics. */
  readonly droppedKeys: readonly string[];
}
export interface MigrationOptions {
  readonly templateFolders?: readonly { readonly path: string; readonly mode: "auto" | "manual"; readonly default?: true }[];
  readonly registeredTemplates?: readonly RegisteredTemplate[];
}
export interface MigrationCompositionInput { readonly base: BaseContract; }
function sha(bytes: Uint8Array): Digest { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function issue(code: MigrationDiagnosticCode, message: string, path?: string, templateId?: TemplateId): MigrationDiagnostic { return { code, message, ...(path === undefined ? {} : { path }), ...(templateId === undefined ? {} : { templateId }) }; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function bytes(value: string): Uint8Array { return encoder.encode(value); }
function same(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((item, index) => item === right[index]); }
function expectation(value: VerifiedFileState): FileExpectation { return value.state === "absent" ? value : { state: "present", signature: value.signature }; }
function unchanged(left: VerifiedFileState, right: VerifiedFileState): boolean { return left.state === "absent" || right.state === "absent" ? left.state === right.state : left.signature === right.signature; }
async function fileState(vault: string, pathname: string): Promise<VerifiedFileState> {
  if (pathname.startsWith(".oms/")) await verifyTemplateControlPath(vault, normalizeTemplateControlPath(pathname), { expected: "either" });
  try { const content = new Uint8Array(await readFile(join(vault, pathname))); return { state: "present", bytes: content, signature: sha(content) }; }
  catch (error: unknown) { if (isMissing(error)) return { state: "absent" }; throw error; }
}
function opaqueObject(state: VerifiedFileState): Record<string, unknown> | null {
  if (state.state === "absent") return null;
  try { const value: unknown = JSON.parse(decoder.decode(state.bytes)); return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
const REPLACED_KEYS = new Set(["version", "templateFolder", "templateFolders", "defaultTemplate", "base", "contracts", "templates"]);
function droppedPolicyKeys(state: VerifiedFileState, policy: TemplatePolicy | undefined): readonly string[] {
  if (state.state === "absent" || policy !== undefined) return [];
  const raw = opaqueObject(state);
  return raw === null ? ["$document"] : Object.keys(raw).filter(key => REPLACED_KEYS.has(key)).sort();
}
function projectionExtensions(state: VerifiedFileState): Extensions | undefined {
  if (state.state === "absent") return undefined;
  const raw = opaqueObject(state);
  if (raw === null) throw new Error("PROJECTION_INVALID: existing projection must be a JSON object");
  const declared = raw.extensions;
  if (declared !== undefined && (declared === null || typeof declared !== "object" || Array.isArray(declared))) throw new Error("PROJECTION_INVALID: extensions must be an object");
  const preserved = { ...(declared as Record<string, JsonValue> | undefined) };
  for (const [key, value] of Object.entries(raw)) {
    if (["version", "generatedFrom", "managed", "extensions"].includes(key)) continue;
    if (Object.hasOwn(preserved, key) && canonicalJson(preserved[key]) !== canonicalJson(value)) throw new Error(`PROJECTION_INVALID: conflicting extension ${key}`);
    preserved[key] = value as JsonValue;
  }
  return Object.keys(preserved).length === 0 ? undefined : preserved;
}
async function readCandidate(root: string, pathname: string, templateId: string, folders: readonly TemplateFolderRegistration[], destinationClass: TemplateBinding["destinationClass"] = "registered-existing"): Promise<TemplateCandidate> {
  const sourcePath = normalizeTemplateSourcePath(pathname);
  const sourceFolder = [...folders].sort((a, b) => b.path.length - a.path.length).find(folder => isTemplateSourceInFolder(sourcePath, folder.path))?.path;
  if (sourceFolder === undefined) throw new Error("Template source is outside the selected registered folders");
  const verified = await verifyTemplateSourcePath(root, sourcePath);
  return { templateId: validateTemplateId(templateId), sourceFolder, sourcePath, bytes: new Uint8Array(await readFile(verified.absolutePath)), destinationClass };
}
async function discover(root: string, folders: readonly TemplateFolderRegistration[], diagnostics: MigrationDiagnostic[]): Promise<TemplateCandidate[]> {
  const candidates: TemplateCandidate[] = [];
  const visited = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return;
    visited.add(directory);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error: unknown) { if (!isMissing(error)) diagnostics.push(issue("MIGRATION_TEMPLATE_UNSAFE", message(error), relative(root, directory))); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const pathname = relative(root, absolute).replaceAll("\\", "/");
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) { diagnostics.push(issue("MIGRATION_TEMPLATE_UNSAFE", "Symlink template candidate is rejected", pathname)); continue; }
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try { candidates.push(await readCandidate(root, pathname, basename(pathname, ".md").normalize("NFC").toLowerCase(), folders)); }
      catch (error: unknown) { diagnostics.push(issue("MIGRATION_TEMPLATE_INVALID", message(error), pathname)); }
    }
  };
  for (const folder of folders) {
    try { await verifyTemplateFolderPath(root, folder.path); await visit(resolve(root, folder.path)); }
    catch (error: unknown) { diagnostics.push(issue("MIGRATION_TEMPLATE_UNSAFE", message(error), folder.path)); }
  }
  return candidates;
}
async function notes(root: string, sources: ReadonlySet<string>, diagnostics: MigrationDiagnostic[]): Promise<ExistingNoteIdentity[]> {
  const values: ExistingNoteIdentity[] = [];
  const excluded = await excludedNoteMatcher(root, false);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const pathname = relative(root, absolute).replaceAll("\\", "/");
      if (sources.has(pathname) || excluded(pathname)) continue;
      try {
        const parsed = parseNote(await readFile(absolute, "utf8"));
        if (parsed.diagnostics.length > 0) { diagnostics.push(issue("MIGRATION_NOTE_INVALID", "Existing note frontmatter is invalid", pathname)); continue; }
        values.push({ path: pathname, templateId: typeof parsed.frontmatter.template === "string" ? parsed.frontmatter.template : null });
      } catch (error: unknown) { diagnostics.push(issue("MIGRATION_NOTE_INVALID", message(error), pathname)); }
    }
  };
  await visit(root);
  return values.sort((a, b) => a.path.localeCompare(b.path));
}
function snapshotInput(folders: readonly TemplateFolderRegistration[], authority: readonly AuthorityEntry[], bindings: readonly TemplateBinding[]): InputV2 {
  return { version: 2, templateFolders: folders, authority, placement: bindings.map(binding => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, sourceFolder: binding.sourceFolder, templateFolder: binding.destinationClass === "managed-default" ? binding.sourceFolder : null, sourcePath: binding.sourcePath })) };
}
function authorities(states: readonly { readonly kind: AuthorityEntry["kind"]; readonly logicalId: string; readonly path: string; readonly state: VerifiedFileState }[], candidates: readonly TemplateCandidate[]): AuthorityEntry[] {
  return [...states.flatMap(({ kind, logicalId, path, state }) => state.state === "present" ? [{ kind, logicalId, vaultRelativePath: path, contentDigest: state.signature }] : []), ...candidates.map(candidate => ({ kind: "template" as const, logicalId: candidate.templateId, vaultRelativePath: candidate.sourcePath, contentDigest: sha(candidate.bytes) }))];
}
/** Read-only scan. Only explicit selections or an existing v3 registration select folders. */
export async function planTemplateMigration(vault: string, options: MigrationOptions = {}): Promise<MigrationProposal> {
  const root = resolve(vault);
  const policyState = await fileState(root, ".oms/template-policy.json");
  let currentPolicy: TemplatePolicy | undefined;
  if (policyState.state === "present") {
    try { currentPolicy = parseTemplatePolicy(decoder.decode(policyState.bytes)); }
    catch (error: unknown) { if (!message(error).startsWith("TEMPLATE_POLICY_VERSION_UNSUPPORTED")) throw error; }
  }
  const folders = options.templateFolders === undefined ? currentPolicy?.templateFolders ?? [] : parseTemplatePolicy(JSON.stringify({ version: 3, templateFolders: options.templateFolders, base: { fields: {} }, contracts: {}, templates: {} })).templateFolders;
  const diagnostics: MigrationDiagnostic[] = [];
  if (folders.length === 0) diagnostics.push(issue("TEMPLATE_FOLDER_SELECTION_REQUIRED", "Select template folders explicitly; configuration hints are proposals, not selections"));
  const candidates = await discover(root, folders, diagnostics);
  const explicitlyRegistered = new Set<string>();
  const registeredPaths = new Set<string>();
  for (const registration of options.registeredTemplates ?? []) {
    try {
      const candidate = await readCandidate(root, registration.sourcePath, registration.templateId, folders);
      if (registeredPaths.has(candidate.sourcePath)) {
        diagnostics.push(issue("TEMPLATE_SOURCE_DUPLICATE", "Source is explicitly registered more than once", candidate.sourcePath, candidate.templateId));
        continue;
      }
      registeredPaths.add(candidate.sourcePath);
      for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
        if (diagnostics[index]!.code === "MIGRATION_TEMPLATE_INVALID" && diagnostics[index]!.path === candidate.sourcePath) diagnostics.splice(index, 1);
      }
      const at = candidates.findIndex(item => item.sourcePath === candidate.sourcePath);
      if (at >= 0) candidates.splice(at, 1);
      candidates.push(candidate);
      explicitlyRegistered.add(candidate.templateId);
    } catch (error: unknown) { diagnostics.push(issue("MIGRATION_TEMPLATE_INVALID", message(error), registration.sourcePath)); }
  }
  for (const binding of Object.values(currentPolicy?.templates ?? {})) {
    try {
      const candidate = await readCandidate(root, binding.sourcePath, binding.templateId, folders, binding.destinationClass);
      const at = candidates.findIndex(item => item.sourcePath === candidate.sourcePath);
      if (at >= 0) candidates.splice(at, 1);
      candidates.push(candidate);
    } catch (error: unknown) { diagnostics.push(issue("MIGRATION_UNRESOLVED_MAPPING", message(error), binding.sourcePath, binding.templateId)); }
  }
  candidates.sort((a, b) => a.templateId.localeCompare(b.templateId) || a.sourcePath.localeCompare(b.sourcePath));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.templateId)) diagnostics.push(issue("TEMPLATE_ID_DUPLICATE", "Stable templateId is duplicated", candidate.sourcePath, candidate.templateId));
    if (paths.has(candidate.sourcePath)) diagnostics.push(issue("TEMPLATE_SOURCE_DUPLICATE", "Template sourcePath is duplicated", candidate.sourcePath, candidate.templateId));
    ids.add(candidate.templateId); paths.add(candidate.sourcePath);
  }
  const bindings = candidates.filter(candidate => currentPolicy?.templates[candidate.templateId] !== undefined || explicitlyRegistered.has(candidate.templateId) || folders.find(folder => folder.path === candidate.sourceFolder)?.mode === "auto").map((candidate): TemplateBinding => currentPolicy?.templates[candidate.templateId] ?? ({ templateId: candidate.templateId, sourceFolder: candidate.sourceFolder, sourcePath: candidate.sourcePath, destinationClass: candidate.destinationClass, contract: "base", naming: "{{date}}-{{slug}}.md" }));
  const managedSourcePaths = [...paths].sort() as TemplateSourcePath[];
  const existingNotes = await notes(root, new Set(managedSourcePaths), diagnostics);
  const droppedKeys = droppedPolicyKeys(policyState, currentPolicy);
  const common = { templateFolders: folders, candidates, bindings, existingNotes, managedSourcePaths, policyState, ...(currentPolicy === undefined ? {} : { currentPolicy }), droppedKeys, diagnostics, unresolved: diagnostics };
  if (diagnostics.length > 0) return common;
  const [taxonomy, obsidian] = await Promise.all([fileState(root, ".oms/taxonomy.json"), fileState(root, ".obsidian/types.json")]);
  const input = snapshotInput(folders, authorities([{ kind: "policy", logicalId: "template-policy", path: ".oms/template-policy.json", state: policyState }, { kind: "taxonomy", logicalId: "taxonomy", path: ".oms/taxonomy.json", state: taxonomy }, { kind: "obsidian-types", logicalId: "obsidian-types", path: ".obsidian/types.json", state: obsidian }], candidates), bindings);
  return { ...common, input, inputDigest: inputDigest(input) };
}
function proposedPolicy(proposal: MigrationProposal, base: BaseContract): TemplatePolicy {
  if (proposal.currentPolicy !== undefined) {
    const current = proposal.currentPolicy;
    const contracts = proposal.bindings.some(binding => binding.contract === "base") && current.contracts.base === undefined ? { ...current.contracts, base: { ...base, intent: "Template convention", views: [] } } : current.contracts;
    return parseTemplatePolicy(serializeTemplatePolicy({ ...current, templateFolders: proposal.templateFolders, contracts, templates: Object.fromEntries(proposal.bindings.map(binding => [binding.templateId, binding])) }));
  }
  const raw = opaqueObject(proposal.policyState);
  const preserved = raw === null ? {} : Object.fromEntries(Object.entries(raw).filter(([key]) => !REPLACED_KEYS.has(key)));
  return parseTemplatePolicy(JSON.stringify({ ...preserved, version: 3, templateFolders: proposal.templateFolders, base, contracts: { base: { ...base, intent: "Template convention", views: [] } }, templates: Object.fromEntries(proposal.bindings.map(binding => [binding.templateId, binding])) }));
}
/** Compose against observed bytes; unsupported policy is retained as an opaque CAS input. */
export async function buildMigrationManifest(vault: string, proposal: MigrationProposal, input: MigrationCompositionInput): Promise<TemplateCompositionManifest> {
  if (proposal.unresolved.length > 0 || proposal.inputDigest === undefined) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  if (proposal.bindings.length === 0) throw new Error("MIGRATION_UNRESOLVED_MAPPING: select templates before approving a convention");
  const root = resolve(vault);
  const [policyState, taxonomyState, projectionState, obsidianState] = await Promise.all([fileState(root, ".oms/template-policy.json"), fileState(root, ".oms/taxonomy.json"), fileState(root, ".oms/types.json"), fileState(root, ".obsidian/types.json")]);
  if (!unchanged(policyState, proposal.policyState)) throw new Error("MIGRATION_APPROVAL_MISMATCH: policy changed after inspection");
  if (obsidianState.state !== "present") throw new Error("MIGRATION_AUTHORITY_MISSING: .obsidian/types.json");
  const obsidian = await loadObsidianTypes(root);
  if (obsidian === null) throw new Error("MIGRATION_AUTHORITY_MISSING: .obsidian/types.json");
  const policy = proposedPolicy(proposal, input.base);
  const policyBytes = bytes(serializeTemplatePolicy(policy));
  const taxonomyBytes = taxonomyState.state === "present" ? taxonomyState.bytes : bytes(`${JSON.stringify({ folders: {} })}\n`);
  const taxonomy = taxonomyRouting(".oms/taxonomy.json", taxonomyBytes);
  const bindings = Object.values(policy.templates).sort((a, b) => a.templateId.localeCompare(b.templateId));
  const candidateById = new Map(proposal.candidates.map(candidate => [candidate.templateId, candidate]));
  const extracted = bindings.map(binding => {
    const candidate = candidateById.get(binding.templateId);
    if (candidate === undefined || candidate.sourcePath !== binding.sourcePath) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: ${binding.templateId}`);
    return parseTemplate(binding.sourcePath, candidate.bytes);
  });
  const descriptors = [{ logicalId: "template-policy", signature: sha(policyBytes) }, { logicalId: "taxonomy", signature: sha(taxonomyBytes) }, { logicalId: "obsidian-types", signature: obsidianState.signature }, ...extracted.map(template => ({ path: template.sourcePath, signature: template.sourceDigest }))];
  const resolvedSignature = sourceSignature(descriptors);
  const extensions = projectionExtensions(projectionState);
  const derived: DerivedProjection = {
    version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: resolvedSignature, sources: descriptors },
    ...(extensions === undefined ? {} : { extensions }),
    managed: { base: policy.base, globalAxes: taxonomy.globalAxes, templates: Object.fromEntries(bindings.map((binding, index) => {
      const targetFolder = taxonomy.targetFolders.get(binding.templateId);
      if (targetFolder === undefined) throw new Error(`TEMPLATE_PLACEMENT_UNDECLARED: ${binding.templateId}`);
      const template = extracted[index]!;
      const contract = policy.contracts[binding.contract];
      if (contract === undefined) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: ${binding.contract}`);
      return [binding.templateId, { templateId: binding.templateId, destinationClass: binding.destinationClass, sourcePath: binding.sourcePath, targetFolder, keyOrder: template.keyOrder, fields: composeResolvedTemplateFields(policy.base, contract.fields, template.frontmatter, obsidian.types), views: contract.views, naming: binding.naming, bodySignature: sha(bytes(template.body)) }];
    })) },
  };
  const projectionBytes = bytes(serializeDerivedProjection(derived));
  const sources: TemplateCompositionManifest["sources"] = await Promise.all(bindings.map(async binding => {
    const candidate = candidateById.get(binding.templateId)!;
    const verified = await verifyTemplateSourcePath(root, binding.sourcePath);
    const content = new Uint8Array(await readFile(verified.absolutePath));
    if (!same(content, candidate.bytes)) throw new Error(`MIGRATION_APPROVAL_MISMATCH: ${binding.sourcePath}`);
    const current = { state: "present" as const, bytes: content, signature: sha(content) };
    return { templateId: binding.templateId, path: binding.sourcePath, expectedCurrent: expectation(current), current, proposed: current, action: "verify-only" as const };
  }));
  const controlInputs = [{ kind: "policy" as const, logicalId: "template-policy", path: ".oms/template-policy.json", state: policyState }, { kind: "taxonomy" as const, logicalId: "taxonomy", path: ".oms/taxonomy.json", state: taxonomyState }, { kind: "obsidian-types" as const, logicalId: "obsidian-types", path: ".obsidian/types.json", state: obsidianState }];
  const currentBindings = Object.values(proposal.currentPolicy?.templates ?? {});
  const currentCandidates = proposal.candidates.filter(candidate => currentBindings.some(binding => binding.templateId === candidate.templateId));
  const currentInput = snapshotInput(proposal.currentPolicy?.templateFolders ?? [], authorities(controlInputs, currentCandidates), currentBindings);
  const proposedInput = snapshotInput(policy.templateFolders, authorities([{ ...controlInputs[0]!, state: { state: "present", bytes: policyBytes, signature: sha(policyBytes) } }, { ...controlInputs[1]!, state: { state: "present", bytes: taxonomyBytes, signature: sha(taxonomyBytes) } }, controlInputs[2]!], proposal.candidates.filter(candidate => bindings.some(binding => binding.templateId === candidate.templateId))), bindings);
  const current = { input: currentInput, inputDigest: inputDigest(currentInput), bindings: currentBindings, resolvedTemplates: currentCandidates.map(candidate => ({ templateId: candidate.templateId, sourcePath: candidate.sourcePath, inputSignature: inputDigest(currentInput), templateSignature: sha(candidate.bytes) })) };
  const proposed = { input: proposedInput, inputDigest: inputDigest(proposedInput), bindings, resolvedTemplates: extracted.map((template, index) => ({ templateId: bindings[index]!.templateId, sourcePath: template.sourcePath, inputSignature: resolvedSignature, templateSignature: template.sourceDigest })) };
  const control = <K extends "policy" | "taxonomy" | "projection", P extends ".oms/template-policy.json" | ".oms/taxonomy.json" | ".oms/types.json">(kind: K, path: P, current: VerifiedFileState, content: Uint8Array) => ({ kind, path, expectedCurrent: expectation(current), current, proposed: { state: "present" as const, bytes: content, signature: sha(content) }, action: current.state === "present" && same(current.bytes, content) ? "verify-only" as const : "write" as const });
  const controls: TemplateCompositionManifest["controls"] = [control("policy", ".oms/template-policy.json", policyState, policyBytes), control("taxonomy", ".oms/taxonomy.json", taxonomyState, taxonomyBytes), control("projection", ".oms/types.json", projectionState, projectionBytes)];
  const mode = policyState.state === "absent" ? "create" as const : "update" as const;
  const operations = bindings.map(binding => ({ kind: mode, templateId: binding.templateId, destinationClass: binding.destinationClass, payloadDigest: sha(candidateById.get(binding.templateId)!.bytes), stableRelativeSuffix: null }));
  const outputs = [...controls.map(item => ({ finalVaultRelativePath: item.path, payloadDigest: item.proposed.signature })), ...sources.map(item => {
    if (item.proposed.state !== "present") throw new Error("MIGRATION_UNRESOLVED_MAPPING: selected source is absent");
    return { finalVaultRelativePath: item.path, payloadDigest: item.proposed.signature };
  })];
  return { version: 1, mode, current, proposed, controls, sources, operations, diagnostics: [], moves: [], outputs, approvalDigest: approvalDigest(proposed.inputDigest, operations, [], { current, controls, sources }), outputDigest: outputDigest(outputs) };
}
export async function applyTemplateMigration(vault: string, proposal: MigrationProposal, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest): Promise<TemplateTransactionReceipt> {
  if (proposal.unresolved.length > 0 || proposal.inputDigest === undefined) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  if (manifest === null || typeof manifest !== "object" || !Array.isArray(manifest.controls) || manifest.controls.length !== 3 || manifest.current === undefined || manifest.proposed === undefined || !Array.isArray(manifest.sources) || !Array.isArray(manifest.operations) || !Array.isArray(manifest.outputs) || !Array.isArray(manifest.moves)) throw new Error("MIGRATION_APPROVAL_MISMATCH");
  if (request === null || typeof request !== "object" || (request.dryRun === true ? request.approvedDigest !== undefined : typeof request.approvedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(request.approvedDigest))) throw new Error("MIGRATION_APPROVAL_MISMATCH");
  return executeTemplateTransaction(vault, manifest, request);
}
export function migrationProposalDigest(proposal: MigrationProposal): Digest {
  if (proposal.inputDigest === undefined) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  return sha(bytes(JSON.stringify({ inputDigest: proposal.inputDigest, managedSourcePaths: proposal.managedSourcePaths, droppedKeys: proposal.droppedKeys })));
}
