import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import { excludedNoteMatcher } from "../conventions/note-exclude.js";

import { approvalDigest, inputDigest, outputDigest } from "./canonical.js";
import { parseTemplate } from "./extract.js";
import { parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { deriveFolderOntologyAxis, sourceSignature } from "./resolver.js";
import { loadObsidianTypes } from "../contracts/index.js";
import { deriveManagedSourcePath, normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId, verifyTemplateFolderPath, verifyTemplateSourcePath } from "./paths.js";
import { executeTemplateTransaction } from "./transaction.js";
import { composeResolvedTemplateFields } from "./resolver.js";
import type { AuthorityEntry, BaseContract, ContractDefinition, DerivedProjection, DestinationClass, Digest, FieldPolicy, FileExpectation, GlobalAxes, GlobalAxis, GuardedTemplateRequest, InputV2, JsonValue, ObsidianContractType, RetrievalView, TemplateBinding, TemplateCompositionManifest, TemplateFolderPath, TemplateId, TemplatePolicy, TemplateSourcePath, TemplateTransactionReceipt, VerifiedFileState } from "./types.js";

const encoder = new TextEncoder();

type LegacySource = ".oms/types.json" | ".oms/concepts" | ".oms/taxonomy.yaml";
export type MigrationDiagnosticCode = "MIGRATION_UNRESOLVED_MAPPING" | "TEMPLATE_ID_DUPLICATE" | "TEMPLATE_SOURCE_DUPLICATE" | "MIGRATION_TEMPLATE_UNSAFE" | "MIGRATION_TEMPLATE_INVALID" | "MIGRATION_NOTE_INVALID" | "MIGRATION_NOTE_IDENTITY_UNRESOLVED" | "MIGRATION_TAXONOMY_INVALID";
export interface MigrationDiagnostic { readonly code: MigrationDiagnosticCode; readonly message: string; readonly path?: string; readonly templateId?: TemplateId; }
export interface RegisteredTemplate { readonly templateId: string; readonly sourcePath: string; }
export interface TemplateCandidate { readonly templateId: TemplateId; readonly sourcePath: TemplateSourcePath; readonly bytes: Uint8Array; readonly destinationClass: DestinationClass; }
export interface LegacyLedgerEntry { readonly source: LegacySource; readonly path: string; readonly bytes: Uint8Array; }
export interface ExistingNoteIdentity { readonly path: string; readonly templateId: string | null; readonly legacyConcept: string | null; }
export interface StableBindingClone { readonly folder: string; readonly legacyConcept: string; readonly templateId: TemplateId; readonly sourcePath: TemplateSourcePath; }
export interface MigrationProposal {
  readonly templateFolder: TemplateFolderPath;
  readonly candidates: readonly TemplateCandidate[];
  readonly bindings: readonly TemplateBinding[];
  readonly bindingClones: readonly StableBindingClone[];
  readonly existingNotes: readonly ExistingNoteIdentity[];
  readonly input?: InputV2;
  /** Absent when preflight diagnostics block approval-capable migration. */
  readonly inputDigest?: Digest;
  readonly managedSourcePaths: readonly TemplateSourcePath[];
  readonly legacyLedger: readonly LegacyLedgerEntry[];
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly unresolved: readonly MigrationDiagnostic[];
}
export interface MigrationOptions { readonly templateFolder?: string; readonly registeredTemplates?: readonly RegisteredTemplate[]; }

function sha(bytes: Uint8Array): Digest { return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest; }
function issue(code: MigrationDiagnosticCode, message: string, path?: string, templateId?: TemplateId): MigrationDiagnostic { return { code, message, ...(path === undefined ? {} : { path }), ...(templateId === undefined ? {} : { templateId }) }; }
function stableId(value: string): TemplateId | null {
  try { return validateTemplateId(value.normalize("NFC").toLowerCase()); }
  catch { return null; }
}
function inferredId(path: string): TemplateId | null { return stableId(basename(path, ".md")); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

async function readRegular(root: string, source: string): Promise<{ readonly path: TemplateSourcePath; readonly bytes: Uint8Array } | MigrationDiagnostic> {
  let path: TemplateSourcePath;
  try { path = normalizeTemplateSourcePath(source); }
  catch { return issue("MIGRATION_TEMPLATE_INVALID", "Template sourcePath is invalid", source); }
  try {
    const verified = await verifyTemplateSourcePath(root, path);
    return { path, bytes: new Uint8Array(await readFile(verified.absolutePath)) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return issue(
      message.includes("must exist")
        ? "MIGRATION_UNRESOLVED_MAPPING"
        : "MIGRATION_TEMPLATE_UNSAFE",
      message,
      path,
    );
  }
}

async function discover(root: string, folder: TemplateFolderPath): Promise<{ readonly candidates: TemplateCandidate[]; readonly diagnostics: MigrationDiagnostic[] }> {
  const start = resolve(root, folder);
  const diagnostics: MigrationDiagnostic[] = [];
  const candidates: TemplateCandidate[] = [];
  try {
    await verifyTemplateFolderPath(root, folder);
  } catch (error: unknown) {
    return { candidates, diagnostics: [issue("MIGRATION_TEMPLATE_UNSAFE", error instanceof Error ? error.message : String(error), folder)] };
  }
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error: unknown) { if (isMissing(error)) return; throw error; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const vaultPath = relative(root, absolute).replaceAll("\\", "/");
      const stat = await lstat(absolute);
      if (entry.name.startsWith(".") || stat.isSymbolicLink()) { diagnostics.push(issue("MIGRATION_TEMPLATE_UNSAFE", "Hidden or symlink template candidate is rejected", vaultPath)); continue; }
      if (stat.isDirectory()) { await visit(absolute); continue; }
      if (!stat.isFile() || !entry.name.endsWith(".md")) continue;
      const id = inferredId(vaultPath);
      if (id === null) { diagnostics.push(issue("MIGRATION_UNRESOLVED_MAPPING", "Template candidate needs an explicit stable ID", vaultPath)); continue; }
      const read = await readRegular(root, vaultPath);
      if ("code" in read) { diagnostics.push(read); continue; }
      candidates.push({ templateId: id, sourcePath: read.path, bytes: read.bytes, destinationClass: "registered-existing" });
    }
  };
  await visit(start);
  return { candidates, diagnostics };
}

async function ledger(root: string): Promise<LegacyLedgerEntry[]> {
  const result: LegacyLedgerEntry[] = [];
  const fixed: readonly [LegacySource, string][] = [[".oms/types.json", ".oms/types.json"], [".oms/taxonomy.yaml", ".oms/taxonomy.yaml"]];
  for (const [source, path] of fixed) {
    try { result.push({ source, path, bytes: new Uint8Array(await readFile(join(root, path))) }); }
    catch (error: unknown) { if (!isMissing(error)) throw error; }
  }
  try {
    for (const entry of await readdir(join(root, ".oms", "concepts"), { withFileTypes: true })) {
      if (!entry.isFile() || (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))) continue;
      const path = `.oms/concepts/${entry.name}`;
      result.push({ source: ".oms/concepts", path, bytes: new Uint8Array(await readFile(join(root, path))) });
    }
  } catch (error: unknown) { if (!isMissing(error)) throw error; }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function mapping(value: unknown): ReadonlyMap<string, unknown> | null {
  if (value instanceof Map) return value as ReadonlyMap<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return new Map(Object.entries(value as Record<string, unknown>));
}

function conceptsFromTaxonomy(entries: readonly LegacyLedgerEntry[], diagnostics: MigrationDiagnostic[]): readonly { readonly folder: string; readonly concept: string }[] {
  const entry = entries.find(value => value.source === ".oms/taxonomy.yaml");
  if (entry === undefined) return [];
  const document = parseDocument(new TextDecoder().decode(entry.bytes), { prettyErrors: false });
  const root = mapping(document.toJS({ mapAsMap: true }));
  if (document.errors.length > 0 || root === null) { diagnostics.push(issue("MIGRATION_TAXONOMY_INVALID", "Legacy taxonomy is not a mapping", entry.path)); return []; }
  const folders = mapping(root.get("folders"));
  if (folders === null) return [];
  const values: { folder: string; concept: string }[] = [];
  for (const [folder, raw] of folders) {
    const binding = mapping(raw);
    if (binding === null) continue;
    const concept = binding.get("concept");
    const names = Array.isArray(concept) ? concept : [concept];
    for (const name of names) if (typeof name === "string" && name.trim() !== "") values.push({ folder, concept: name.trim() });
  }
  return values.sort((left, right) => left.concept.localeCompare(right.concept) || left.folder.localeCompare(right.folder));
}

async function notes(root: string, sources: ReadonlySet<string>, diagnostics: MigrationDiagnostic[]): Promise<ExistingNoteIdentity[]> {
  const values: ExistingNoteIdentity[] = [];
  const isExcluded = await excludedNoteMatcher(root, false);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (sources.has(path) || isExcluded(path)) continue;
      const content = await readFile(absolute, "utf8");
      const parsed = parseNote(content);
      if (parsed.diagnostics.length > 0) {
        diagnostics.push(issue("MIGRATION_NOTE_INVALID", "Existing note frontmatter is invalid", path));
        continue;
      }
      const fields = parsed.frontmatter;
      values.push({ path, templateId: typeof fields.template === "string" ? fields.template : null, legacyConcept: typeof fields.concept === "string" ? fields.concept : null });
    }
  };
  await visit(root);
  return values.sort((left, right) => left.path.localeCompare(right.path));
}

