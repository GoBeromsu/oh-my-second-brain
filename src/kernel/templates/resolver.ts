import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";
import { loadObsidianTypes } from "../contracts/index.js";
import { extractTemplate, parseTemplate } from "./extract.js";
import { approvalDigest, canonicalJson, inputDigest, outputDigest } from "./canonical.js";
import { normalizeTemplateFolderPath, normalizeTemplateSourcePath, verifyTemplateSourcePath } from "./paths.js";
import { applyTemplatePolicyChange, parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { templateMigrationAdmission } from "./transaction.js";
import type { BaseContract, DerivedProjection, Digest, FieldPolicy, GlobalAxes, GlobalAxis, InputV2, JsonValue, ResolvedConvention, ResolvedTemplate, SourceDescriptor, SourceTransition, TemplateCompositionManifest, TemplateCompositionOptions, TemplateFolderPath, TemplateMove, TemplateSemanticChange, TemplateSemanticSnapshot, TemplateSourcePath, VerifiedFileState } from "./types.js";

const SAFE_INBOX = normalizeTemplateFolderPath("Inbox");

export interface LoadResolvedTemplatesOptions {
  readonly policyPath?: string;
  readonly projectionPath?: string;
  readonly taxonomyPath?: string;
  readonly sourcePaths?: readonly string[];
}

const TEMPLATE_CONTROL_PATHS = [
  ".oms/template-migration.json",
  ".oms/template-policy.json",
  ".oms/types.json",
  ".oms/taxonomy.yaml",
] as const;

function sha256(value: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}
async function templateControlExists(vault: string, path: string): Promise<boolean> {
  try {
    await stat(resolve(vault, path));
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    fail("TEMPLATE_SOURCE_INVALID", `template control (${path}) cannot be inspected: ${code}`);
  }
}

function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function sourcePath(vault: string, absolute: string): string {
  const path = relative(vault, absolute).replaceAll("\\", "/");
  if (path === "" || path.startsWith("../") || path === "..") fail("TEMPLATE_SOURCE_UNSAFE", `${absolute} is outside the vault`);
  return path;
}
async function required(vault: string, path: string, label: string): Promise<{ readonly path: string; readonly bytes: Uint8Array; readonly signature: Digest }> {
  try {
    const absolute = resolve(vault, path);
    sourcePath(vault, absolute);
    const bytes = await readFile(absolute);
    return { path, bytes, signature: sha256(bytes) };
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    fail("TEMPLATE_SOURCE_INVALID", `${label} (${path}) cannot be read: ${code}`);
  }
}
function locator(source: SourceDescriptor): { readonly kind: "logicalId" | "path"; readonly value: string } {
  const hasLogicalId = typeof source.logicalId === "string";
  const hasPath = typeof source.path === "string";
  if (hasLogicalId === hasPath) fail("PROJECTION_INVALID", "each generated source must contain exactly one of logicalId or path");
  return hasLogicalId
    ? { kind: "logicalId", value: source.logicalId! }
    : { kind: "path", value: source.path! };
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sourceOrder(left: SourceDescriptor, right: SourceDescriptor): number {
  const a = locator(left);
  const b = locator(right);
  return compare(a.kind, b.kind) || compare(a.value, b.value) || compare(left.signature, right.signature);
}
function sameSources(left: readonly SourceDescriptor[], right: readonly SourceDescriptor[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort(sourceOrder);
  const actual = [...right].sort(sourceOrder);
  return expected.every((source, index) => {
    const other = actual[index]!;
    const a = locator(source);
    const b = locator(other);
    return a.kind === b.kind && a.value === b.value && source.signature === other.signature;
  });
}
function signature(sources: readonly SourceDescriptor[]): Digest {
  const hash = createHash("sha256");
  for (const source of [...sources].sort(sourceOrder)) {
    const sourceLocator = locator(source);
    for (const part of [sourceLocator.kind, sourceLocator.value, source.signature]) {
      const bytes = Buffer.from(part, "utf8");
      hash.update(String(bytes.byteLength));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}` as Digest;
}

/** Stable, length-prefixed signature used by generatedFrom.inputSignature. */
export function sourceSignature(sources: readonly SourceDescriptor[]): Digest { return signature(sources); }

function literalType(value: JsonValue): FieldPolicy["type"] | undefined {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? "date" : "text";
  return undefined;
}
function literalCompatible(value: JsonValue, type: NonNullable<FieldPolicy["type"]>): boolean {
  if (value === null) return true;
  if (type === "number") return typeof value === "number";
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "list" || type === "multitext" || type === "multi" || type === "tags" || type === "aliases") return Array.isArray(value);
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "datetime") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  return typeof value === "string";
}
export function composeResolvedTemplateFields(base: BaseContract, fields: Readonly<Record<string, FieldPolicy>>, values: Readonly<Record<string, JsonValue>>, obsidian: Readonly<Record<string, FieldPolicy["type"]>>): Readonly<Record<string, FieldPolicy>> {
  const result: Record<string, FieldPolicy> = {};
  for (const key of Object.keys(base.fields)) {
    if (base.fields[key]?.required === true && !Object.hasOwn(values, key)) fail("BASE_FIELD_MISSING_FROM_TEMPLATE", `template is missing required base field ${key}`);
  }
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(values, key) && !Object.hasOwn(base.fields, key)) fail("TEMPLATE_POLICY_DANGLING_FIELD", `policy field ${key} is absent from template`);
  }
  for (const key of Object.keys(values)) {
    const baseField = base.fields[key] ?? {};
    const policyField = fields[key] ?? {};
    const declared = policyField.type ?? baseField.type;
    const explicit = obsidian[key];
    if (explicit !== undefined && declared !== undefined && explicit !== declared) fail("OBSIDIAN_TYPE_CONFLICT", `field ${key} has Obsidian type ${explicit} but policy type ${declared}`);
    const type = explicit ?? declared ?? literalType(values[key]!);
    if (type === undefined) fail("TEMPLATE_TYPE_UNRESOLVED", `field ${key} has no type authority`);
    if (!literalCompatible(values[key]!, type)) fail("OBSIDIAN_TYPE_CONFLICT", `field ${key} template literal is incompatible with type ${type}`);
    result[key] = { ...baseField, ...policyField, type };
  }
  return result;
}
function bodySignature(body: string): Digest { return sha256(body); }
function managed(projection: DerivedProjection["managed"], templates: Readonly<Record<string, ResolvedTemplate>>): DerivedProjection["managed"] {
  return {
    base: projection.base,
    globalAxes: projection.globalAxes,
    templates: Object.fromEntries(Object.entries(templates).map(([id, template]) => [id, {
      templateId: template.id,
      destinationClass: template.destinationClass,
      sourcePath: template.sourcePath,
      targetFolder: template.targetFolder,
      keyOrder: template.keyOrder,
      fields: template.fields,
      views: template.views,
      naming: template.naming,
      bodySignature: bodySignature(template.body),
    }])),
  };
}
function validateTaxonomy(path: string, bytes: Uint8Array): void {
  const document = parseDocument(Buffer.from(bytes).toString("utf8"), { prettyErrors: false });
  if (document.errors.length > 0 || document.contents === null || !isMap(document.contents)) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be a YAML mapping`);
}
function yamlRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function deriveFolderOntologyAxis(rawFolders: unknown, where = "taxonomy.folders"): GlobalAxis | null {
  const folders = yamlRecord(rawFolders);
  if (rawFolders !== undefined && folders === null) fail("TEMPLATE_SOURCE_INVALID", `${where} must be a mapping`);
  const meanings = Object.entries(folders ?? {}).flatMap(([rawPath, raw]) => {
    const definition = yamlRecord(raw);
    if (definition === null) fail("TEMPLATE_SOURCE_INVALID", `${where}.${rawPath} must be a mapping`);
    if (definition.intent === undefined) return [];
    if (typeof definition.intent !== "string" || definition.intent.trim().length === 0) fail("TEMPLATE_SOURCE_INVALID", `${where}.${rawPath}.intent must be a non-empty string`);
    return [{ path: normalizeTemplateFolderPath(rawPath), intent: definition.intent.trim() }];
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (meanings.length === 0) return null;
  return {
    kind: "folder",
    key: "folder",
    type: "text",
    intent: "Semantic meanings of vault folders.",
    members: meanings.map(item => item.path),
    extensions: { intents: Object.fromEntries(meanings.map(item => [item.path, item.intent])) },
  };
}

function taxonomyRouting(path: string, bytes: Uint8Array): { readonly targetFolders: ReadonlyMap<string, TemplateFolderPath>; readonly globalAxes: GlobalAxes } {
  const document = parseDocument(Buffer.from(bytes).toString("utf8"), { prettyErrors: false });
  const root = yamlRecord(document.toJS());
  if (root === null) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be a YAML mapping`);
  const targetFolders = new Map<string, TemplateFolderPath>();
  const templates = yamlRecord(root.templates);
  for (const [templateId, raw] of Object.entries(templates ?? {})) {
    const definition = yamlRecord(raw);
    if (typeof definition?.templateFolder === "string") targetFolders.set(templateId, normalizeTemplateFolderPath(definition.templateFolder));
  }
  const folders = yamlRecord(root.folders);
  for (const [folder, raw] of Object.entries(folders ?? {})) {
    const definition = yamlRecord(raw);
    const templateId = typeof definition?.templateId === "string" ? definition.templateId : typeof definition?.template === "string" ? definition.template : undefined;
    const targetFolder = typeof definition?.templateFolder === "string" ? definition.templateFolder : folder;
    if (templateId !== undefined) targetFolders.set(templateId, normalizeTemplateFolderPath(targetFolder));
    if (definition?.templates !== undefined) {
      if (!Array.isArray(definition.templates) || definition.templates.some(item => typeof item !== "string")) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) folders.${folder}.templates must contain template IDs`);
      for (const id of definition.templates as readonly string[]) targetFolders.set(id, normalizeTemplateFolderPath(targetFolder));
    }
  }
  const axes: Record<string, GlobalAxis> = {};
  const rawAxes = yamlRecord(root.globalAxes) ?? yamlRecord(root.axes) ?? {};
  for (const [name, raw] of Object.entries(rawAxes)) {
    const axis = yamlRecord(raw);
    if ((axis?.kind !== "folder" && axis?.kind !== "link") || typeof axis.key !== "string" || typeof axis.type !== "string" || !Array.isArray(axis.members)) continue;
    axes[name] = {
      kind: axis.kind,
      key: axis.key,
      type: axis.type as GlobalAxis["type"],
      ...(typeof axis.intent === "string" ? { intent: axis.intent } : {}),
      members: axis.members as readonly JsonValue[],
      ...(axis.extensions !== undefined && yamlRecord(axis.extensions) !== null ? { extensions: axis.extensions as GlobalAxis["extensions"] } : {}),
    };
  }
  const folderOntology = deriveFolderOntologyAxis(root.folders, `${path}.folders`);
  if (folderOntology !== null) {
    if (Object.hasOwn(axes, "folder-ontology")) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) globalAxes.folder-ontology is reserved`);
    axes["folder-ontology"] = folderOntology;
  }
  return { targetFolders, globalAxes: axes };
}

/**
 * Resolves the signed, user-owned template projection without creating or changing vault files.
 * `sourcePaths` is intentionally additive only: it may name already registered template paths.
 */
export async function loadResolvedTemplates(vault: string, options: LoadResolvedTemplatesOptions = {}): Promise<ResolvedConvention> {
  const root = resolve(vault);
  if (await templateMigrationAdmission(root) !== "clear") fail("MIGRATION_INCOMPLETE", "template migration marker is in progress or invalid");
  const policyFile = options.policyPath ?? ".oms/template-policy.json";
  const projectionFile = options.projectionPath ?? ".oms/types.json";
  const taxonomyFile = options.taxonomyPath ?? ".oms/taxonomy.yaml";
  const [policyRaw, projectionRaw, taxonomyRaw] = await Promise.all([
    required(root, policyFile, "template policy"), required(root, projectionFile, "derived projection"), required(root, taxonomyFile, "taxonomy"),
  ]);
  validateTaxonomy(taxonomyRaw.path, taxonomyRaw.bytes);
  const taxonomy = taxonomyRouting(taxonomyRaw.path, taxonomyRaw.bytes);
  const policy = parseTemplatePolicy(Buffer.from(policyRaw.bytes).toString("utf8"));
  const projection = parseDerivedProjection(Buffer.from(projectionRaw.bytes).toString("utf8"));
  const obsidian = await loadObsidianTypes(root);
  if (obsidian === null) fail("TEMPLATE_SOURCE_INVALID", "Obsidian type authority (.obsidian/types.json) is missing");
  const obsidianRaw = await required(root, sourcePath(root, obsidian.source), "Obsidian type authority");
  const bindings = Object.values(policy.templates).sort((a, b) => a.templateId.localeCompare(b.templateId));
  const seen = new Set<string>();
  for (const binding of bindings) {
    const normalized = normalizeTemplateSourcePath(binding.sourcePath);
    if (seen.has(normalized)) fail("TEMPLATE_SOURCE_DUPLICATE", `registered template source ${normalized} is duplicated`);
    seen.add(normalized);
  }
  for (const extra of options.sourcePaths ?? []) {
    const normalized = normalizeTemplateSourcePath(extra);
    if (!seen.has(normalized)) fail("TEMPLATE_SOURCE_INVALID", `explicit source ${normalized} is not a registered template`);
  }
  await Promise.all(bindings.map(binding => verifyTemplateSourcePath(root, binding.sourcePath)));
  const extracted = await Promise.all(bindings.map(binding => extractTemplate(root, binding.sourcePath)));
  const descriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: policyRaw.signature },
    { logicalId: "taxonomy", signature: taxonomyRaw.signature },
    { logicalId: "obsidian-types", signature: obsidianRaw.signature },
    ...extracted.map(template => ({ path: template.sourcePath, signature: template.sourceDigest })),
  ];
  const actualInput = signature(descriptors);
  if (actualInput !== projection.generatedFrom.inputSignature || !sameSources(projection.generatedFrom.sources, descriptors)) {
    fail("TEMPLATE_SOURCE_DRIFT", "generated projection sources (logical authority content digests or verified template paths) do not match current vault sources");
  }
  const sourcePaths = extracted.map(template => template.sourcePath).sort((a, b) => a.localeCompare(b)) as TemplateSourcePath[];
  const templates: Record<string, ResolvedTemplate> = {};
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const template = extracted[index]!;
    const contract = policy.contracts[binding.contract];
    if (contract === undefined) fail("TEMPLATE_POLICY_DANGLING_FIELD", `template ${binding.templateId} references unknown contract ${binding.contract}`);
    const fields = composeResolvedTemplateFields(policy.base, contract.fields, template.frontmatter, obsidian.types);
    templates[binding.templateId] = {
      id: binding.templateId,
      destinationClass: binding.destinationClass,
      sourcePath: template.sourcePath,
      targetFolder: taxonomy.targetFolders.get(binding.templateId) ?? SAFE_INBOX,
      bom: template.bom,
      eol: template.eol,
      finalNewline: template.finalNewline,
      keyOrder: template.keyOrder,
      fields,
      frontmatterTemplate: template.frontmatter,
      body: template.body,
      naming: binding.naming,
      views: contract.views,
      inputSignature: actualInput,
      templateSignature: template.sourceDigest,
      managedSourcePaths: sourcePaths,
    };
  }
  const expected = managed({ base: policy.base, globalAxes: taxonomy.globalAxes, templates: {} }, templates);
  if (canonicalJson(expected) !== canonicalJson(projection.managed)) fail("PROJECTION_PAYLOAD_TAMPERED", "managed projection does not equal the canonical resolved template projection");
  return { base: policy.base, templates: Object.fromEntries(Object.entries(templates).sort(([a], [b]) => a.localeCompare(b))), globalAxes: taxonomy.globalAxes, managedSourcePaths: sourcePaths, inputSignature: actualInput };
}

/**
 * Resolves the active template contract, or null when this vault has no OMS
 * template controls at all. Any partial control set remains a strict failure.
 */
export async function loadResolvedTemplatesIfPresent(
  vault: string,
  options: LoadResolvedTemplatesOptions = {},
): Promise<ResolvedConvention | null> {
  const root = resolve(vault);
  const controls = await Promise.all(
    TEMPLATE_CONTROL_PATHS.map((path) => templateControlExists(root, path)),
  );
  if (controls.every((present) => !present)) return null;
  return loadResolvedTemplates(root, options);
}


function manifestDigest(value: Uint8Array): Digest { return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest; }
function manifestBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
async function manifestFile(vault: string, path: string): Promise<VerifiedFileState> {
  try { const value = new Uint8Array(await readFile(resolve(vault, path))); return { state: "present", bytes: value, signature: manifestDigest(value) }; }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" }; throw error; }
}
async function manifestSourceFile(vault: string, path: TemplateSourcePath): Promise<VerifiedFileState> {
  await verifyTemplateSourcePath(vault, normalizeTemplateSourcePath(path), { expected: "either" });
  return manifestFile(vault, path);
}
function sameManifestBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function matchExpectation(actual: VerifiedFileState, expected: import("./types.js").FileExpectation): boolean {
  if (actual.state === "absent" || expected.state === "absent") return actual.state === expected.state;
  return actual.signature === expected.signature;
}
type PresentFile = Extract<VerifiedFileState, { readonly state: "present" }>;
function requiredControl(path: string, value: VerifiedFileState): PresentFile {
  if (value.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `${path} must exist`);
  return value;
}
function requiredSource(templateId: string, value: VerifiedFileState | undefined): VerifiedFileState {
  if (value === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `source state is missing for ${templateId}`);
  return value;
}
function requiredTransition(templateId: string, path: TemplateSourcePath, transitions: readonly SourceTransition[]): SourceTransition {
  const transition = transitions.find(item => item.templateId === templateId && item.path === path);
  if (transition === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `transition is missing for ${templateId}`);
  return transition;
}

/** Builds semantic publication data. It does not publish or reinterpret its manifest. */
export async function buildTemplateCompositionManifest(vault: string, change: TemplateSemanticChange, options: TemplateCompositionOptions): Promise<TemplateCompositionManifest> {
  const repairsAlreadyMovedSource =
    change.mode === "update" && change.moveStrategy === "register-already-moved";
  if (options.allowProjectionRepair !== true && !repairsAlreadyMovedSource) {
    await loadResolvedTemplates(vault);
  }
  const policyPath = ".oms/template-policy.json";
  const taxonomyPath = ".oms/taxonomy.yaml";
  const projectionPath = ".oms/types.json";
  const obsidianPath = ".obsidian/types.json";
  const [policyState, taxonomyState, projectionState, obsidianState] = await Promise.all([
    manifestFile(vault, policyPath),
    manifestFile(vault, taxonomyPath),
    manifestFile(vault, projectionPath),
    manifestFile(vault, obsidianPath),
  ]);
  const policyFile = requiredControl(policyPath, policyState);
  const taxonomyFile = requiredControl(taxonomyPath, taxonomyState);
  const obsidianFile = requiredControl(obsidianPath, obsidianState);
  if (!matchExpectation(policyFile, options.expected.controls.policy) || !matchExpectation(taxonomyFile, options.taxonomy.expectedCurrent) || !matchExpectation(projectionState, options.expected.controls.projection)) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "control CAS does not match");
  const taxonomy = parseDocument(new TextDecoder().decode(options.taxonomy.proposedBytes), { prettyErrors: false });
  if (taxonomy.errors.length || taxonomy.contents === null || !isMap(taxonomy.contents) || (options.taxonomy.action === "verify-only" && !sameManifestBytes(taxonomyFile.bytes, options.taxonomy.proposedBytes))) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "taxonomy proposal is invalid");
  const currentPolicy = parseTemplatePolicy(new TextDecoder().decode(policyFile.bytes));
  const proposedPolicy = applyTemplatePolicyChange(currentPolicy, change);
  const proposedTaxonomy = taxonomyRouting(taxonomyPath, options.taxonomy.proposedBytes);
  let projection: DerivedProjection | undefined;
  if (projectionState.state === "present") {
    try {
      projection = parseDerivedProjection(new TextDecoder().decode(projectionState.bytes));
    } catch (error: unknown) {
      if (options.allowProjectionRepair !== true) throw error;
    }
  } else if (options.allowProjectionRepair !== true) {
    fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `${projectionPath} must exist`);
  }
  const obsidian = await loadObsidianTypes(vault);
  if (obsidian === null) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `${obsidianPath} must exist`);
  const proposedPolicyBytes = manifestBytes(serializeTemplatePolicy(proposedPolicy));
  const currentBindings = Object.values(currentPolicy.templates).sort((a,b) => a.templateId.localeCompare(b.templateId));
  const proposedBindings = Object.values(proposedPolicy.templates).sort((a,b) => a.templateId.localeCompare(b.templateId));
  const currentSources = new Map<string, VerifiedFileState>();
  for (const binding of currentBindings) currentSources.set(binding.templateId, await manifestSourceFile(vault, binding.sourcePath));
  for (const source of options.expected.sources) {
    const binding = currentPolicy.templates[source.templateId];
    const current = requiredSource(source.templateId, currentSources.get(source.templateId));
    if (binding === undefined || binding.sourcePath !== source.path || !matchExpectation(current, source.expected)) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source CAS does not match");
    }
  }
  const transitions: import("./types.js").SourceTransition[] = [];
  for (const binding of proposedBindings) {
    const old = currentPolicy.templates[binding.templateId];
    const proposal = (change.mode === "create" || change.mode === "update") && change.binding.templateId === binding.templateId ? change.source : undefined;
    if (proposal !== undefined && proposal.path !== binding.sourcePath) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `source proposal path differs for ${binding.templateId}`);
    }
    if (old !== undefined && old.sourcePath !== binding.sourcePath) {
      const oldState = requiredSource(binding.templateId, currentSources.get(binding.templateId));
      const newState = await manifestSourceFile(vault, binding.sourcePath);
      if (change.mode === "update" && change.moveStrategy === "register-already-moved") {
        if (oldState.state !== "absent" || newState.state !== "present" || proposal === undefined || proposal.publication !== "verify-existing" || !sameManifestBytes(newState.bytes, proposal.bytes)) {
          fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source does not match for ${binding.templateId}`);
        }
        transitions.push({ templateId: binding.templateId, path: old.sourcePath, expectedCurrent: { state: "absent" }, current: oldState, proposed: { state: "absent" }, action: "verify-only" });
        transitions.push({ templateId: binding.templateId, path: binding.sourcePath, expectedCurrent: { state: "present", signature: newState.signature }, current: newState, proposed: newState, action: "verify-only" });
      } else {
        if (oldState.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `old source is absent for ${binding.templateId}`);
        if (newState.state !== "absent") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `new source collides for ${binding.templateId}`);
        const proposed = proposal === undefined
          ? { state: "present" as const, bytes: new Uint8Array(oldState.bytes), signature: oldState.signature }
          : { state: "present" as const, bytes: new Uint8Array(proposal.bytes), signature: manifestDigest(proposal.bytes) };
        transitions.push({ templateId: binding.templateId, path: binding.sourcePath, expectedCurrent: { state: "absent" }, current: newState, proposed, action: "write" });
        transitions.push({ templateId: binding.templateId, path: old.sourcePath, expectedCurrent: { state: "present", signature: oldState.signature }, current: oldState, proposed: { state: "absent" }, action: "delete" });
      }
      continue;
    }
    const current: VerifiedFileState = old === undefined
      ? await manifestSourceFile(vault, binding.sourcePath)
      : requiredSource(binding.templateId, currentSources.get(binding.templateId));
    if (old === undefined && proposal?.publication === "write" && current.state !== "absent") {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `new source collides for ${binding.templateId}`);
    }
    if (old === undefined && proposal?.publication === "verify-existing" && current.state !== "present") {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source is absent for ${binding.templateId}`);
    }
    if (proposal?.publication === "verify-existing" && (current.state !== "present" || !sameManifestBytes(current.bytes, proposal.bytes))) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source does not match for ${binding.templateId}`);
    }
    const proposed = proposal === undefined ? current : { state: "present" as const, bytes: new Uint8Array(proposal.bytes), signature: manifestDigest(proposal.bytes) };
    transitions.push({ templateId: binding.templateId, path: binding.sourcePath, expectedCurrent: current.state === "present" ? { state: "present", signature: current.signature } : { state: "absent" }, current, proposed, action: proposal === undefined || proposal.publication === "verify-existing" ? "verify-only" : "write" });
  }
  const makeSnapshot = (policy: import("./types.js").TemplatePolicy, policyDigest: Digest, taxonomyDigest: Digest, obsidianDigest: Digest, bindings: readonly import("./types.js").TemplateBinding[], sourceState: (binding: import("./types.js").TemplateBinding) => VerifiedFileState, resolvedInputSignature: Digest): TemplateSemanticSnapshot => {
    const authority = [{ kind: "policy" as const, logicalId: "template-policy", vaultRelativePath: ".oms/template-policy.json", contentDigest: policyDigest }, { kind: "taxonomy" as const, logicalId: "taxonomy", vaultRelativePath: ".oms/taxonomy.yaml", contentDigest: taxonomyDigest }, { kind: "obsidian-types" as const, logicalId: "obsidian-types", vaultRelativePath: obsidianPath, contentDigest: obsidianDigest }, ...bindings.map(binding => { const state = sourceState(binding); return { kind: "template" as const, logicalId: binding.templateId, vaultRelativePath: binding.sourcePath, contentDigest: state.state === "present" ? state.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source absent") }; })].sort((a,b) => a.kind.localeCompare(b.kind) || a.logicalId.localeCompare(b.logicalId));
    const input: InputV2 = { version: 2, authority, placement: bindings.map(binding => ({ templateId: binding.templateId, destinationClass: binding.destinationClass, templateFolder: binding.destinationClass === "managed-default" ? policy.templateFolder : null, sourcePath: binding.sourcePath })) };
    return { input, inputDigest: inputDigest(input), bindings, resolvedTemplates: bindings.map(binding => { const source = sourceState(binding); return { templateId: binding.templateId, sourcePath: binding.sourcePath, inputSignature: resolvedInputSignature, templateSignature: source.state === "present" ? source.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source absent") }; }) };
  };
  const current = makeSnapshot(
    currentPolicy,
    policyFile.signature,
    taxonomyFile.signature,
    obsidianFile.signature,
    currentBindings,
    binding => {
      const source = requiredSource(binding.templateId, currentSources.get(binding.templateId));
      if (source.state === "absent" && change.mode === "update" && change.moveStrategy === "register-already-moved" && change.templateId === binding.templateId) {
        return requiredTransition(binding.templateId, change.binding.sourcePath, transitions).proposed;
      }
      return source;
    },
    projection?.generatedFrom.inputSignature ?? options.expected.input,
  );
  if (current.inputDigest !== options.expected.input) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "input CAS does not match");
  const proposedSourceStates = new Map(proposedBindings.map(binding => [binding.templateId, requiredTransition(binding.templateId, binding.sourcePath, transitions).proposed]));
  const proposedDescriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: manifestDigest(proposedPolicyBytes) },
    { logicalId: "taxonomy", signature: manifestDigest(options.taxonomy.proposedBytes) },
    { logicalId: "obsidian-types", signature: obsidianFile.signature },
    ...proposedBindings.map(binding => {
      const source = requiredSource(binding.templateId, proposedSourceStates.get(binding.templateId));
      if (source.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `proposed source is absent for ${binding.templateId}`);
      return { path: binding.sourcePath, signature: source.signature };
    }),
  ];
  const proposedResolvedInput = signature(proposedDescriptors);
  const proposedTemplates: Record<string, DerivedProjection["managed"]["templates"][string]> = {};
  for (const binding of proposedBindings) {
    const source = requiredSource(binding.templateId, proposedSourceStates.get(binding.templateId));
    if (source.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `proposed source is absent for ${binding.templateId}`);
    const parsed = parseTemplate(binding.sourcePath, source.bytes);
    const contract = proposedPolicy.contracts[binding.contract];
    if (contract === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `contract is missing for ${binding.templateId}`);
    proposedTemplates[binding.templateId] = {
      templateId: binding.templateId,
      destinationClass: binding.destinationClass,
      sourcePath: binding.sourcePath,
      targetFolder: proposedTaxonomy.targetFolders.get(binding.templateId) ?? SAFE_INBOX,
      keyOrder: parsed.keyOrder,
      fields: composeResolvedTemplateFields(proposedPolicy.base, contract.fields, parsed.frontmatter, obsidian.types),
      views: contract.views,
      naming: binding.naming,
      bodySignature: bodySignature(parsed.body),
      ...(binding.extensions === undefined ? {} : { extensions: binding.extensions }),
    };
  }
  const proposedProjection: DerivedProjection = {
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: proposedResolvedInput, sources: proposedDescriptors },
    managed: { base: proposedPolicy.base, templates: proposedTemplates, globalAxes: proposedTaxonomy.globalAxes },
    ...(projection?.extensions === undefined ? {} : { extensions: projection.extensions }),
  };
  const proposedProjectionBytes = manifestBytes(serializeDerivedProjection(proposedProjection));
  const proposed = makeSnapshot(
    proposedPolicy,
    manifestDigest(proposedPolicyBytes),
    manifestDigest(options.taxonomy.proposedBytes),
    obsidianFile.signature,
    proposedBindings,
    binding => requiredTransition(binding.templateId, binding.sourcePath, transitions).proposed,
    proposedResolvedInput,
  );
  const controls: TemplateCompositionManifest["controls"] = [
    {
      kind: "policy",
      path: policyPath,
      expectedCurrent: options.expected.controls.policy,
      current: policyFile,
      proposed: { state: "present", bytes: proposedPolicyBytes, signature: manifestDigest(proposedPolicyBytes) },
      action: sameManifestBytes(policyFile.bytes, proposedPolicyBytes) ? "verify-only" : "write",
    },
    {
      kind: "taxonomy",
      path: taxonomyPath,
      expectedCurrent: options.taxonomy.expectedCurrent,
      current: taxonomyFile,
      proposed: { state: "present", bytes: new Uint8Array(options.taxonomy.proposedBytes), signature: manifestDigest(options.taxonomy.proposedBytes) },
      action: options.taxonomy.action,
    },
    {
      kind: "projection",
      path: projectionPath,
      expectedCurrent: options.expected.controls.projection,
      current: projectionState,
      proposed: { state: "present", bytes: proposedProjectionBytes, signature: manifestDigest(proposedProjectionBytes) },
      action: projectionState.state === "present" && sameManifestBytes(projectionState.bytes, proposedProjectionBytes) ? "verify-only" : "write",
    },
  ];
  const affectedIds = new Set<string>();
  if (change.mode === "create") affectedIds.add(change.binding.templateId);
  else if (change.mode === "update") affectedIds.add(change.templateId);
  else if (change.mode === "reclassify") {
    if (currentPolicy.templates[change.templateId]?.destinationClass !== change.toClass) affectedIds.add(change.templateId);
  } else {
    for (const binding of proposedBindings) if (binding.destinationClass === "managed-default") affectedIds.add(binding.templateId);
  }
  const operations = proposedBindings
    .filter(binding => affectedIds.has(binding.templateId))
    .map(binding => {
      const source = requiredTransition(binding.templateId, binding.sourcePath, transitions);
      const proposedSource = source.proposed;
      if (proposedSource.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "operation source is absent");
      return {
        kind: change.mode,
        templateId: binding.templateId,
        destinationClass: binding.destinationClass,
        payloadDigest: proposedSource.signature,
        stableRelativeSuffix: null,
      };
    });
  const moves: TemplateMove[] = proposedBindings
    .filter(binding => {
      if (change.mode === "relocate-folder") return binding.destinationClass === "managed-default";
      const currentBinding = currentPolicy.templates[binding.templateId];
      return currentBinding !== undefined && currentBinding.sourcePath !== binding.sourcePath;
    })
    .map(binding => {
      const currentBinding = currentPolicy.templates[binding.templateId];
      if (currentBinding === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move binding is absent");
      const source = requiredSource(binding.templateId, currentSources.get(binding.templateId));
      const moveSource = source.state === "absent" && change.mode === "update" && change.moveStrategy === "register-already-moved"
        ? requiredTransition(binding.templateId, binding.sourcePath, transitions).proposed
        : source;
      if (moveSource.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move source is absent");
      const strategy: TemplateMove["strategy"] = currentBinding.sourcePath === binding.sourcePath
        ? "no-op"
        : change.mode === "update"
          ? change.moveStrategy ?? fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move strategy missing")
          : "oms-managed-rename";
      const move: TemplateMove = {
        templateId: binding.templateId,
        strategy,
        oldPath: currentBinding.sourcePath,
        newPath: binding.sourcePath,
        sourceSignature: moveSource.signature,
      };
      return move;
    })
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
  const outputs = [...controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })), ...transitions.filter(source => source.proposed.state === "present").map(source => ({ finalVaultRelativePath: source.path, payloadDigest: source.proposed.state === "present" ? source.proposed.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "output missing") }))];
  return { version: 1, mode: change.mode, current, proposed, controls, sources: transitions.sort((a,b) => a.templateId.localeCompare(b.templateId) || a.path.localeCompare(b.path)), operations, diagnostics: [], moves, outputs, approvalDigest: approvalDigest(proposed.inputDigest, operations, []), outputDigest: outputDigest(outputs) };
}
