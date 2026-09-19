import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadObsidianTypes } from "../contracts/index.js";
import { templateCensus, type CensusDiagnostic, type CensusPriorEntry } from "./census.js";
import { deriveContentFormatContract } from "./content-contract.js";
import { parseTemplate } from "./extract.js";
import { approvalDigest, inputDigest, outputDigest, templateInput } from "./canonical.js";
import { deriveTemplateSourcePath, normalizeTemplateFolderPath, normalizeTemplateSourcePath, validateTemplateId, verifyTemplateSourcePath } from "./paths.js";
import { applyTemplatePolicyChange, normalizeTemplateSemanticChange, parseDerivedProjection, parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "./policy.js";
import { classifyTemplateRenderer } from "./renderer.js";
import { templateMigrationAdmission } from "./transaction.js";
import type { BaseContract, DerivedProjection, Diagnostic, Digest, FieldPolicy, GlobalAxes, GlobalAxis, JsonValue, PendingTemplate, PendingTemplateKind, ResolvedConvention, ResolvedTemplate, SourceDescriptor, SourceTransition, TemplateBinding, TemplateCompositionManifest, TemplateCompositionOptions, TemplateFolderPath, TemplateMove, TemplatePolicy, TemplateRenderer, TemplateSemanticChange, TemplateSemanticSnapshot, TemplateSourcePath, VerifiedFileState } from "./types.js";

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
  ".oms/taxonomy.json",
] as const;

function sha256(value: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}
export interface ResolvedClassifiedTemplateSource {
  readonly sourcePath: TemplateSourcePath;
  readonly sourceDigest: Digest;
  readonly bom: boolean;
  readonly eol: "lf" | "crlf";
  readonly finalNewline: boolean;
  readonly keyOrder: readonly string[];
  readonly frontmatter: Readonly<Record<string, JsonValue>>;
  readonly body: string;
  readonly filledBy: readonly string[];
  readonly bodyExternal: boolean;
}

/**
 * Classifies and validates one source without executing renderer code.
 * Host-authored proposal paths are bounded to keep recursive discovery finite.
 */
