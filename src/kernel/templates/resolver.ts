import { digestBytes, hashCanonical } from "./canonical.js";
import { composeTemplateContract } from "./defaults.js";
import { parseDerivedProjection } from "./policy.js";
import {
  normalizeTemplateFolderPath,
  validateTemplateId,
} from "./paths.js";
import type {
  DerivedProjection,
  DerivedTemplateProjection,
  Digest,
  GlobalAxes,
  GlobalAxis,
  HeadingContract,
  JsonValue,
  ResolvedContract,
  ResolvedField,
  ResolvedHeading,
  TemplateFolderPath,
  TemplatePolicy,
} from "./types.js";

/**
 * Read-only view of an approved version 4 vault.
 * Policy bytes are the contract authority. A drifted source or managed draft
 * stays a local diagnostic and does not replace the approved markdown.
 * The derived projection is checked, not trusted as a second authority.
 */

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

function placementFor(routing: TaxonomyRouting, templateId: string): JsonValue | null {
  const folder = routing.targetFolders.get(templateId);
  return folder === undefined ? null : { templateFolder: folder };
}

/**
 * Historical contract composition for the derived projection and the
 * derived projection. Search does not use it: retrieval metadata comes from the
 * explicit V5 contract. Placement is only `placementFor`, and field records stay
 * the safe dicts from `composeTemplateContract`. It reads and admits no vault.
 */
interface ComposedTemplateContracts {
  readonly defaultContract: ResolvedContract;
  readonly templates: Readonly<Record<string, ResolvedContract>>;
  readonly globalAxes: GlobalAxes;
  readonly generationDigest: Digest;
  readonly policy: TemplatePolicy;
}

function composeTemplateRetrievalSource(
  policy: TemplatePolicy,
  routing: TaxonomyRouting,
  generationDigest: Digest,
): ComposedTemplateContracts {
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