/** Read-only migration preflight. It preserves every legacy byte as a ledger entry and performs no publication. */
export async function planTemplateMigration(vault: string, options: MigrationOptions = {}): Promise<MigrationProposal> {
  const root = resolve(vault);
  const templateFolder = normalizeTemplateFolderPath(options.templateFolder ?? "Templates");
  const discovered = await discover(root, templateFolder);
  const diagnostics = [...discovered.diagnostics];
  const candidates = [...discovered.candidates];
  for (const registration of options.registeredTemplates ?? []) {
    const id = stableId(registration.templateId);
    if (id === null) { diagnostics.push(issue("MIGRATION_UNRESOLVED_MAPPING", "Registered template requires a stable templateId", registration.sourcePath)); continue; }
    const read = await readRegular(root, registration.sourcePath);
    if ("code" in read) { diagnostics.push(read); continue; }
    candidates.push({ templateId: id, sourcePath: read.path, bytes: read.bytes, destinationClass: "registered-existing" });
  }
  candidates.sort((left, right) => left.templateId.localeCompare(right.templateId) || left.sourcePath.localeCompare(right.sourcePath));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.templateId)) diagnostics.push(issue("TEMPLATE_ID_DUPLICATE", "Stable templateId is duplicated", candidate.sourcePath, candidate.templateId));
    if (paths.has(candidate.sourcePath)) diagnostics.push(issue("TEMPLATE_SOURCE_DUPLICATE", "Template sourcePath is duplicated", candidate.sourcePath, candidate.templateId));
    ids.add(candidate.templateId); paths.add(candidate.sourcePath);
  }
  const legacyLedger = await ledger(root);
  const taxonomyBindings = conceptsFromTaxonomy(legacyLedger, diagnostics);
  const byConcept = new Map<string, TemplateCandidate>();
  for (const candidate of candidates) byConcept.set(candidate.templateId, candidate);
  const counts = new Map<string, number>();
  for (const value of taxonomyBindings) counts.set(value.concept, (counts.get(value.concept) ?? 0) + 1);
  const bindingClones: StableBindingClone[] = [];
  const cloneIds = new Set<TemplateId>();
  for (const value of taxonomyBindings) {
    const candidate = byConcept.get(value.concept);
    if (candidate === undefined) { diagnostics.push(issue("MIGRATION_UNRESOLVED_MAPPING", "Legacy taxonomy concept has no mapped template", `.oms/taxonomy.yaml`)); continue; }
    if ((counts.get(value.concept) ?? 0) <= 1) continue;
    const suffix = `--${value.folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const id = stableId(`${candidate.templateId}${suffix}`);
    if (id === null) { diagnostics.push(issue("MIGRATION_UNRESOLVED_MAPPING", "Legacy folder cannot form a stable template binding", `.oms/taxonomy.yaml`)); continue; }
    if (ids.has(id) || cloneIds.has(id)) {
      diagnostics.push(issue("TEMPLATE_ID_DUPLICATE", "Legacy folders produce the same stable clone ID", ".oms/taxonomy.yaml", id));
      continue;
    }
    cloneIds.add(id);
    bindingClones.push({
      folder: value.folder,
      legacyConcept: value.concept,
      templateId: id,
      sourcePath: deriveManagedSourcePath(templateFolder, id),
    });
  }
  const clonedConcepts = new Set(
    [...counts].filter(([, count]) => count > 1).map(([concept]) => concept),
  );
  const originalCandidates = [...candidates];
  const cloneCandidates = bindingClones.map((clone): TemplateCandidate => {
    const original = byConcept.get(clone.legacyConcept);
    if (original === undefined) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: ${clone.legacyConcept}`);
    return {
      templateId: clone.templateId,
      sourcePath: clone.sourcePath,
      bytes: original.bytes,
      destinationClass: "managed-default",
    };
  });
  candidates.splice(
    0,
    candidates.length,
    ...originalCandidates.filter((candidate) => !clonedConcepts.has(candidate.templateId)),
    ...cloneCandidates,
  );
  candidates.sort((left, right) => left.templateId.localeCompare(right.templateId));
  const managedSourcePaths = [...new Set([
    ...originalCandidates.map(candidate => candidate.sourcePath),
    ...candidates.map(candidate => candidate.sourcePath),
  ])].sort();
  const effectiveIds = new Set(candidates.map(candidate => candidate.templateId));
  const existingNotes = await notes(root, new Set(managedSourcePaths), diagnostics);
  const managedFolders = new Set(taxonomyBindings.map(binding => binding.folder.replace(/\/+$/g, "")));
  for (const note of existingNotes) {
    const stableNoteId = note.templateId === null ? null : stableId(note.templateId);
    if (note.templateId !== null && (stableNoteId === null || !effectiveIds.has(stableNoteId))) diagnostics.push(issue("MIGRATION_NOTE_IDENTITY_UNRESOLVED", "Existing note template identity has no candidate", note.path));
    if (note.templateId === null && note.legacyConcept !== null) {
      diagnostics.push(issue(
        "MIGRATION_NOTE_IDENTITY_UNRESOLVED",
        byConcept.has(note.legacyConcept)
          ? "Existing note still needs a persisted stable template identity"
          : "Existing note legacy concept has no mapped template",
        note.path,
      ));
    }
    if (
      note.templateId === null &&
      note.legacyConcept === null &&
      [...managedFolders].some(folder => note.path === folder || note.path.startsWith(`${folder}/`))
    ) diagnostics.push(issue("MIGRATION_NOTE_IDENTITY_UNRESOLVED", "Managed-folder note has no persisted template identity", note.path));
  }
  const authority: AuthorityEntry[] = [
    ...candidates.map(candidate => ({ kind: "template" as const, logicalId: candidate.templateId, vaultRelativePath: candidate.sourcePath, contentDigest: sha(candidate.bytes) })),
    ...legacyLedger.map(entry => ({ kind: entry.source === ".oms/concepts" ? "legacy-concept" as const : entry.source === ".oms/types.json" ? "legacy-contract" as const : "taxonomy" as const, logicalId: entry.path, vaultRelativePath: entry.path, contentDigest: sha(entry.bytes) })),
  ];
  const conceptIds = new Set(legacyLedger
    .filter((entry): entry is LegacyLedgerEntry & { readonly source: ".oms/concepts" } => entry.source === ".oms/concepts")
    .flatMap(entry => {
      const document = parseDocument(new TextDecoder().decode(entry.bytes), { prettyErrors: false });
      const source = document.toJS() as unknown;
      return document.errors.length === 0 && typeof source === "object" && source !== null && !Array.isArray(source) && typeof (source as Record<string, unknown>).concept === "string"
        ? [(source as Record<string, unknown>).concept as string]
        : [];
    }));
  const cloneContracts = new Map(bindingClones.map(clone => [clone.templateId, clone.legacyConcept]));
  const bindings = candidates.map(candidate => ({
    templateId: candidate.templateId,
    destinationClass: candidate.destinationClass,
    sourcePath: candidate.sourcePath,
    contract: cloneContracts.get(candidate.templateId) ?? (conceptIds.has(candidate.templateId) ? candidate.templateId : "base"),
    naming: "{{date}}-{{slug}}.md",
  }));
  const unresolved = [...diagnostics];
  const common = { templateFolder, candidates, bindings, bindingClones: bindingClones.sort((left, right) => left.templateId.localeCompare(right.templateId)), existingNotes, managedSourcePaths, legacyLedger, diagnostics, unresolved };
  if (unresolved.length > 0) return common;
  const input: InputV2 = { version: 2, authority, placement: candidates.map(candidate => ({ templateId: candidate.templateId, destinationClass: candidate.destinationClass, templateFolder: null, sourcePath: candidate.sourcePath })) };
  return { ...common, input, inputDigest: inputDigest(input) };
}