export function resolveClassifiedTemplateSource(
  sourcePath: string,
  bytes: Uint8Array,
  requestedRenderer: TemplateRenderer,
): ResolvedClassifiedTemplateSource {
  const path = normalizeTemplateSourcePath(sourcePath);
  if (path.split("/").length > 16) fail("TEMPLATE_SOURCE_INVALID", `${path} exceeds the maximum source path depth of 16`);
  const classification = classifyTemplateRenderer(path, bytes);
  const fatal = classification.diagnostics.find(diagnostic =>
    diagnostic.code === "TEMPLATE_PROPOSAL_OVERSIZE"
    || diagnostic.code === "TEMPLATE_SOURCE_INVALID"
    || diagnostic.code === "TEMPLATE_EXPRESSION_UNSUPPORTED",
  );
  if (fatal !== undefined) fail(fatal.code, `${path}${fatal.field === undefined ? "" : `:${fatal.field}`}${fatal.message === undefined ? "" : `: ${fatal.message}`}`);
  if (classification.renderer !== requestedRenderer) {
    fail("TEMPLATE_SOURCE_INVALID", `${path} renderer ${classification.renderer} does not match requested renderer ${requestedRenderer}`);
  }
  if (requestedRenderer === "none") {
    const raw = Buffer.from(bytes).toString("utf8");
    return {
      sourcePath: path,
      sourceDigest: sha256(bytes),
      bom: raw.startsWith("\ufeff"),
      eol: raw.includes("\r\n") ? "crlf" : "lf",
      finalNewline: raw.endsWith("\n"),
      keyOrder: [],
      frontmatter: {},
      body: "",
      filledBy: [],
      bodyExternal: classification.bodyExternal,
    };
  }
  if (classification.template === undefined) fail("TEMPLATE_SOURCE_INVALID", `${path} has no observable template contract`);
  if (requestedRenderer === "templater") {
    const raw = Buffer.from(bytes).toString("utf8");
    const withoutExternalTags = raw.replace(/<%[\s\S]*?%>/g, "external");
    parseTemplate(path, new TextEncoder().encode(withoutExternalTags));
  }
  return {
    ...classification.template,
    filledBy: classification.filledBy,
    bodyExternal: classification.bodyExternal,
  };
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
function selectedFolderScanFailure(
  policy: TemplatePolicy,
  diagnostics: readonly CensusDiagnostic[],
): CensusDiagnostic | undefined {
  const selected = new Set<string>(policy.templateFolders.map(folder => folder.path));
  return diagnostics.find(item => {
    if (item.path === undefined || selected.has(item.path)) return true;
    if (
      item.code !== "TEMPLATE_FOLDER_INVALID"
      && item.code !== "TEMPLATE_SOURCE_UNSAFE"
      && item.code !== "TEMPLATE_SOURCE_READ_FAILED"
    ) return false;
    try {
      normalizeTemplateSourcePath(item.path);
      return false;
    } catch {
      return true;
    }
  });
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

/** Signature of the complete logical control authorities, excluding per-source template bytes. */
export function sharedAuthoritySignature(sources: readonly SourceDescriptor[]): Digest {
  return signature(sources.filter(source => source.logicalId !== undefined));
}

/** Validates the complete logical-control header before per-source freshness. */
export function projectionHeaderMatches(
  projection: DerivedProjection,
  controls: readonly SourceDescriptor[],
): boolean {
  const projectedControls = projection.generatedFrom.sources.filter(source => source.logicalId !== undefined);
  const currentById = new Map(controls.map(source => [source.logicalId!, source.signature]));
  const projectedById = new Map(projectedControls.map(source => [source.logicalId!, source.signature]));
  return projection.generatedFrom.sharedAuthoritySignature === sharedAuthoritySignature(controls)
    && sourceSignature(projection.generatedFrom.sources) === projection.generatedFrom.inputSignature
    && projectedControls.length === controls.length
    && projectedById.size === currentById.size
    && [...currentById].every(([logicalId, signature]) => projectedById.get(logicalId) === signature);
}

/**
 * Validates the projection's source identity shape against current policy
 * bindings. Managed projection entries never supply IDs: policy sourcePath
 * bindings are the only identity authority, while generated path descriptors
 * supply prior signatures with verification status for freshness and rename
 * confirmation.
 */
export function validatedProjectionPriorEntries(
  policy: import("./types.js").TemplatePolicy,
  projection: DerivedProjection,
): readonly CensusPriorEntry[] {
  const bindingsByPath = new Map<string, TemplateBinding>();
  const bindingsById = new Map<string, TemplateBinding>();
  for (const binding of Object.values(policy.templates)) {
    const path = deriveTemplateSourcePath(binding);
    if (bindingsByPath.has(path) || bindingsById.has(binding.templateId)) {
      fail("TEMPLATE_SOURCE_DUPLICATE", `policy template identity is duplicated for ${binding.templateId}`);
    }
    bindingsByPath.set(path, binding);
    bindingsById.set(binding.templateId, binding);
  }
  const pathDescriptors = projection.generatedFrom.sources.filter(source => source.path !== undefined);
  const prior: CensusPriorEntry[] = [];
  const seenPaths = new Set<string>();
  for (const source of pathDescriptors) {
    const path = normalizeTemplateSourcePath(source.path!);
    const binding = bindingsByPath.get(path);
    if (binding === undefined || seenPaths.has(path)) {
      fail("PROJECTION_INVALID", `generated projection source path ${path} is not a current policy binding`);
    }
    seenPaths.add(path);
    prior.push({
      sourcePath: path,
      templateId: binding.templateId,
      signature: binding.approvedSourceSignature ?? source.signature,
      signatureVerified: binding.approvedSourceSignature !== undefined
        && source.signature === binding.approvedSourceSignature,
      ...((binding.approvedBodySignature ?? binding.content?.bodySignature) === undefined
        ? {}
        : { bodySignature: binding.approvedBodySignature ?? binding.content?.bodySignature }),
    });
  }
  const managedIds = new Set<string>();
  for (const [id, template] of Object.entries(projection.managed.templates)) {
    const binding = bindingsById.get(id);
    if (
      binding === undefined
      || managedIds.has(id)
      || template.templateId !== id
      || template.sourcePath !== deriveTemplateSourcePath(binding)
      || !seenPaths.has(template.sourcePath)
    ) {
      fail("PROJECTION_INVALID", `managed projection identity does not match policy binding ${id}`);
    }
    managedIds.add(id);
  }
  return prior.sort((left, right) => compare(left.sourcePath, right.sourcePath));
}

function literalType(value: JsonValue): FieldPolicy["type"] | undefined {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? "date" : "text";
  return undefined;
}
function temporalTemplateExpression(value: JsonValue): "date" | "time" | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^{{(date|time)(?::.+)?}}$/.exec(value);
  return match?.[1] as "date" | "time" | undefined;
}
function literalCompatible(value: JsonValue, type: NonNullable<FieldPolicy["type"]>): boolean {
  if (value === null) return true;
  if (type === "number") return typeof value === "number";
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "list" || type === "multitext" || type === "multi" || type === "tags" || type === "aliases") return Array.isArray(value);
  if (type === "date") return temporalTemplateExpression(value) === "date" || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "datetime") return temporalTemplateExpression(value) !== undefined || typeof value === "string" && !Number.isNaN(Date.parse(value));
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
    const type = explicit ?? declared ?? (temporalTemplateExpression(values[key]!) === undefined ? literalType(values[key]!) : undefined);
    if (type === undefined) fail("TEMPLATE_TYPE_UNRESOLVED", `field ${key} has no type authority`);
    if (!literalCompatible(values[key]!, type)) fail("OBSIDIAN_TYPE_CONFLICT", `field ${key} template literal is incompatible with type ${type}`);
    result[key] = { ...baseField, ...policyField, type };
  }
  return result;
}

