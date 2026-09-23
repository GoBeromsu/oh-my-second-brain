import { readFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseObsidianTypes } from "../contracts/index.js";
import type { TemplateRetrievalSource } from "./axes.js";
import { digestBytes, hashCanonical } from "./canonical.js";
import { composeTemplateContract } from "./defaults.js";
import { parseDerivedProjection, parseTemplatePolicy, validateDerivedProjection } from "./policy.js";
import {
  normalizeTemplateControlPath,
  normalizeTemplateFolderPath,
  validateTemplateId,
  verifyManagedTemplatePath,
  verifyTemplateControlPath,
  verifyTemplateSourcePath,
} from "./paths.js";
import { inspectTemplateTransactionMarker, TEMPLATE_TRANSACTION_MARKER_PATH } from "./transaction.js";
import type {
  DerivedProjection,
  DerivedTemplateProjection,
  Diagnostic,
  Digest,
  GlobalAxes,
  GlobalAxis,
  HeadingContract,
  JsonValue,
  ManagedDraftFreshness,
  ManagedTemplatePath,
  ObsidianContractType,
  ResolvedContract,
  ResolvedField,
  ResolvedHeading,
  SourceFreshness,
  TemplateFolderPath,
  TemplateId,
  TemplatePolicy,
  TemplateSourceRef,
} from "./types.js";

/**
 * Read-only view of an approved version 4 vault.
 * Policy bytes are the contract authority. A drifted source or managed draft
 * stays a local diagnostic and does not replace the approved markdown.
 * The derived projection is checked, not trusted as a second authority.
 */

const POLICY_PATH = ".oms/template-policy.json";
const TAXONOMY_PATH = ".oms/taxonomy.json";
const PROJECTION_PATH = ".oms/types.json";
const OBSIDIAN_PATH = ".obsidian/types.json";
export interface ControlByteRead {
  readonly policy: Uint8Array | null;
  readonly taxonomy: Uint8Array | null;
  readonly projection: Uint8Array | null;
  readonly marker: Uint8Array | null;
}

export interface ExactControlBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: Digest;
}