/** The only activation path: preflight admission, then the existing guarded publisher. */
function manifestInputDigest(manifest: TemplateCompositionManifest): Digest | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const proposed = (manifest as { readonly proposed?: unknown }).proposed;
  if (typeof proposed !== "object" || proposed === null) return null;
  const value = (proposed as { readonly inputDigest?: unknown }).inputDigest;
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value as Digest : null;
}

function guardedRequest(request: GuardedTemplateRequest): request is GuardedTemplateRequest {
  if (typeof request !== "object" || request === null) return false;
  const value = request as { readonly dryRun?: unknown; readonly approvedDigest?: unknown };
  if (value.dryRun === true) return value.approvedDigest === undefined;
  return typeof value.approvedDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(value.approvedDigest);
}

export async function applyTemplateMigration(vault: string, proposal: MigrationProposal, manifest: TemplateCompositionManifest, request: GuardedTemplateRequest): Promise<TemplateTransactionReceipt> {
  if (proposal.unresolved.length > 0 || proposal.inputDigest === undefined) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  if (!guardedRequest(request)) throw new Error("MIGRATION_APPROVAL_MISMATCH");
  if (
    manifestInputDigest(manifest) === null
    || !Array.isArray(manifest.controls)
    || manifest.controls.length !== 3
    || !Array.isArray(manifest.sources)
    || !Array.isArray(manifest.operations)
    || !Array.isArray(manifest.outputs)
    || !Array.isArray(manifest.moves)
    || typeof manifest.approvalDigest !== "string"
    || typeof manifest.outputDigest !== "string"
  ) throw new Error("MIGRATION_APPROVAL_MISMATCH");
  const receipt = await executeTemplateTransaction(vault, manifest, request);
  if (request.dryRun !== true && (receipt.status === "applied" || receipt.status === "already-complete")) {
    await rm(join(vault, ".oms", "taxonomy.yaml"), { force: true });
  }
  return receipt;
}