function rendererFields(
  base: BaseContract,
  fields: Readonly<Record<string, FieldPolicy>>,
  values: Readonly<Record<string, JsonValue>>,
  obsidian: Readonly<Record<string, FieldPolicy["type"]>>,
  filledBy: readonly string[],
): Readonly<Record<string, FieldPolicy>> {
  const external = new Set([
    ...filledBy,
    ...Object.entries(base.fields).filter(([, field]) => field.filledBy === "obsidian").map(([key]) => key),
    ...Object.entries(fields).filter(([, field]) => field.filledBy === "obsidian").map(([key]) => key),
  ]);
  const placeholder = (type: FieldPolicy["type"]): JsonValue => {
    if (type === "number") return 0;
    if (type === "boolean" || type === "checkbox") return false;
    if (type === "list" || type === "multitext" || type === "multi" || type === "tags" || type === "aliases") return [];
    if (type === "date") return "1970-01-01";
    if (type === "datetime") return "1970-01-01T00:00:00.000Z";
    return "";
  };
  const observable: Record<string, JsonValue> = Object.fromEntries(Object.entries(values).filter(([key]) => !external.has(key)));
  for (const key of external) observable[key] = placeholder(obsidian[key] ?? fields[key]?.type ?? base.fields[key]?.type);
  const resolved: Record<string, FieldPolicy> = { ...composeResolvedTemplateFields(base, fields, observable, obsidian) };
  for (const key of external) resolved[key] = { ...(resolved[key] ?? {}), ...(fields[key] ?? {}), filledBy: "obsidian" };
  return resolved;
}
function policyContractFields(
  base: BaseContract,
  fields: Readonly<Record<string, FieldPolicy>>,
  obsidian: Readonly<Record<string, FieldPolicy["type"]>>,
): Readonly<Record<string, FieldPolicy>> {
  return Object.fromEntries([...new Set([...Object.keys(base.fields), ...Object.keys(fields)])].map(key => {
    const baseField = base.fields[key] ?? {};
    const policyField = fields[key] ?? {};
    const declared = policyField.type ?? baseField.type;
    const explicit = obsidian[key];
    if (explicit !== undefined && declared !== undefined && explicit !== declared) fail("OBSIDIAN_TYPE_CONFLICT", `field ${key} has Obsidian type ${explicit} but policy type ${declared}`);
    const type = explicit ?? declared;
    if (type === undefined) fail("TEMPLATE_TYPE_UNRESOLVED", `field ${key} has no type authority`);
    return [key, { ...baseField, ...policyField, type }];
  }));
}
function bodySignature(body: string): Digest { return sha256(body); }
function contentContract(binding: TemplateBinding, source: ResolvedClassifiedTemplateSource) {
  return binding.content ?? deriveContentFormatContract(source.body, {
    templateId: binding.templateId,
    bom: source.bom,
    eol: source.eol,
    finalNewline: source.finalNewline,
  }).contract;
}
/**
 * Builds one derived managed projection entry from the current policy binding
 * and verified source bytes. This is the canonical field/body derivation used
 * by both the normal resolver and read-only review context.
 */
export function deriveManagedTemplateProjection(
  policy: import("./types.js").TemplatePolicy,
  binding: TemplateBinding,
  source: ResolvedClassifiedTemplateSource,
  obsidian: Readonly<Record<string, FieldPolicy["type"]>>,
  targetFolder?: TemplateFolderPath,
): DerivedProjection["managed"]["templates"][string] {
  const contract = policy.contracts[binding.contract];
  if (contract === undefined) fail("TEMPLATE_POLICY_DANGLING_FIELD", `template ${binding.templateId} references unknown contract ${binding.contract}`);
  const fields = binding.renderer === "none"
    ? policyContractFields(policy.base, contract.fields, obsidian)
    : rendererFields(policy.base, contract.fields, source.frontmatter, obsidian, source.filledBy);
  const content = contentContract(binding, source);
  return {
    templateId: binding.templateId,
    destinationClass: binding.destinationClass,
    renderer: binding.renderer,
    sourcePath: source.sourcePath,
    ...(targetFolder === undefined ? {} : { targetFolder }),
    keyOrder: source.keyOrder,
    fields,
    views: contract.views,
    naming: binding.naming,
    bodySignature: bodySignature(source.body),
    content,
  };
}
function managed(projection: DerivedProjection["managed"], templates: Readonly<Record<string, ResolvedTemplate>>): DerivedProjection["managed"] {
  return {
    base: projection.base,
    globalAxes: projection.globalAxes,
    templates: Object.fromEntries(Object.entries(templates).map(([id, template]) => [id, {
      templateId: template.id,
      destinationClass: template.destinationClass,
      renderer: template.renderer,
      sourcePath: template.sourcePath,
      ...(template.targetFolder === undefined ? {} : { targetFolder: template.targetFolder }),
      keyOrder: template.keyOrder,
      fields: template.fields,
      views: template.views,
      naming: template.naming,
      bodySignature: bodySignature(template.body),
      content: template.content,
    }])),
  };
}
function validateTaxonomy(path: string, bytes: Uint8Array): void {
  const root = jsonRecord(bytes, path);
  if (root === null) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be a JSON object`);
}
function jsonRecordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
function jsonRecord(bytes: Uint8Array, path: string): Readonly<Record<string, unknown>> | null {
  try { return jsonRecordValue(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown); }
  catch { fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be valid JSON`); }
}