export interface ResolvedTemplateSnapshot {
  readonly vault: string;
  readonly policy: TemplatePolicy;
  readonly defaultContract: ResolvedContract;
  readonly templates: Readonly<Record<string, ResolvedContract>>;
  readonly placement: Readonly<Record<string, TemplateFolderPath>>;
  readonly globalAxes: GlobalAxes;
  readonly generationDigest: Digest;
  readonly projection: DerivedProjection;
  readonly controls: {
    readonly policy: ExactControlBytes;
    readonly taxonomy: ExactControlBytes;
    readonly projection: ExactControlBytes;
    readonly marker: ExactControlBytes | null;
    readonly obsidianTypes: ExactControlBytes | null;
  };
  readonly obsidianTypes: Readonly<Record<string, ObsidianContractType>> | null;
  readonly sources: readonly SourceFreshness[];
  readonly drafts: readonly ManagedDraftFreshness[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface TaxonomyRouting {
  readonly targetFolders: ReadonlyMap<string, TemplateFolderPath>;
  readonly globalAxes: GlobalAxes;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decode(bytes: Uint8Array, code: string, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, message);
  }
}

function jsonRecordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function jsonRecord(bytes: Uint8Array, path: string): Readonly<Record<string, unknown>> | null {
  try {
    return jsonRecordValue(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be valid JSON`);
  }
}

function taxonomyId(value: string, message: string): string {
  try {
    return validateTemplateId(value);
  } catch {
    fail("TEMPLATE_SOURCE_INVALID", message);
  }
}

function canonicalIntent(value: string): string {
  return value.normalize("NFC").trim();
}

export function deriveFolderOntologyAxis(rawFolders: unknown, where = "taxonomy.folders"): GlobalAxis | null {
  const folders = jsonRecordValue(rawFolders);
  if (rawFolders !== undefined && folders === null) fail("TEMPLATE_SOURCE_INVALID", `${where} must be a mapping`);
  const meanings = Object.entries(folders ?? {}).flatMap(([rawPath, raw]) => {
    const definition = jsonRecordValue(raw);
    if (definition === null) fail("TEMPLATE_SOURCE_INVALID", `${where}.${rawPath} must be a mapping`);
    if (definition.intent === undefined) return [];
    if (typeof definition.intent !== "string" || canonicalIntent(definition.intent).length === 0) {
      fail("TEMPLATE_SOURCE_INVALID", `${where}.${rawPath}.intent must be a non-empty string`);
    }
    return [{ path: normalizeTemplateFolderPath(rawPath), intent: canonicalIntent(definition.intent) }];
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

export function taxonomyRouting(path: string, bytes: Uint8Array): TaxonomyRouting {
  const root = jsonRecord(bytes, path);
  if (root === null) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) must be a JSON object`);
  const targetFolders = new Map<string, TemplateFolderPath>();
  const templates = jsonRecordValue(root.templates);
  if (root.templates !== undefined && templates === null) fail("TEMPLATE_SOURCE_INVALID", "taxonomy.templates must be a mapping");
  const definitionIds = new Set<string>();
  for (const [rawTemplateId, raw] of Object.entries(templates ?? {})) {
    const templateId = taxonomyId(rawTemplateId, `taxonomy.templates.${rawTemplateId} must use a stable template ID`);
    if (definitionIds.has(templateId)) fail("TEMPLATE_ID_DUPLICATE", `taxonomy.templates contains canonically equivalent template keys for ${templateId}`);
    definitionIds.add(templateId);
    const definition = jsonRecordValue(raw);
    if (definition === null || (definition.templateFolder !== undefined && typeof definition.templateFolder !== "string")) {
      fail("TEMPLATE_SOURCE_INVALID", `taxonomy.templates.${rawTemplateId} has invalid placement`);
    }
    if (typeof definition.templateFolder === "string") targetFolders.set(templateId, normalizeTemplateFolderPath(definition.templateFolder));
  }
  const folders = jsonRecordValue(root.folders);
  for (const [folder, raw] of Object.entries(folders ?? {})) {
    const definition = jsonRecordValue(raw);
    if (definition?.templateFolder !== undefined && typeof definition.templateFolder !== "string") {
      fail("TEMPLATE_SOURCE_INVALID", `taxonomy.folders.${folder}.templateFolder must be a string`);
    }
    const rawTemplateId = typeof definition?.templateId === "string"
      ? definition.templateId
      : typeof definition?.template === "string"
        ? definition.template
        : undefined;
    const templateId = rawTemplateId === undefined
      ? undefined
      : taxonomyId(rawTemplateId, `taxonomy.folders.${folder} template reference must use a stable template ID`);
    const targetFolder = typeof definition?.templateFolder === "string" ? definition.templateFolder : folder;
    if (templateId !== undefined) targetFolders.set(templateId, normalizeTemplateFolderPath(targetFolder));
    if (definition?.templates !== undefined) {
      const listed = definition.templates;
      if (!Array.isArray(listed)) fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) folders.${folder}.templates must contain template IDs`);
      for (const rawId of listed) {
        if (typeof rawId !== "string") fail("TEMPLATE_SOURCE_INVALID", `taxonomy (${path}) folders.${folder}.templates must contain template IDs`);
        const id = taxonomyId(rawId, `taxonomy (${path}) folders.${folder}.templates must contain stable template IDs`);
        targetFolders.set(id, normalizeTemplateFolderPath(targetFolder));
      }
    }
  }
  const axes: Record<string, GlobalAxis> = {};
  const rawAxes = jsonRecordValue(root.globalAxes) ?? jsonRecordValue(root.axes) ?? {};
  for (const [name, raw] of Object.entries(rawAxes)) {
    const axis = jsonRecordValue(raw);
    const kind = axis?.kind === "folder" || axis?.kind === "link" ? axis.kind : null;
    if (axis === null || kind === null || typeof axis.key !== "string" || typeof axis.type !== "string" || !Array.isArray(axis.members)) continue;
    axes[name] = {
      kind,
      key: axis.key,
      type: axis.type as GlobalAxis["type"],
      ...(typeof axis.intent === "string" ? { intent: canonicalIntent(axis.intent) } : {}),
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
  if (targetFolder === undefined) fail("TEMPLATE_PLACEMENT_UNDECLARED", `taxonomy placement is undeclared for template ${templateId}`);
  return targetFolder;
}

function placementFor(routing: TaxonomyRouting, templateId: string): JsonValue | null {
  const folder = routing.targetFolders.get(templateId);
  return folder === undefined ? null : { templateFolder: folder };
}

/**
 * Pure contract composition shared by the approved snapshot reader and search.
 * Placement is only `placementFor`. Field records stay the safe dicts from
 * `composeTemplateContract`. This function does not read or admit a vault.
 */
export function composeTemplateRetrievalSource(
  policy: TemplatePolicy,
  routing: TaxonomyRouting,
  generationDigest: Digest,
): TemplateRetrievalSource {
  const templates: Record<string, ResolvedContract> = Object.create(null);
  for (const templateId of Object.keys(policy.templates).sort(compareText)) {
    templates[templateId] = composeTemplateContract(policy, templateId, placementFor(routing, templateId));
  }
  return {
    defaultContract: composeTemplateContract(policy, null, null),
    templates,
    globalAxes: routing.globalAxes,
    generationDigest,
    policy,
  };
}

function placementRecord(routing: TaxonomyRouting): Readonly<Record<string, TemplateFolderPath>> {
  return Object.fromEntries([...routing.targetFolders.entries()].sort((left, right) => compareText(left[0], right[0])));
}

function projectionHeading(heading: ResolvedHeading): HeadingContract {
  return {
    headingId: heading.headingId,
    title: heading.title,
    level: heading.level,
    required: true,
    ...(heading.extensions === undefined ? {} : { extensions: heading.extensions }),
  };
}

function projectionField(field: ResolvedField): ResolvedField {
  return {
    property: field.property,
    type: field.type,
    intent: field.intent,
    required: field.required,
    ...(field.allowedValues === undefined ? {} : { allowedValues: field.allowedValues }),
    ...(field.format === undefined ? {} : { format: field.format }),
  };
}

function projectionFields(fields: Readonly<Record<string, ResolvedField>>): Readonly<Record<string, ResolvedField>> {
  return Object.fromEntries(Object.entries(fields).sort((left, right) => compareText(left[0], right[0])).map(([key, field]) => [key, projectionField(field)]));
}

function projectionTemplate(contract: ResolvedContract): DerivedTemplateProjection {
  const approved = contract.approved.templateLayer;
  if (approved === undefined || contract.templateId === null) fail("TEMPLATE_POLICY_INVALID", "individual contract is missing its template layer");
  return {
    templateId: contract.templateId,
    headingOrder: contract.headingOrder,
    fields: projectionFields(contract.fields),
    headings: contract.headings.map(projectionHeading),
    contractDigest: contract.contractDigest,
    approvedMarkdownDigest: approved.approvedMarkdownDigest,
  };
}

function logicalManaged(
  policy: TemplatePolicy,
  routing: TaxonomyRouting,
  generationDigest: Digest,
): DerivedProjection["managed"] {
  const composed = composeTemplateRetrievalSource(policy, routing, generationDigest);
  const templates: Record<string, DerivedTemplateProjection> = {};
  for (const templateId of Object.keys(composed.templates).sort(compareText)) {
    const contract = composed.templates[templateId];
    if (contract === undefined) continue;
    templates[templateId] = projectionTemplate(contract);
  }
  const axes = Object.fromEntries(Object.entries(composed.globalAxes).sort((left, right) => compareText(left[0], right[0])));
  return {
    headingOrder: composed.defaultContract.headingOrder,
    fields: projectionFields(composed.defaultContract.fields),
    headings: composed.defaultContract.headings.map(projectionHeading),
    globalAxes: axes,
    templates,
  };
}

/** Effective oms.types.v2 managed payload for these approved contracts and this taxonomy. */
export function expectedProjectionManaged(
  policy: TemplatePolicy,
  routing: TaxonomyRouting,
  generationDigest: Digest,
): DerivedProjection["managed"] {
  return parseDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: logicalManaged(policy, routing, generationDigest),
  }).managed;
}

/**
 * Generation of the approved policy and taxonomy bytes.
 * Projection bytes and Obsidian types are not inputs; P08 republishes the same digest.
 */
export function controlGenerationDigest(policyBytes: Uint8Array, taxonomyBytes: Uint8Array): Digest {
  return hashCanonical("oms.template-control.generation.v4", {
    policy: digestBytes(policyBytes),
    taxonomy: digestBytes(taxonomyBytes),
  });
}

export function assertStableControlRead(before: ControlByteRead, after: ControlByteRead): void {
  const changed = (["marker", "policy", "taxonomy", "projection"] as const).filter(key => !sameBytes(before[key], after[key]));
  if (changed.length === 0) return;
  fail("CONTRACT_TRANSACTION_IN_PROGRESS", `${changed.join(", ")} changed while reading controls`);
}

/**
 * Absent and complete are readable only after the publication inspector's
 * durable marker check. A complete marker does not cause this reader to
 * compare current draft bytes; that comparison stays a local drift diagnostic.
 */
async function assertMarkerAdmitted(vault: string): Promise<void> {
  const inspection = await inspectTemplateTransactionMarker(vault);
  if (inspection.admission === "clear" && (inspection.state === "absent" || inspection.state === "complete")) return;
  if (inspection.state === "in-progress") fail("CONTRACT_TRANSACTION_IN_PROGRESS", "template transaction is in progress");
  const failure = inspection.failure;
  const detail = failure === undefined
    ? "transaction marker is invalid"
    : `${failure.message} (${failure.reason}; ${failure.path})`;
  fail("CONTRACT_TRANSACTION_IN_PROGRESS", `transaction marker is invalid: ${detail}`);
}

function parseApprovedPolicy(bytes: Uint8Array): TemplatePolicy {
  const text = decode(bytes, "CONTRACT_UNVERIFIABLE", "approved policy is not UTF-8");
  try {
    return parseTemplatePolicy(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("TEMPLATE_POLICY_VERSION_UNSUPPORTED:")) throw error;
    if (message.startsWith("CONTRACT_UNVERIFIABLE:")) throw error;
    if (message.startsWith("TEMPLATE_POLICY_INVALID: JSON parse failed")) fail("CONTRACT_UNVERIFIABLE", "approved policy is not valid JSON");
    throw error;
  }
}

async function readControl(vaultRoot: string, path: string): Promise<Uint8Array | null> {
  const verified = await verifyTemplateControlPath(vaultRoot, normalizeTemplateControlPath(path), { expected: "either" });
  if (verified.targetRealPath === null) return null;
  return new Uint8Array(await readFile(verified.absolutePath));
}

async function readControlGeneration(root: string): Promise<ControlByteRead> {
  return {
    marker: await readControl(root, TEMPLATE_TRANSACTION_MARKER_PATH),
    policy: await readControl(root, POLICY_PATH),
    taxonomy: await readControl(root, TAXONOMY_PATH),
    projection: await readControl(root, PROJECTION_PATH),
  };
}

function exactBytes(path: string, bytes: Uint8Array): ExactControlBytes {
  const copy = new Uint8Array(bytes);
  return { path, bytes: copy, digest: digestBytes(copy) };
}

type ObsidianBytes =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly bytes: Uint8Array }
  | { readonly state: "unreadable"; readonly message: string };

async function readObsidianTypes(root: string): Promise<ObsidianBytes> {
  const absolute = resolve(root, OBSIDIAN_PATH);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    fail("TEMPLATE_SOURCE_UNSAFE", "Obsidian types path escapes the vault");
  }
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) fail("TEMPLATE_SOURCE_UNSAFE", "Obsidian types symlink is not allowed");
    if (!stat.isFile()) return { state: "unreadable", message: ".obsidian/types.json is not a regular file" };
    return { state: "present", bytes: new Uint8Array(await readFile(absolute)) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

function obsidianObservation(bytes: Uint8Array | null, policy: TemplatePolicy): {
  readonly diagnostics: readonly Diagnostic[];
  readonly types: Readonly<Record<string, ObsidianContractType>> | null;
} {
  if (bytes === null) return { diagnostics: [], types: null };
  try {
    const parsed = parseObsidianTypes(bytes, OBSIDIAN_PATH);
    const diagnostics: Diagnostic[] = [];
    for (const name of Object.keys(policy.properties).sort(compareText)) {
      const declared = policy.properties[name]?.type;
      const observed = parsed.types[name];
      if (declared === undefined || observed === undefined || declared === observed) continue;
      diagnostics.push({
        code: "OBSIDIAN_TYPE_CONFLICT",
        field: name,
        path: OBSIDIAN_PATH,
        message: `property ${name} is ${declared} in the policy pool and ${observed} in Obsidian types`,
      });
    }
    return { diagnostics, types: parsed.types };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: [{
        code: "OBSIDIAN_TYPE_CONFLICT",
        path: OBSIDIAN_PATH,
        message: `Obsidian types could not be read: ${message}`,
      }],
      types: null,
    };
  }
}

async function observeDraft(
  root: string,
  templateId: TemplateId | null,
  templatePath: ManagedTemplatePath,
  approvedMarkdownDigest: Digest,
): Promise<{ readonly freshness: ManagedDraftFreshness; readonly diagnostic: Diagnostic | null }> {
  const verified = await verifyManagedTemplatePath(root, templatePath, { expected: "either" });
  const bytes = verified.targetRealPath === null ? null : new Uint8Array(await readFile(verified.absolutePath));
  const observedDraftDigest = bytes === null ? null : digestBytes(bytes);
  const drift = observedDraftDigest === approvedMarkdownDigest ? null : "MANAGED_TEMPLATE_DRIFT" as const;
  const freshness: ManagedDraftFreshness = { templateId, templatePath, approvedMarkdownDigest, observedDraftDigest, drift };
  if (drift === null) return { freshness, diagnostic: null };
  return {
    freshness,
    diagnostic: {
      code: drift,
      ...(templateId === null ? {} : { templateId }),
      path: templatePath,
      message: bytes === null
        ? `managed draft ${templatePath} is missing`
        : `managed draft ${templatePath} does not match the approved markdown digest`,
    },
  };
}

async function observeSource(
  root: string,
  templateId: TemplateId,
  source: TemplateSourceRef,
): Promise<{ readonly freshness: SourceFreshness; readonly diagnostic: Diagnostic | null }> {
  const verified = await verifyTemplateSourcePath(root, source.path, { expected: "either" });
  const bytes = verified.targetRealPath === null ? null : new Uint8Array(await readFile(verified.absolutePath));
  const observedRawDigest = bytes === null ? null : digestBytes(bytes);
  const drift = observedRawDigest === source.rawDigest ? null : "SOURCE_DRIFT" as const;
  const freshness: SourceFreshness = { templateId, source, observedRawDigest, drift };
  if (drift === null) return { freshness, diagnostic: null };
  return {
    freshness,
    diagnostic: {
      code: drift,
      templateId,
      path: source.path,
      message: bytes === null
        ? `raw source ${source.path} is missing`
        : `raw source ${source.path} does not match the approved raw digest`,
    },
  };
}

async function resolveStableSnapshot(root: string, read: ControlByteRead): Promise<ResolvedTemplateSnapshot> {
  await assertMarkerAdmitted(root);
  if (read.policy === null) fail("CONTRACT_UNVERIFIABLE", "approved policy is absent");
  const policy = parseApprovedPolicy(read.policy);
  if (read.taxonomy === null) fail("TEMPLATE_SOURCE_INVALID", ".oms/taxonomy.json is absent");
  const routing = taxonomyRouting(TAXONOMY_PATH, read.taxonomy);
  if (read.projection === null) fail("PROJECTION_INVALID", ".oms/types.json is absent");
  const projection = parseDerivedProjection(decode(read.projection, "PROJECTION_INVALID", ".oms/types.json is not UTF-8"));
  const generationDigest = controlGenerationDigest(read.policy, read.taxonomy);
  if (projection.generatedFrom !== generationDigest) {
    fail("CONTRACT_TRANSACTION_IN_PROGRESS", "projection generatedFrom does not match policy and taxonomy bytes");
  }
  const managed = expectedProjectionManaged(policy, routing, generationDigest);
  const validated = validateDerivedProjection(projection, managed);
  const obsidianRead = await readObsidianTypes(root);
  const obsidianBytes = obsidianRead.state === "present" ? obsidianRead.bytes : null;
  const obsidian = obsidianRead.state === "unreadable"
    ? {
        diagnostics: [{
          code: "OBSIDIAN_TYPE_CONFLICT" as const,
          path: OBSIDIAN_PATH,
          message: `Obsidian types could not be read: ${obsidianRead.message}`,
        }],
        types: null,
      }
    : obsidianObservation(obsidianBytes, policy);
  const templateIds = Object.keys(policy.templates).sort(compareText);
  const composed = composeTemplateRetrievalSource(policy, routing, generationDigest);
  const draftRows = [await observeDraft(root, null, policy.default.templatePath, policy.default.approvedMarkdownDigest)];
  for (const templateId of templateIds) {
    const template = policy.templates[templateId];
    if (template === undefined) continue;
    draftRows.push(await observeDraft(root, template.templateId, template.templatePath, template.approvedMarkdownDigest));
  }
  const sourceRows: Array<Awaited<ReturnType<typeof observeSource>>> = [];
  for (const templateId of templateIds) {
    const template = policy.templates[templateId];
    if (template?.source === undefined) continue;
    sourceRows.push(await observeSource(root, template.templateId, template.source));
  }
  const diagnostics = [
    ...draftRows.flatMap(row => row.diagnostic === null ? [] : [row.diagnostic]),
    ...sourceRows.flatMap(row => row.diagnostic === null ? [] : [row.diagnostic]),
    ...obsidian.diagnostics,
  ];
  return {
    vault: root,
    policy: composed.policy,
    defaultContract: composed.defaultContract,
    templates: composed.templates,
    placement: placementRecord(routing),
    globalAxes: composed.globalAxes,
    generationDigest: composed.generationDigest,
    projection: validated,
    controls: {
      policy: exactBytes(POLICY_PATH, read.policy),
      taxonomy: exactBytes(TAXONOMY_PATH, read.taxonomy),
      projection: exactBytes(PROJECTION_PATH, read.projection),
      marker: read.marker === null ? null : exactBytes(TEMPLATE_TRANSACTION_MARKER_PATH, read.marker),
      obsidianTypes: obsidianBytes === null ? null : exactBytes(OBSIDIAN_PATH, obsidianBytes),
    },
    obsidianTypes: obsidian.types,
    sources: sourceRows.map(row => row.freshness),
    drafts: draftRows.map(row => row.freshness),
    diagnostics,
  };
}

export async function loadResolvedTemplates(vault: string): Promise<ResolvedTemplateSnapshot> {
  const root = await realpath(vault);
  const before = await readControlGeneration(root);
  const snapshot = await resolveStableSnapshot(root, before);
  const after = await readControlGeneration(root);
  assertStableControlRead(before, after);
  return snapshot;
}

export async function loadResolvedTemplatesIfPresent(vault: string): Promise<ResolvedTemplateSnapshot | null> {
  const root = await realpath(vault);
  const present = await Promise.all([POLICY_PATH, TAXONOMY_PATH, PROJECTION_PATH, TEMPLATE_TRANSACTION_MARKER_PATH].map(path => readControl(root, path)));
  if (present.every(bytes => bytes === null)) return null;
  return loadResolvedTemplates(root);
}