export function migrationProposalDigest(proposal: MigrationProposal): Digest {
  if (proposal.inputDigest === undefined) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  return sha(encoder.encode(JSON.stringify({ inputDigest: proposal.inputDigest, managedSourcePaths: proposal.managedSourcePaths, ledger: proposal.legacyLedger.map(entry => [entry.path, sha(entry.bytes)]) })));
}


export interface MigrationCompositionInput {
  readonly base: BaseContract;
}

async function fileState(vault: string, path: string): Promise<VerifiedFileState> {
  try {
    const bytes = new Uint8Array(await readFile(join(vault, path)));
    return { state: "present", bytes, signature: sha(bytes) };
  } catch (error: unknown) {
    if (isMissing(error)) return { state: "absent" };
    throw error;
  }
}
function expectation(value: VerifiedFileState): FileExpectation {
  return value.state === "absent" ? value : { state: "present", signature: value.signature };
}
function present(value: VerifiedFileState, path: string): Extract<VerifiedFileState, { readonly state: "present" }> {
  if (value.state === "absent") throw new Error(`MIGRATION_CONTROL_MISSING: ${path}`);
  return value;
}
function bytes(value: string): Uint8Array { return encoder.encode(value); }
function same(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((item, index) => item === right[index]); }
function preservedMembers(
  value: Readonly<Record<string, unknown>>,
  reserved: ReadonlySet<string>,
): Readonly<Record<string, JsonValue>> | undefined {
  const members = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !reserved.has(key))
      .map(([key, member]) => [key, asJson(member)]),
  );
  return Object.keys(members).length === 0 ? undefined : members;
}
function conceptsFor(proposal: MigrationProposal, base: BaseContract): Readonly<Record<string, ContractDefinition>> {
  const contracts: Record<string, ContractDefinition> = { base: { ...base, intent: "Template convention", views: [] } };
  for (const entry of proposal.legacyLedger.filter((item): item is LegacyLedgerEntry & { readonly source: ".oms/concepts" } => item.source === ".oms/concepts")) {
    const document = parseDocument(new TextDecoder().decode(entry.bytes), { prettyErrors: false });
    const source = document.toJS() as unknown;
    if (document.errors.length > 0 || typeof source !== "object" || source === null || Array.isArray(source)) throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
    const concept = source as Record<string, unknown>;
    if (
      typeof concept.concept !== "string" ||
      !proposal.bindings.some(binding => binding.contract === concept.concept)
    ) continue;
    if (typeof concept.intent !== "string" || !Array.isArray(concept.fields)) throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
    const fields: Record<string, FieldPolicy> = {};
    for (const fieldSource of concept.fields) {
      if (typeof fieldSource !== "object" || fieldSource === null || Array.isArray(fieldSource)) throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
      const field = fieldSource as Record<string, unknown>;
      if (typeof field.name !== "string" || typeof field.type !== "string") throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
      const type = field.type === "url" ? "text" : field.type;
      const enumValues = Array.isArray(field.allowedValues) ? field.allowedValues : Array.isArray(field.enum) ? field.enum : undefined;
      fields[field.name] = {
        type: type as ObsidianContractType,
        ...(typeof field.required === "boolean" ? { required: field.required } : {}),
        ...(typeof field.intent === "string" ? { intent: field.intent } : {}),
        ...(field.normalize === "lower" || field.normalize === "trim" || field.normalize === "kebab" ? { normalize: field.normalize } : {}),
        ...(field.type === "url" ? { format: "url" as const } : {}),
        ...(enumValues !== undefined && enumValues.every((value: unknown) => typeof value === "string")
          ? { allowedValues: enumValues as readonly string[] }
          : {}),
        ...(typeof field.immutable === "boolean" ? { immutable: field.immutable } : {}),
        ...(preservedMembers(field, new Set(["name", "type", "required", "intent", "normalize", "allowedValues", "enum", "immutable"])) === undefined
          ? {}
          : { extensions: preservedMembers(field, new Set(["name", "type", "required", "intent", "normalize", "allowedValues", "enum", "immutable"])) }),
      };
    }
    const views: RetrievalView[] = [];
    const lenses = Array.isArray(concept.views) ? concept.views : Array.isArray(concept.lenses) ? concept.lenses : [];
    for (const lensSource of lenses) {
      if (typeof lensSource !== "object" || lensSource === null || Array.isArray(lensSource)) throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
      const lens = lensSource as Record<string, unknown>;
      const keys = Array.isArray(lens.fields) ? lens.fields : undefined;
      if (typeof lens.name !== "string" || keys === undefined || keys.some(key => typeof key !== "string")) throw new Error(`MIGRATION_CONCEPT_INVALID: ${entry.path}`);
      const lensExtensions = preservedMembers(lens, new Set(["name", "fields"]));
      views.push({
        name: lens.name,
        keys: keys as readonly string[],
        ...(lensExtensions === undefined ? {} : { extensions: lensExtensions }),
      });
    }
    const conceptExtensions = preservedMembers(
      concept,
      new Set(["concept", "intent", "fields", "lenses", "views"]),
    );
    contracts[concept.concept] = {
      intent: concept.intent,
      fields,
      views,
      extensions: {
        ...(conceptExtensions ?? {}),
        migrationProvenance: { sourcePath: entry.path },
      },
    };
  }
  return contracts;
}
function policyFor(proposal: MigrationProposal, base: BaseContract): TemplatePolicy {
  const templates = Object.fromEntries(proposal.bindings.map(binding => [binding.templateId, binding]));
  return { version: 1, templateFolder: proposal.templateFolder, base, contracts: conceptsFor(proposal, base), templates };
}
function legacyProjectionContract(value: VerifiedFileState): { readonly fields: Readonly<Record<string, FieldPolicy>>; readonly axes: GlobalAxes; readonly extensions?: DerivedProjection["extensions"] } {
  if (value.state === "absent") return { fields: {}, axes: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(value.bytes)) as unknown; }
  catch { throw new Error("MIGRATION_LEGACY_PROJECTION_INVALID: .oms/types.json"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MIGRATION_LEGACY_PROJECTION_INVALID: .oms/types.json");
  const source = parsed as Record<string, unknown>;
  const vocabulary = (value: unknown, where: string): { readonly values: readonly string[]; readonly metadata?: JsonValue } => {
    if (!Array.isArray(value)) return { values: [] };
    const values: string[] = [];
    const metadata: JsonValue[] = [];
    for (const item of value) {
      if (typeof item === "string") { values.push(item); continue; }
      if (typeof item !== "object" || item === null || Array.isArray(item) || typeof (item as Record<string, unknown>).value !== "string") throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: ${where}`);
      values.push((item as Record<string, unknown>).value as string);
      metadata.push(asJson(item));
    }
    return { values, ...(metadata.length === 0 ? {} : { metadata }) };
  };
  const allowed = typeof source.allowedValues === "object" && source.allowedValues !== null && !Array.isArray(source.allowedValues)
    ? source.allowedValues as Record<string, unknown>
    : {};
  const fields: Record<string, FieldPolicy> = {};
  const typeEntries: readonly [string, unknown][] = Array.isArray(source.types)
    ? source.types.map((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: types[${index}]`);
      const item = raw as Record<string, unknown>;
      if (typeof (item.name ?? item.key) !== "string") throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: types[${index}]`);
      return [(item.name ?? item.key) as string, item.type] as const;
    })
    : typeof source.types === "object" && source.types !== null
      ? Object.entries(source.types as Record<string, unknown>)
      : [];
  for (const [key, raw] of typeEntries) {
      const descriptor = typeof raw === "string" ? { type: raw } : raw;
      if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor) || typeof (descriptor as Record<string, unknown>).type !== "string") throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: types.${key}`);
      const type = (descriptor as Record<string, unknown>).type as ObsidianContractType;
      const values = (descriptor as Record<string, unknown>).allowedValues ?? allowed[key];
      const parsedValues = vocabulary(values, `allowedValues.${key}`);
      fields[key] = {
        type,
        ...(parsedValues.values.length === 0 ? {} : { allowedValues: parsedValues.values }),
        ...(typeof (descriptor as Record<string, unknown>).immutable === "boolean" ? { immutable: (descriptor as Record<string, unknown>).immutable as boolean } : {}),
        ...(parsedValues.metadata === undefined ? {} : { extensions: { legacyAllowedValueMetadata: parsedValues.metadata } }),
      };
  }
  const axes: Record<string, GlobalAxis> = {};
  const axisEntries: readonly [string, unknown][] = Array.isArray(source.axes)
    ? source.axes.map((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof (raw as Record<string, unknown>).key !== "string") throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: axes[${index}]`);
      return [(raw as Record<string, unknown>).key as string, raw] as const;
    })
    : typeof source.axes === "object" && source.axes !== null
      ? Object.entries(source.axes as Record<string, unknown>)
      : [];
  for (const [name, raw] of axisEntries) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: axes.${name}`);
      const axis = raw as Record<string, unknown>;
      if ((axis.kind !== "folder" && axis.kind !== "link" && axis.kind !== "field") || typeof axis.key !== "string" || typeof axis.type !== "string") throw new Error(`MIGRATION_LEGACY_PROJECTION_INVALID: axes.${name}`);
      const parsedValues = vocabulary(axis.allowedValues ?? allowed[axis.key], `axes.${name}.allowedValues`);
      const extras = preservedMembers(axis, new Set(["kind", "key", "type", "required", "normalize", "allowedValues", "intent", "members"]));
      if (axis.kind === "field") {
        fields[axis.key] = {
          ...fields[axis.key],
          type: axis.type as ObsidianContractType,
          ...(typeof axis.required === "boolean" ? { required: axis.required } : {}),
          ...(axis.normalize === "lower" || axis.normalize === "trim" || axis.normalize === "kebab" ? { normalize: axis.normalize } : {}),
          ...(parsedValues.values.length === 0 ? {} : { allowedValues: parsedValues.values }),
          ...(typeof axis.intent === "string" ? { intent: axis.intent } : {}),
          ...(extras === undefined && parsedValues.metadata === undefined ? {} : { extensions: { ...(fields[axis.key]?.extensions ?? {}), ...(extras ?? {}), ...(parsedValues.metadata === undefined ? {} : { legacyAllowedValueMetadata: parsedValues.metadata }) } }),
        };
      } else {
        const members = Array.isArray(axis.members)
          ? axis.members.map(asJson)
          : Array.isArray(axis.allowedValues)
            ? axis.allowedValues.map(asJson)
            : parsedValues.values;
        axes[name] = {
          kind: axis.kind,
          key: axis.key,
          type: axis.type as ObsidianContractType,
          members,
          ...(typeof axis.intent === "string" ? { intent: axis.intent } : {}),
          ...(extras === undefined && parsedValues.metadata === undefined ? {} : { extensions: { ...(extras ?? {}), ...(parsedValues.metadata === undefined ? {} : { legacyAllowedValueMetadata: parsedValues.metadata }) } }),
        };
      }
  }
  const members = Object.entries(source).filter(([key]) => !new Set(["version", "generatedFrom", "managed", "types", "allowedValues", "axes"]).has(key));
  return { fields, axes, ...(members.length === 0 ? {} : { extensions: Object.fromEntries(members) as DerivedProjection["extensions"] }) };
}
function asJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, member]) => [key, asJson(member)]));
  throw new Error("MIGRATION_TAXONOMY_INVALID: non-JSON taxonomy member");
}
function translatedTaxonomy(value: VerifiedFileState, proposal: MigrationProposal, legacyYaml: boolean, inheritedAxes: GlobalAxes = {}): { readonly bytes: Uint8Array; readonly globalAxes: GlobalAxes; readonly targetFolders: ReadonlyMap<string, TemplateFolderPath> } {
  if (value.state === "absent") return { bytes: bytes(`${JSON.stringify({ folders: {}, globalAxes: inheritedAxes }, null, 2)}\n`), globalAxes: inheritedAxes, targetFolders: new Map() };
  let source: unknown;
  try {
    if (legacyYaml) {
      const document = parseDocument(new TextDecoder().decode(value.bytes), { prettyErrors: false });
      if (document.errors.length > 0) throw new Error("invalid YAML");
      source = document.toJS() as unknown;
    } else {
      source = JSON.parse(new TextDecoder().decode(value.bytes)) as unknown;
    }
  } catch {
    throw new Error(`MIGRATION_TAXONOMY_INVALID: ${legacyYaml ? ".oms/taxonomy.yaml" : ".oms/taxonomy.json"}`);
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new Error(`MIGRATION_TAXONOMY_INVALID: ${legacyYaml ? ".oms/taxonomy.yaml" : ".oms/taxonomy.json"}`);
  const root = asJson(source) as unknown as Record<string, JsonValue>;
  const folders = root.folders;
  if (folders !== undefined && (typeof folders !== "object" || folders === null || Array.isArray(folders))) throw new Error("MIGRATION_TAXONOMY_INVALID: folders");
  const candidates = new Map(proposal.candidates.map(candidate => [candidate.templateId, candidate.templateId]));
  const targetFolders = new Map<string, TemplateFolderPath>();
  if (folders !== undefined) {
    for (const [folder, raw] of Object.entries(folders)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`MIGRATION_TAXONOMY_INVALID: folders.${folder}`);
      const binding = raw as Record<string, JsonValue>;
      const concept = binding.concept;
      if (concept !== null && typeof concept !== "string" && (!Array.isArray(concept) || concept.some(item => typeof item !== "string"))) throw new Error(`MIGRATION_TAXONOMY_INVALID: folders.${folder}.concept`);
      const concepts = typeof concept === "string" ? [concept] : Array.isArray(concept) ? concept as readonly string[] : [];
      const templateIds = concepts.map(name => {
        const clone = proposal.bindingClones.find(item => item.legacyConcept === name && item.folder === folder);
        const templateId = clone?.templateId ?? candidates.get(validateTemplateId(name));
        if (templateId === undefined) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: folders.${folder}`);
        targetFolders.set(templateId, normalizeTemplateFolderPath(folder));
        return templateId;
      });
      const { concept: _concept, ...rest } = binding;
      (folders as Record<string, JsonValue>)[folder] = {
        ...rest,
        ...(templateIds.length === 1 ? { template: templateIds[0]! } : { templates: templateIds }),
        templateFolder: folder,
      };
    }
  }
  const rawAxes = root.globalAxes ?? root.axes;
  const axes: Record<string, GlobalAxis> = { ...inheritedAxes };
  if (rawAxes !== undefined) {
    if (typeof rawAxes !== "object" || rawAxes === null || Array.isArray(rawAxes)) throw new Error("MIGRATION_TAXONOMY_INVALID: globalAxes");
    for (const [name, raw] of Object.entries(rawAxes)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const axis = raw as Record<string, JsonValue>;
      if ((axis.kind !== "folder" && axis.kind !== "link") || typeof axis.key !== "string" || typeof axis.type !== "string" || !Array.isArray(axis.members)) continue;
      axes[name] = { kind: axis.kind, key: axis.key, type: axis.type as GlobalAxis["type"], ...(typeof axis.intent === "string" ? { intent: axis.intent } : {}), members: axis.members };
    }
  }
  const publishedAxes = { ...axes };
  const folderOntology = deriveFolderOntologyAxis(folders, ".oms/taxonomy.json.folders");
  if (folderOntology !== null) {
    if (Object.hasOwn(axes, "folder-ontology")) throw new Error("MIGRATION_TAXONOMY_INVALID: globalAxes.folder-ontology is reserved");
    axes["folder-ontology"] = folderOntology;
  }
  root.globalAxes = publishedAxes as unknown as JsonValue;
  delete root.axes;
  return { bytes: bytes(`${JSON.stringify(root, null, 2)}\n`), globalAxes: axes, targetFolders };
}
function inputFor(authority: readonly AuthorityEntry[], bindings: readonly TemplateBinding[], folder: TemplateFolderPath): InputV2 {
  return { version: 2, authority, placement: bindings.map(binding => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, templateFolder: binding.destinationClass === "managed-default" ? folder : null, sourcePath: binding.sourcePath })) };
}
function authorityFor(policy: VerifiedFileState, taxonomy: VerifiedFileState, taxonomyPath: ".oms/taxonomy.yaml" | ".oms/taxonomy.json", projection: VerifiedFileState, obsidian: VerifiedFileState, candidates: readonly TemplateCandidate[], includeLegacyProjection: boolean): AuthorityEntry[] {
  const controls: AuthorityEntry[] = [];
  if (policy.state === "present") controls.push({ kind: "policy", logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: policy.signature });
  if (taxonomy.state === "present") controls.push({ kind: "taxonomy", logicalId: "taxonomy", vaultRelativePath: taxonomyPath, contentDigest: taxonomy.signature });
  if (includeLegacyProjection && projection.state === "present") controls.push({ kind: "legacy-contract", logicalId: "legacy-types", vaultRelativePath: ".oms/types.json", contentDigest: projection.signature });
  controls.push({ kind: "obsidian-types", logicalId: "obsidian-types", vaultRelativePath: ".obsidian/types.json", contentDigest: present(obsidian, ".obsidian/types.json").signature });
  return [...controls, ...candidates.map(candidate => ({ kind: "template" as const, logicalId: candidate.templateId, vaultRelativePath: candidate.sourcePath, contentDigest: sha(candidate.bytes) }))];
}

/** Composes the complete guarded manifest from observed vault bytes. It never publishes. */
export async function buildMigrationManifest(vault: string, proposal: MigrationProposal, input: MigrationCompositionInput): Promise<TemplateCompositionManifest> {
  if (proposal.unresolved.length > 0) throw new Error("MIGRATION_UNRESOLVED_MAPPING");
  const root = resolve(vault);
  const [policyState, taxonomyState, legacyTaxonomyState, projectionState, obsidianState] = await Promise.all([
    fileState(root, ".oms/template-policy.json"), fileState(root, ".oms/taxonomy.json"), fileState(root, ".oms/taxonomy.yaml"), fileState(root, ".oms/types.json"), fileState(root, ".obsidian/types.json"),
  ]);
  present(obsidianState, ".obsidian/types.json");
  const authority = await loadObsidianTypes(root);
  if (authority === null) throw new Error("MIGRATION_AUTHORITY_MISSING: .obsidian/types.json");
  const currentPolicy = policyState.state === "present" ? parseTemplatePolicy(new TextDecoder().decode(policyState.bytes)) : undefined;
  const taxonomyInput = legacyTaxonomyState.state === "present" ? legacyTaxonomyState : taxonomyState;
  if (taxonomyInput.state === "present") {
    try {
      const source = legacyTaxonomyState.state === "present"
        ? parseDocument(new TextDecoder().decode(taxonomyInput.bytes), { prettyErrors: false }).toJS({ mapAsMap: true })
        : JSON.parse(new TextDecoder().decode(taxonomyInput.bytes)) as unknown;
      if (mapping(source) === null) throw new Error("invalid taxonomy");
    } catch {
      throw new Error(`MIGRATION_TAXONOMY_INVALID: ${legacyTaxonomyState.state === "present" ? ".oms/taxonomy.yaml" : ".oms/taxonomy.json"}`);
    }
  }
  // `.oms/types.json` is legacy input during migration. It is intentionally not
  // accepted through the template-first projection parser.
  const legacyContract = legacyProjectionContract(projectionState);
  const migratedBase: BaseContract = { ...input.base, fields: { ...legacyContract.fields, ...input.base.fields } };
  const proposedPolicy = currentPolicy ?? policyFor(proposal, migratedBase);
  const proposedBindings = Object.values(proposedPolicy.templates).sort((a, b) => a.templateId.localeCompare(b.templateId));
  const candidateById = new Map(proposal.candidates.map(candidate => [candidate.templateId, candidate]));
  if (candidateById.size !== proposal.candidates.length) throw new Error("TEMPLATE_ID_DUPLICATE");
  if (candidateById.size !== proposedBindings.length) throw new Error("MIGRATION_UNRESOLVED_MAPPING: discovered templates are not all bound");
  for (const binding of proposedBindings) if (candidateById.get(binding.templateId)?.sourcePath !== binding.sourcePath) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: ${binding.templateId}`);
  const extracted = proposedBindings.map(binding => parseTemplate(binding.sourcePath, candidateById.get(binding.templateId)!.bytes));
  const fields = extracted.map((template, index) => {
    const binding = proposedBindings[index]!;
    const contract = proposedPolicy.contracts[binding.contract];
    if (contract === undefined) throw new Error(`MIGRATION_UNRESOLVED_MAPPING: ${binding.contract}`);
    return composeResolvedTemplateFields(
      proposedPolicy.base,
      contract.fields,
      template.frontmatter,
      authority.types,
    );
  });
  const policyBytes = bytes(serializeTemplatePolicy(proposedPolicy));
  const translated = translatedTaxonomy(taxonomyInput, proposal, legacyTaxonomyState.state === "present", legacyContract.axes);
  const taxonomyBytes = translated.bytes;
  const sourceDescriptors = [
    { logicalId: "template-policy", signature: sha(policyBytes) },
    { logicalId: "taxonomy", signature: sha(taxonomyBytes) },
    { logicalId: "obsidian-types", signature: present(obsidianState, ".obsidian/types.json").signature },
    ...extracted.map(template => ({ path: template.sourcePath, signature: template.sourceDigest })),
  ];
  const derived: DerivedProjection = {
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sourceDescriptors), sources: sourceDescriptors },
    managed: { base: proposedPolicy.base, globalAxes: translated.globalAxes, templates: Object.fromEntries(proposedBindings.map((binding, index) => [binding.templateId, { templateId: binding.templateId, destinationClass: binding.destinationClass, sourcePath: binding.sourcePath, targetFolder: translated.targetFolders.get(binding.templateId) ?? normalizeTemplateFolderPath("Inbox"), keyOrder: extracted[index]!.keyOrder, fields: fields[index]!, views: proposedPolicy.contracts[binding.contract]?.views ?? [], naming: binding.naming, bodySignature: sha(bytes(extracted[index]!.body)) }])) },
    ...(legacyContract.extensions === undefined ? {} : { extensions: legacyContract.extensions }),
  };
  const projectionBytes = bytes(serializeDerivedProjection(derived));
  const sources = (await Promise.all(proposedBindings.map(async binding => {
    const candidate = candidateById.get(binding.templateId)!;
    const current = await fileState(root, binding.sourcePath);
    if (current.state === "present" && !same(current.bytes, candidate.bytes)) {
      throw new Error(`MIGRATION_OUTPUT_CONFLICT: ${binding.sourcePath}`);
    }
    const proposed = { state: "present" as const, bytes: candidate.bytes, signature: sha(candidate.bytes) };
    return {
      templateId: binding.templateId,
      path: binding.sourcePath,
      expectedCurrent: expectation(current),
      current,
      proposed,
      action: current.state === "present" ? "verify-only" as const : "write" as const,
    };
  }))).sort((a, b) => a.templateId.localeCompare(b.templateId));
  const currentBindings = currentPolicy === undefined ? [] : Object.values(currentPolicy.templates).sort((a, b) => a.templateId.localeCompare(b.templateId));
  const currentInput = inputFor(authorityFor(policyState, taxonomyInput, legacyTaxonomyState.state === "present" ? ".oms/taxonomy.yaml" : ".oms/taxonomy.json", projectionState, obsidianState, currentBindings.map(binding => candidateById.get(binding.templateId)!).filter((candidate): candidate is TemplateCandidate => candidate !== undefined), currentPolicy === undefined), currentBindings, currentPolicy?.templateFolder ?? proposal.templateFolder);
  const proposedInput = inputFor(authorityFor({ state: "present", bytes: policyBytes, signature: sha(policyBytes) }, { state: "present", bytes: taxonomyBytes, signature: sha(taxonomyBytes) }, ".oms/taxonomy.json", projectionState, obsidianState, proposal.candidates, currentPolicy === undefined), proposedBindings, proposedPolicy.templateFolder);
  const current = { input: currentInput, inputDigest: inputDigest(currentInput), bindings: currentBindings, resolvedTemplates: currentBindings.map(binding => { const candidate = candidateById.get(binding.templateId)!; return { templateId: binding.templateId, sourcePath: binding.sourcePath, inputSignature: inputDigest(currentInput), templateSignature: sha(candidate.bytes) }; }) };
  const proposed = { input: proposedInput, inputDigest: inputDigest(proposedInput), bindings: proposedBindings, resolvedTemplates: extracted.map((template, index) => ({ templateId: proposedBindings[index]!.templateId, sourcePath: template.sourcePath, inputSignature: derived.generatedFrom.inputSignature, templateSignature: template.sourceDigest })) };
  const controls: TemplateCompositionManifest["controls"] = [
    { kind: "policy", path: ".oms/template-policy.json", expectedCurrent: expectation(policyState), current: policyState, proposed: { state: "present", bytes: policyBytes, signature: sha(policyBytes) }, action: policyState.state === "present" && same(policyState.bytes, policyBytes) ? "verify-only" : "write" },
    { kind: "taxonomy", path: ".oms/taxonomy.json", expectedCurrent: expectation(taxonomyState), current: taxonomyState, proposed: { state: "present", bytes: taxonomyBytes, signature: sha(taxonomyBytes) }, action: taxonomyState.state === "present" && same(taxonomyState.bytes, taxonomyBytes) ? "verify-only" : "write" },
    { kind: "projection", path: ".oms/types.json", expectedCurrent: expectation(projectionState), current: projectionState, proposed: { state: "present", bytes: projectionBytes, signature: sha(projectionBytes) }, action: projectionState.state === "present" && same(projectionState.bytes, projectionBytes) ? "verify-only" : "write" },
  ];
  const mode: "create" | "update" = currentPolicy === undefined ? "create" : "update";
  const operations = proposedBindings.map(binding => ({ kind: mode, templateId: binding.templateId, destinationClass: binding.destinationClass, payloadDigest: candidateById.get(binding.templateId)!.bytes ? sha(candidateById.get(binding.templateId)!.bytes) : sha(new Uint8Array()), stableRelativeSuffix: null }));
  const outputs = [...controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })), ...sources.map(source => ({ finalVaultRelativePath: source.path, payloadDigest: source.proposed.signature }))];
  return { version: 1, mode, current, proposed, controls, sources, operations, diagnostics: [], moves: [], outputs, approvalDigest: approvalDigest(proposed.inputDigest, operations, []), outputDigest: outputDigest(outputs) };
}