export function deriveFolderOntologyAxis(rawFolders: unknown, where = "taxonomy.folders"): GlobalAxis | null {
  const folders = jsonRecordValue(rawFolders);
  if (rawFolders !== undefined && folders === null) fail("TEMPLATE_SOURCE_INVALID", `${where} must be a mapping`);
  const meanings = Object.entries(folders ?? {}).flatMap(([rawPath, raw]) => {
    const definition = jsonRecordValue(raw);
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

export interface TaxonomyRouting {
  readonly targetFolders: ReadonlyMap<string, TemplateFolderPath>;
  readonly globalAxes: GlobalAxes;
}

export function taxonomyRouting(path: string, bytes: Uint8Array): TaxonomyRouting {
  const root = jsonRecord(bytes, path);
  if (root === null) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be a JSON object`);
  const targetFolders = new Map<string, TemplateFolderPath>();
  const templates = jsonRecordValue(root.templates);
  if (root.templates !== undefined && templates === null) fail("TEMPLATE_SOURCE_INVALID", "taxonomy.templates must be a mapping");
  const definitionIds = new Set<string>();
  for (const [rawTemplateId, raw] of Object.entries(templates ?? {})) {
    let templateId: string;
    try {
      templateId = validateTemplateId(rawTemplateId);
    } catch {
      fail("TEMPLATE_SOURCE_INVALID", `taxonomy.templates.${rawTemplateId} must use a stable template ID`);
    }
    if (definitionIds.has(templateId)) fail("TEMPLATE_ID_DUPLICATE", `taxonomy.templates contains canonically equivalent template keys for ${templateId}`);
    definitionIds.add(templateId);
    const definition = jsonRecordValue(raw);
    if (definition === null || (definition.templateFolder !== undefined && typeof definition.templateFolder !== "string")) fail("TEMPLATE_SOURCE_INVALID", `taxonomy.templates.${rawTemplateId} has invalid placement`);
    if (typeof definition?.templateFolder === "string") targetFolders.set(templateId, normalizeTemplateFolderPath(definition.templateFolder));
  }
  const folders = jsonRecordValue(root.folders);
  for (const [folder, raw] of Object.entries(folders ?? {})) {
    const definition = jsonRecordValue(raw);
    if (definition?.templateFolder !== undefined && typeof definition.templateFolder !== "string") fail("TEMPLATE_SOURCE_INVALID", `taxonomy.folders.${folder}.templateFolder must be a string`);
    const rawTemplateId = typeof definition?.templateId === "string" ? definition.templateId : typeof definition?.template === "string" ? definition.template : undefined;
    const templateId = rawTemplateId === undefined ? undefined : (() => {
      try {
        return validateTemplateId(rawTemplateId);
      } catch {
        fail("TEMPLATE_SOURCE_INVALID", `taxonomy.folders.${folder} template reference must use a stable template ID`);
      }
    })();
    const targetFolder = typeof definition?.templateFolder === "string" ? definition.templateFolder : folder;
    if (templateId !== undefined) targetFolders.set(templateId, normalizeTemplateFolderPath(targetFolder));
    if (definition?.templates !== undefined) {
      if (!Array.isArray(definition.templates) || definition.templates.some(item => typeof item !== "string")) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) folders.${folder}.templates must contain template IDs`);
      for (const rawId of definition.templates as readonly string[]) {
        let id: string;
        try {
          id = validateTemplateId(rawId);
        } catch {
          fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) folders.${folder}.templates must contain stable template IDs`);
        }
        targetFolders.set(id, normalizeTemplateFolderPath(targetFolder));
      }
    }
  }
  const axes: Record<string, GlobalAxis> = {};
  const rawAxes = jsonRecordValue(root.globalAxes) ?? jsonRecordValue(root.axes) ?? {};
  for (const [name, raw] of Object.entries(rawAxes)) {
    const axis = jsonRecordValue(raw);
    if ((axis?.kind !== "folder" && axis?.kind !== "link") || typeof axis.key !== "string" || typeof axis.type !== "string" || !Array.isArray(axis.members)) continue;
    axes[name] = {
      kind: axis.kind,
      key: axis.key,
      type: axis.type as GlobalAxis["type"],
      ...(typeof axis.intent === "string" ? { intent: axis.intent } : {}),
      members: axis.members as readonly JsonValue[],
      ...(axis.extensions !== undefined && jsonRecordValue(axis.extensions) !== null ? { extensions: axis.extensions as GlobalAxis["extensions"] } : {}),
    };
  }
  const folderOntology = deriveFolderOntologyAxis(root.folders, `${path}.folders`);
  if (folderOntology !== null) {
    if (Object.hasOwn(axes, "folder-ontology")) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) globalAxes.folder-ontology is reserved`);
    axes["folder-ontology"] = folderOntology;
  }
  return { targetFolders, globalAxes: axes };
}

export function requireTaxonomyPlacement(routing: TaxonomyRouting, templateId: string): TemplateFolderPath {
  const targetFolder = routing.targetFolders.get(templateId);
  if (targetFolder === undefined) {
    fail("TEMPLATE_PLACEMENT_UNDECLARED", `taxonomy placement is undeclared for template ${templateId}`);
  }
  return targetFolder;
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
  const taxonomyFile = options.taxonomyPath ?? ".oms/taxonomy.json";
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
  const descriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: policyRaw.signature },
    { logicalId: "taxonomy", signature: taxonomyRaw.signature },
    { logicalId: "obsidian-types", signature: obsidianRaw.signature },
  ];
  if (sharedAuthoritySignature(descriptors) !== projection.generatedFrom.sharedAuthoritySignature) {
    fail("TEMPLATE_SOURCE_DRIFT", "shared template authorities changed; the projection is stale for the whole vault");
  }
  if (!projectionHeaderMatches(projection, descriptors)) {
    fail("TEMPLATE_SOURCE_DRIFT", "generated projection control authorities do not match current vault sources");
  }

  const prior = validatedProjectionPriorEntries(policy, projection);
  const census = await templateCensus(root, policy, prior);
  const scopeFailure = selectedFolderScanFailure(policy, census.diagnostics);
  if (scopeFailure !== undefined) {
    fail("TEMPLATE_REVIEW_REQUIRED", "template review is required before publishing while a selected template scope cannot be scanned");
  }
  const censusEntries = new Map(census.entries.map(entry => [entry.sourcePath, entry]));
  const bindingByPath = new Map(bindings.map(binding => [deriveTemplateSourcePath(binding), binding]));
  const pending: Record<string, PendingTemplate> = {};
  const addPending = (
    id: import("./types.js").TemplateId | undefined,
    path: TemplateSourcePath,
    kind: PendingTemplateKind,
    diagnostics: readonly Diagnostic[],
    oldPath?: TemplateSourcePath,
    newPath?: TemplateSourcePath,
  ): void => {
    const key = id !== undefined && pending[id] === undefined ? id : path;
    const previous = pending[key];
    pending[key] = {
      ...(id === undefined ? {} : { id }),
      path,
      kind: previous?.kind ?? kind,
      diagnostics: [...(previous?.diagnostics ?? []), ...diagnostics],
      ...(oldPath === undefined ? {} : { oldPath }),
      ...(newPath === undefined ? {} : { newPath }),
    };
  };
  const censusDiagnostic = (item: CensusDiagnostic): Diagnostic => ({
    code: "TEMPLATE_SOURCE_INVALID",
    ...(item.path === undefined ? {} : { path: item.path }),
    ...(item.templateId === undefined ? {} : { templateId: item.templateId }),
    message: `${item.code}: ${item.message}`,
  });
  for (const item of census.diagnostics) {
    if (item.path === undefined) continue;
    let path: TemplateSourcePath;
    try { path = normalizeTemplateSourcePath(item.path); } catch { continue; }
    const entry = censusEntries.get(path);
    const binding = bindingByPath.get(path);
    addPending(binding?.templateId ?? entry?.templateId, path, "invalid", [censusDiagnostic(item)]);
  }
  const diffPending = new Set<string>();
  for (const diff of census.diffs) {
    if (diff.kind === "edited" || diff.kind === "added" || diff.kind === "deleted") {
      const path = diff.sourcePath;
      const binding = bindingByPath.get(path);
      const id = binding?.templateId ?? diff.templateId;
      addPending(id, path, diff.kind, []);
      diffPending.add(path);
      continue;
    }
    if (diff.kind === "renamed") {
      const currentPath = diff.newSourcePath ?? diff.sourcePath;
      const oldPath = diff.oldSourcePath;
      if (!bindingByPath.has(currentPath) || diff.confirmationRequired) {
        addPending(diff.templateId, currentPath, "renamed", [], oldPath, currentPath);
        if (diff.confirmationRequired) diffPending.add(currentPath);
      }
    }
  }
  for (const entry of census.entries) {
    if (bindingByPath.has(entry.sourcePath)) continue;
    addPending(entry.templateId, entry.sourcePath, "added", entry.diagnostics.map(censusDiagnostic));
  }
  const sourcePaths = [...new Set([
    ...bindings.map(binding => deriveTemplateSourcePath(binding)),
    ...census.entries.map(entry => entry.sourcePath),
  ])].sort((a, b) => a.localeCompare(b)) as TemplateSourcePath[];
  for (const extra of options.sourcePaths ?? []) {
    const normalized = normalizeTemplateSourcePath(extra);
    if (!sourcePaths.includes(normalized)) fail("TEMPLATE_SOURCE_INVALID", `explicit source ${normalized} is outside the selected template scope`);
  }

  const freshBindings: TemplateBinding[] = [];
  const extracted = new Map<string, ResolvedClassifiedTemplateSource>();
  const resolvedContent = new Map<string, ReturnType<typeof contentContract>>();
  const projectionSources = new Map(projection.generatedFrom.sources.flatMap(source => source.path === undefined ? [] : [[source.path, source.signature] as const]));
  for (const binding of bindings) {
    const path = deriveTemplateSourcePath(binding);
    const entry = censusEntries.get(path);
    const projectedSignature = projectionSources.get(path);
    if (entry === undefined) {
      if (!pending[binding.templateId]) addPending(binding.templateId, path, "deleted", []);
      continue;
    }
    const approvedSignatureMismatch = binding.approvedSourceSignature !== undefined
      && binding.approvedSourceSignature !== entry.signature;
    if (
      entry.diagnostics.length > 0
      || diffPending.has(path)
      || projectedSignature === undefined
      || projectedSignature !== entry.signature
      || approvedSignatureMismatch
    ) {
      if (!pending[binding.templateId]) {
        addPending(
          binding.templateId,
          path,
          projectedSignature === undefined ? "invalid" : "edited",
          [
            ...entry.diagnostics.map(censusDiagnostic),
            ...(approvedSignatureMismatch ? [{
              code: "TEMPLATE_SOURCE_DRIFT" as const,
              path,
              templateId: binding.templateId,
              message: "approved source signature does not match the current source",
            }] : []),
          ],
        );
      }
      continue;
    }
    try {
      const resolved = resolveClassifiedTemplateSource(path, entry.bytes, binding.renderer);
      const content = contentContract(binding, resolved);
      if (content.bodySignature !== bodySignature(resolved.body)) {
        addPending(binding.templateId, path, "invalid", [{
          code: "TEMPLATE_SOURCE_INVALID",
          path,
          templateId: binding.templateId,
          message: "approved content contract bodySignature does not match the current source body",
        }]);
        continue;
      }
      extracted.set(binding.templateId, resolved);
      resolvedContent.set(binding.templateId, content);
      freshBindings.push(binding);
    } catch (error: unknown) {
      addPending(binding.templateId, path, "invalid", [{
        code: "TEMPLATE_SOURCE_INVALID",
        path,
        templateId: binding.templateId,
        message: error instanceof Error ? error.message : String(error),
      }]);
    }
  }
  const freshDescriptors: SourceDescriptor[] = [
    ...descriptors,
    ...freshBindings.map(binding => {
      const template = extracted.get(binding.templateId);
      if (template === undefined) fail("TEMPLATE_SOURCE_INVALID", `fresh source is missing for ${binding.templateId}`);
      return { path: template.sourcePath, signature: template.sourceDigest };
    }),
  ];
  const actualInput = sourceSignature(freshDescriptors);
  const templates: Record<string, ResolvedTemplate> = {};
  for (const binding of freshBindings) {
    const template = extracted.get(binding.templateId);
    const content = resolvedContent.get(binding.templateId);
    if (template === undefined || content === undefined) continue;
    const projected = deriveManagedTemplateProjection(
      policy,
      binding,
      template,
      obsidian.types,
      taxonomy.targetFolders.get(binding.templateId),
    );
    templates[binding.templateId] = {
      id: binding.templateId,
      destinationClass: binding.destinationClass,
      renderer: binding.renderer,
      sourcePath: template.sourcePath,
      ...(projected.targetFolder === undefined ? {} : { targetFolder: projected.targetFolder }),
      bom: template.bom,
      eol: template.eol,
      finalNewline: template.finalNewline,
      keyOrder: template.keyOrder,
      fields: projected.fields,
      frontmatterTemplate: template.frontmatter,
      body: template.body,
      content,
      naming: binding.naming,
      views: projected.views,
      inputSignature: actualInput,
      templateSignature: template.sourceDigest,
      managedSourcePaths: sourcePaths,
    };
  }
  const expected = managed({ base: policy.base, globalAxes: taxonomy.globalAxes, templates: {} }, templates);
  const storedFresh = {
    base: projection.managed.base,
    globalAxes: projection.managed.globalAxes,
    templates: Object.fromEntries(Object.keys(templates).flatMap(id => {
      const stored = projection.managed.templates[id];
      return stored === undefined ? [] : [[id, stored] as const];
    })),
  };
  if (!isDeepStrictEqual(expected, storedFresh)) fail("PROJECTION_PAYLOAD_TAMPERED", "managed projection does not equal the canonical resolved template projection");
  return {
    base: policy.base,
    templates: Object.fromEntries(Object.entries(templates).sort(([a], [b]) => a.localeCompare(b))),
    pending: Object.fromEntries(Object.entries(pending).sort(([a], [b]) => a.localeCompare(b))),
    ...(policy.defaultTemplate === undefined ? {} : { defaultTemplate: policy.defaultTemplate }),
    globalAxes: taxonomy.globalAxes,
    ...(policy.writers === undefined ? {} : { writers: policy.writers }),
    managedSourcePaths: sourcePaths,
    inputSignature: actualInput,
    sharedAuthoritySignature: sharedAuthoritySignature(descriptors),
  };
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

type GuardedTemplateChange = Exclude<TemplateSemanticChange, { readonly mode: "reconcile" }>;

function pendingBelongsToChange(
  pending: PendingTemplate,
  change: GuardedTemplateChange,
  currentPolicy: TemplatePolicy,
): boolean {
  if (change.mode !== "create" && change.mode !== "update") return false;
  const templateId = change.mode === "create" ? change.binding.templateId : change.templateId;
  const paths = new Set<string>([
    change.source.path,
    deriveTemplateSourcePath(change.binding),
  ]);
  const currentBinding = currentPolicy.templates[templateId];
  if (currentBinding !== undefined) paths.add(deriveTemplateSourcePath(currentBinding));
  return [pending.path, pending.oldPath, pending.newPath]
    .some(path => path !== undefined && paths.has(path));
}

/** Rejects unrelated source drift before a guarded operation can rederive controls. */
export function assertNoUnexpectedTemplatePending(
  resolved: ResolvedConvention,
  change: GuardedTemplateChange,
  currentPolicy: TemplatePolicy,
): void {
  const unexpected = Object.values(resolved.pending).find(item => !pendingBelongsToChange(item, change, currentPolicy));
  if (unexpected !== undefined) {
    fail(
      "TEMPLATE_REVIEW_REQUIRED",
      `template review is required before ${change.mode}; pending source ${unexpected.path} must be confirmed`,
    );
  }
}

async function authorSourceSignature(
  vault: string,
  change: GuardedTemplateChange,
): Promise<GuardedTemplateChange> {
  if (change.mode !== "create" && change.mode !== "update") return change;
  if (change.mode === "create" && change.source.publication === "verify-existing") return change;
  const capturedBytes = new Uint8Array(change.source.bytes);
  if (change.source.publication === "verify-existing") {
    const existing = await manifestSourceFile(vault, change.source.path);
    if (existing.state !== "present") {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source is absent for ${change.binding.templateId}`);
    }
    if (!sameManifestBytes(existing.bytes, capturedBytes)) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source does not match for ${change.binding.templateId}`);
    }
  }
  const classified = resolveClassifiedTemplateSource(change.source.path, capturedBytes, change.binding.renderer);
  return {
    ...change,
    source: { ...change.source, bytes: capturedBytes },
    binding: {
      ...change.binding,
      approvedSourceSignature: manifestDigest(capturedBytes),
      approvedBodySignature: bodySignature(classified.body),
    },
  };
}

/** Builds semantic publication data. It does not publish or reinterpret its manifest. */
export async function buildTemplateCompositionManifest(
  vault: string,
  requestedChange: GuardedTemplateChange,
  options: TemplateCompositionOptions,
): Promise<TemplateCompositionManifest> {
  const normalizedChange = normalizeTemplateSemanticChange(requestedChange) as GuardedTemplateChange;
  const change = await authorSourceSignature(vault, normalizedChange);
  if (change.mode === "create" && change.source.publication === "verify-existing") {
    fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "create source publication must be write");
  }
  const policyPath = ".oms/template-policy.json";
  const taxonomyPath = ".oms/taxonomy.json";
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
  if (
    !matchExpectation(policyFile, options.expected.controls.policy) ||
    !matchExpectation(taxonomyFile, options.expected.controls.taxonomy) ||
    !matchExpectation(taxonomyFile, options.taxonomy.expectedCurrent) ||
    !matchExpectation(projectionState, options.expected.controls.projection)
  ) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "control CAS does not match");
  if (jsonRecord(options.taxonomy.proposedBytes, taxonomyPath) === null || (options.taxonomy.action === "verify-only" && !sameManifestBytes(taxonomyFile.bytes, options.taxonomy.proposedBytes))) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "taxonomy proposal is invalid");
  const currentPolicy = parseTemplatePolicy(new TextDecoder().decode(policyFile.bytes));
  assertNoUnexpectedTemplatePending(await loadResolvedTemplates(vault), change, currentPolicy);
  const proposedPolicy = applyTemplatePolicyChange(currentPolicy, change);
  const proposedTaxonomy = taxonomyRouting(taxonomyPath, options.taxonomy.proposedBytes);
  let projection: DerivedProjection | undefined;
  if (projectionState.state === "present") {
    projection = parseDerivedProjection(new TextDecoder().decode(projectionState.bytes));
  } else {
    fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `${projectionPath} must exist`);
  }
  const obsidian = await loadObsidianTypes(vault);
  if (obsidian === null) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `${obsidianPath} must exist`);
  const proposedPolicyBytes = manifestBytes(serializeTemplatePolicy(proposedPolicy));
  const currentBindings = Object.values(currentPolicy.templates).sort((a,b) => a.templateId.localeCompare(b.templateId));
  const proposedBindings = Object.values(proposedPolicy.templates).sort((a,b) => a.templateId.localeCompare(b.templateId));
  const currentSources = new Map<string, VerifiedFileState>();
  for (const binding of currentBindings) currentSources.set(binding.templateId, await manifestSourceFile(vault, deriveTemplateSourcePath(binding)));
  for (const source of options.expected.sources) {
    const templateId = validateTemplateId(source.templateId);
    const binding = currentPolicy.templates[templateId];
    const current = requiredSource(templateId, currentSources.get(templateId));
    if (binding === undefined || deriveTemplateSourcePath(binding) !== source.path || !matchExpectation(current, source.expected)) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source CAS does not match");
    }
  }
  const transitions: import("./types.js").SourceTransition[] = [];
  for (const binding of proposedBindings) {
    const old = currentPolicy.templates[binding.templateId];
    const bindingSourcePath = deriveTemplateSourcePath(binding);
    const proposal = (change.mode === "create" || change.mode === "update") && change.binding.templateId === binding.templateId ? change.source : undefined;
    if (proposal !== undefined && proposal.path !== bindingSourcePath) {
      fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `source proposal path differs for ${binding.templateId}`);
    }
    if (old !== undefined && deriveTemplateSourcePath(old) !== bindingSourcePath) {
      const oldSourcePath = deriveTemplateSourcePath(old);
      const oldState = requiredSource(binding.templateId, currentSources.get(binding.templateId));
      const newState = await manifestSourceFile(vault, bindingSourcePath);
      if (change.mode === "update" && change.moveStrategy === "register-already-moved") {
        if (oldState.state !== "absent" || newState.state !== "present" || proposal === undefined || proposal.publication !== "verify-existing" || !sameManifestBytes(newState.bytes, proposal.bytes)) {
          fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `registered source does not match for ${binding.templateId}`);
        }
        transitions.push({ templateId: binding.templateId, path: oldSourcePath, expectedCurrent: { state: "absent" }, current: oldState, proposed: { state: "absent" }, action: "verify-only" });
        transitions.push({ templateId: binding.templateId, path: bindingSourcePath, expectedCurrent: { state: "present", signature: newState.signature }, current: newState, proposed: newState, action: "verify-only" });
      } else {
        if (oldState.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `old source is absent for ${binding.templateId}`);
        if (newState.state !== "absent") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `new source collides for ${binding.templateId}`);
        const proposed = proposal === undefined
          ? { state: "present" as const, bytes: new Uint8Array(oldState.bytes), signature: oldState.signature }
          : { state: "present" as const, bytes: new Uint8Array(proposal.bytes), signature: manifestDigest(proposal.bytes) };
        transitions.push({ templateId: binding.templateId, path: bindingSourcePath, expectedCurrent: { state: "absent" }, current: newState, proposed, action: "write" });
        transitions.push({ templateId: binding.templateId, path: oldSourcePath, expectedCurrent: { state: "present", signature: oldState.signature }, current: oldState, proposed: { state: "absent" }, action: "delete" });
      }
      continue;
    }
    const current: VerifiedFileState = old === undefined
      ? await manifestSourceFile(vault, bindingSourcePath)
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
    transitions.push({ templateId: binding.templateId, path: bindingSourcePath, expectedCurrent: current.state === "present" ? { state: "present", signature: current.signature } : { state: "absent" }, current, proposed, action: proposal === undefined || proposal.publication === "verify-existing" ? "verify-only" : "write" });
  }
  if (change.mode === "remove") {
    const removed = currentPolicy.templates[change.templateId];
    if (removed === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "removed binding is absent");
    const removedPath = deriveTemplateSourcePath(removed);
    const current = requiredSource(removed.templateId, currentSources.get(removed.templateId));
    if (current.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "removed source is absent");
    transitions.push({
      templateId: removed.templateId,
      path: removedPath,
      expectedCurrent: { state: "present", signature: current.signature },
      current,
      proposed: change.deleteSource ? { state: "absent" } : current,
      action: change.deleteSource ? "delete" : "verify-only",
    });
  }
  const makeSnapshot = (policy: import("./types.js").TemplatePolicy, policyDigest: Digest, taxonomyDigest: Digest, obsidianDigest: Digest, bindings: readonly import("./types.js").TemplateBinding[], sourceState: (binding: import("./types.js").TemplateBinding) => VerifiedFileState, resolvedInputSignature: Digest): TemplateSemanticSnapshot => {
    const input = templateInput(policy, { policy: policyDigest, taxonomy: taxonomyDigest, obsidianTypes: obsidianDigest, obsidianTypesPath: obsidianPath }, bindings, (binding) => {
      const source = sourceState(binding);
      return source.state === "present" ? source.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source absent");
    });
    return { input, inputDigest: inputDigest(input), bindings, resolvedTemplates: bindings.map(binding => { const source = sourceState(binding); return { templateId: binding.templateId, sourcePath: deriveTemplateSourcePath(binding), inputSignature: resolvedInputSignature, templateSignature: source.state === "present" ? source.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "source absent") }; }) };
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
        return requiredTransition(binding.templateId, deriveTemplateSourcePath(change.binding), transitions).proposed;
      }
      return source;
    },
    projection?.generatedFrom.inputSignature ?? options.expected.input,
  );
  if (current.inputDigest !== options.expected.input) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "input CAS does not match");
  const proposedSourceStates = new Map(proposedBindings.map(binding => [binding.templateId, requiredTransition(binding.templateId, deriveTemplateSourcePath(binding), transitions).proposed]));
  const proposedDescriptors: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: manifestDigest(proposedPolicyBytes) },
    { logicalId: "taxonomy", signature: manifestDigest(options.taxonomy.proposedBytes) },
    { logicalId: "obsidian-types", signature: obsidianFile.signature },
    ...proposedBindings.map(binding => {
      const source = requiredSource(binding.templateId, proposedSourceStates.get(binding.templateId));
      if (source.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `proposed source is absent for ${binding.templateId}`);
      return { path: deriveTemplateSourcePath(binding), signature: source.signature };
    }),
  ];
  const proposedResolvedInput = signature(proposedDescriptors);
  const proposedTemplates: Record<string, DerivedProjection["managed"]["templates"][string]> = {};
  for (const binding of proposedBindings) {
    const source = requiredSource(binding.templateId, proposedSourceStates.get(binding.templateId));
    if (source.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", `proposed source is absent for ${binding.templateId}`);
    const bindingSourcePath = deriveTemplateSourcePath(binding);
    const parsed = resolveClassifiedTemplateSource(bindingSourcePath, source.bytes, binding.renderer);
    proposedTemplates[binding.templateId] = {
      ...deriveManagedTemplateProjection(
        proposedPolicy,
        binding,
        parsed,
        obsidian.types,
        proposedTaxonomy.targetFolders.get(binding.templateId),
      ),
      ...(binding.extensions === undefined ? {} : { extensions: binding.extensions }),
    };
  }
  const proposedProjection: DerivedProjection = {
    version: "oms.types.v1",
    generatedFrom: {
      algorithm: "sha256-lp-v1",
      inputSignature: proposedResolvedInput,
      sharedAuthoritySignature: sharedAuthoritySignature(proposedDescriptors),
      sources: proposedDescriptors,
    },
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
    binding => requiredTransition(binding.templateId, deriveTemplateSourcePath(binding), transitions).proposed,
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
  else if (change.mode === "remove" || change.mode === "default") affectedIds.add(change.templateId);
  else if (change.mode === "reclassify") {
    if (currentPolicy.templates[change.templateId]?.destinationClass !== change.toClass) affectedIds.add(change.templateId);
  } else if (change.mode === "relocate-folder") {
    for (const binding of proposedBindings) if (binding.destinationClass === "managed-default") affectedIds.add(binding.templateId);
  }
  const operationBindings = change.mode === "remove"
    ? [currentPolicy.templates[change.templateId]!]
    : proposedBindings.filter(binding => affectedIds.has(binding.templateId));
  const operations = operationBindings.map(binding => {
      const source = requiredTransition(binding.templateId, deriveTemplateSourcePath(binding), transitions);
      const operationSource = source.proposed.state === "present" ? source.proposed : source.current;
      if (operationSource.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "operation source is absent");
      return {
        kind: change.mode,
        templateId: binding.templateId,
        destinationClass: binding.destinationClass,
        payloadDigest: operationSource.signature,
        stableRelativeSuffix: null,
      };
    });
  const moves: TemplateMove[] = proposedBindings
    .filter(binding => {
      if (change.mode === "relocate-folder") return binding.destinationClass === "managed-default";
      const currentBinding = currentPolicy.templates[binding.templateId];
      return currentBinding !== undefined && deriveTemplateSourcePath(currentBinding) !== deriveTemplateSourcePath(binding);
    })
    .map(binding => {
      const currentBinding = currentPolicy.templates[binding.templateId];
      if (currentBinding === undefined) fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move binding is absent");
      const source = requiredSource(binding.templateId, currentSources.get(binding.templateId));
      const moveSource = source.state === "absent" && change.mode === "update" && change.moveStrategy === "register-already-moved"
        ? requiredTransition(binding.templateId, deriveTemplateSourcePath(binding), transitions).proposed
        : source;
      if (moveSource.state !== "present") fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move source is absent");
      const currentSourcePath = deriveTemplateSourcePath(currentBinding);
      const bindingSourcePath = deriveTemplateSourcePath(binding);
      const strategy: TemplateMove["strategy"] = currentSourcePath === bindingSourcePath
        ? "no-op"
        : change.mode === "update"
          ? change.moveStrategy ?? fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "move strategy missing")
          : "oms-managed-rename";
      const move: TemplateMove = {
        templateId: binding.templateId,
        strategy,
        oldPath: currentSourcePath,
        newPath: bindingSourcePath,
        sourceSignature: moveSource.signature,
      };
      return move;
    })
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
  const outputs = [...controls.map(control => ({ finalVaultRelativePath: control.path, payloadDigest: control.proposed.signature })), ...transitions.filter(source => source.proposed.state === "present").map(source => ({ finalVaultRelativePath: source.path, payloadDigest: source.proposed.state === "present" ? source.proposed.signature : fail("TEMPLATE_TRANSACTION_MANIFEST_INVALID", "output missing") }))];
  return { version: 1, mode: change.mode, current, proposed, controls, sources: transitions.sort((a,b) => a.templateId.localeCompare(b.templateId) || a.path.localeCompare(b.path)), operations, diagnostics: [], moves, outputs, approvalDigest: approvalDigest(proposed.inputDigest, operations, [], { current, controls, sources: transitions }), outputDigest: outputDigest(outputs) };
}
