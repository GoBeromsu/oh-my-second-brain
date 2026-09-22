import { CompletionContractError, validateRubric } from "../conventions/completion-contract.js";
import { digestBytes, hashCanonical } from "./canonical.js";
import { normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import {
  COMPLETION_RETRY_BUDGET_DEFAULT,
  DEFAULT_MANAGED_TEMPLATE_PATH,
  type AgentRepairContext,
  type AgentRepairPolicy,
  type CompletionPolicy,
  type ContractLayer,
  type DerivedProjection,
  type DerivedTemplateProjection,
  type DiagnosticCode,
  type Digest,
  type Extensions,
  type GlobalAxis,
  type GlobalAxes,
  type HeadingContract,
  type HeadingOrder,
  type JsonValue,
  type LayerFieldRef,
  type ManagedTemplatePath,
  type ObsidianContractType,
  type PropertyDefinition,
  type PropertyFormat,
  type ResolvedField,
  type TemplateId,
  type TemplateLayer,
  type TemplatePolicy,
  type TemplateSourceRef,
} from "./types.js";

export { validateTemplateId } from "./paths.js";

const TYPES = ["text", "string", "select", "number", "boolean", "checkbox", "date", "datetime", "list", "multitext", "multi", "tags", "aliases", "file"] as const;
const TYPE_SET = new Set<string>(TYPES);
const STRING_FORMAT_TYPES = new Set<ObsidianContractType>(["text", "string", "select", "file"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RETIRED_POLICY_KEYS = ["templateFolder", "templateFolders", "defaultTemplate", "base", "contracts", "writers"] as const;
const RETIRED_LAYER_KEYS = ["renderer", "destinationClass", "naming", "contract", "content", "sourceFolder", "sourcePath", "approvedSourceSignature", "approvedBodySignature", "views"] as const;
const FORBIDDEN_FIELD_OVERRIDES = ["type", "format", "intent", "default", "normalize", "filledBy", "immutable", "allowTemplateDefault"] as const;

export const TEMPLATE_POLICY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
  required: ["version", "properties", "default", "templates"],
  properties: {
    version: { const: 4 },
    properties: { type: "object", additionalProperties: { type: "object", required: ["type", "intent"], additionalProperties: true } },
    default: { type: "object", required: ["templatePath", "approvedMarkdown", "approvedMarkdownDigest", "fields", "headings", "semanticCriteria"], additionalProperties: true },
    templates: { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
    completion: {
      type: "object",
      additionalProperties: true,
      properties: {
        retryBudget: { type: "integer", minimum: 0 },
        agentRepair: {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            contexts: { type: "array", uniqueItems: true, items: { enum: ["post-write", "maintenance"] } },
          },
        },
      },
    },
    extensions: { type: "object", additionalProperties: true },
  },
} as const;

export const DERIVED_PROJECTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
  required: ["version", "generatedFrom", "managed"],
  properties: {
    version: { const: "oms.types.v2" },
    generatedFrom: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    managed: {
      type: "object",
      required: ["headingOrder", "fields", "headings", "globalAxes", "templates"],
      additionalProperties: true,
    },
    extensions: { type: "object", additionalProperties: true },
  },
} as const;

function fail(code: DiagnosticCode, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function record(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${where} must be an object`);
  return value as Record<string, unknown>;
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function assertWellFormed(value: string, where: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail("TEMPLATE_POLICY_INVALID", `${where} contains an unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("TEMPLATE_POLICY_INVALID", `${where} contains an unpaired surrogate`);
    }
  }
}

function exactString(value: unknown, where: string): string {
  if (typeof value !== "string") fail("TEMPLATE_POLICY_INVALID", `${where} must be a string`);
  assertWellFormed(value, where);
  return value;
}

function unsafeToken(value: string): boolean {
  return /\s/u.test(value) || value.includes("/") || value.includes("\\") || value.includes("\0");
}

function token(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): string {
  if (typeof value !== "string") fail(code, `${where} must be a string`);
  const name = value.normalize("NFC").trim();
  if (name.length === 0 || name === "." || name === ".." || name.startsWith(".") || unsafeToken(name)) {
    fail(code, `${where} must be a stable token`);
  }
  return name;
}

function text(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): string {
  if (typeof value !== "string") fail(code, `${where} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) fail(code, `${where} must be a non-empty string`);
  assertWellFormed(normalized, where);
  return normalized;
}

function digest(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code, `${where} must be a lowercase sha256 digest`);
  return value as Digest;
}

function json(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") assertWellFormed(value, where);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(code, `${where} must be a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${where}[${index}]`, code));
  const input = record(value, where, code);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, json(item, `${where}.${key}`, code)]));
}

function extensions(input: Record<string, unknown>, reserved: ReadonlySet<string>, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): Extensions | undefined {
  const declared = input.extensions === undefined ? {} : record(input.extensions, `${where}.extensions`, code);
  for (const key of Object.keys(declared)) if (reserved.has(key)) fail("TEMPLATE_EXTENSION_RESERVED", `${where}.extensions.${key} shadows a managed key`);
  const direct = Object.fromEntries(Object.entries(input).filter(([key]) => !reserved.has(key)));
  for (const key of Object.keys(direct)) if (Object.hasOwn(declared, key)) fail("TEMPLATE_EXTENSION_CONFLICT", `${where}.${key} conflicts with extensions.${key}`);
  const merged = { ...direct, ...declared };
  return Object.keys(merged).length === 0 ? undefined : json(merged, `${where}.extensions`, code) as Extensions;
}

function policyType(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): ObsidianContractType {
  const type = token(value, where, code);
  if (!TYPE_SET.has(type)) fail(code, `${where} must be an Obsidian contract type`);
  return type as ObsidianContractType;
}

function parseAllowed(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail(code, `${where} must be a non-empty string array`);
  const parsed = value.map((item, index) => token(item, `${where}[${index}]`, code));
  if (new Set(parsed).size !== parsed.length) fail(code, `${where} contains duplicate values`);
  return [...parsed].sort(compareText);
}

function assertSubset(values: readonly string[] | undefined, ceiling: readonly string[] | undefined, where: string): void {
  if (values === undefined || ceiling === undefined) return;
  const allowed = new Set(ceiling);
  const outside = values.filter(value => !allowed.has(value));
  if (outside.length === 0) return;
  const reason = values.some(value => allowed.has(value)) ? `[${outside.join(", ")}] is outside the inherited set` : "the intersection is empty";
  fail("CONTRACT_COMPOSITION_CONFLICT", `${where} must stay inside [${ceiling.join(", ")}]; ${reason}`);
}

function cause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(?:TEMPLATE_SOURCE_UNSAFE|TEMPLATE_SOURCE_INVALID): /, "");
}

function validatedTemplateId(value: string): TemplateId {
  try {
    return validateTemplateId(value);
  } catch (error) {
    fail("TEMPLATE_SOURCE_INVALID", cause(error));
  }
}

function rejectRetired(input: Record<string, unknown>, keys: readonly string[], where: string, code: DiagnosticCode = "TEMPLATE_POLICY_VERSION_UNSUPPORTED", detail = "is a version 3 authoring field and is not part of version 4. Automatic migration is not available."): void {
  for (const key of keys) if (Object.hasOwn(input, key)) fail(code, `${where}.${key} ${detail}`);
}

function managedPath(templateId: TemplateId | null): ManagedTemplatePath {
  if (templateId === null) return DEFAULT_MANAGED_TEMPLATE_PATH;
  return `.oms/templates/${templateId}.md` as ManagedTemplatePath;
}

function lexicalPath(value: unknown, where: string): string {
  const raw = exactString(value, where).normalize("NFC").replaceAll("\\", "/");
  if (raw.includes("\0") || raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) {
    fail("TEMPLATE_SOURCE_UNSAFE", `${where} must be a vault-relative path`);
  }
  const parts = raw.split("/");
  if (parts.some(part => part === "..")) fail("TEMPLATE_SOURCE_UNSAFE", `${where} must not traverse the vault`);
  const normalized = parts.filter(part => part !== "" && part !== ".").join("/");
  if (normalized.length === 0) fail("TEMPLATE_SOURCE_INVALID", `${where} must not be empty`);
  return normalized;
}

function parseCriteria(value: unknown, where: string, rubricId: string): ContractLayer["semanticCriteria"] {
  if (!Array.isArray(value)) fail("TEMPLATE_POLICY_INVALID", `${where} must be an array`);
  if (value.length === 0) return [];
  try {
    return validateRubric({ rubricId, criteria: value }).criteria;
  } catch (error) {
    const message = error instanceof CompletionContractError ? error.message : error instanceof Error ? error.message : String(error);
    fail("RUBRIC_INVALID", `${where} ${message}`);
  }
}

function parseHeadings(value: unknown, where: string, code: DiagnosticCode = "TEMPLATE_POLICY_INVALID"): readonly HeadingContract[] {
  if (!Array.isArray(value)) fail(code, `${where} must be an array`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const at = `${where}[${index}]`;
    const input = record(item, at, code);
    const headingId = token(input.headingId, `${at}.headingId`, code);
    if (seen.has(headingId)) fail(code, `${where} contains duplicate heading ${headingId}`);
    seen.add(headingId);
    const level = input.level;
    if (typeof level !== "number" || !Number.isSafeInteger(level) || Object.is(level, -0) || level < 1 || level > 6) {
      fail(code, `${at}.level must be an integer from 1 to 6`);
    }
    if (input.required !== true) fail(code, `${at}.required must be true`);
    const preserved = extensions(input, new Set(["headingId", "title", "level", "required", "extensions"]), at, code);
    return {
      headingId,
      title: text(input.title, `${at}.title`, code),
      level,
      required: true as const,
      ...(preserved === undefined ? {} : { extensions: preserved }),
    };
  });
}

function parseHeadingOrder(value: unknown, where: string): HeadingOrder | undefined {
  if (value === undefined) return undefined;
  if (value !== "unordered" && value !== "strict") fail("TEMPLATE_POLICY_INVALID", `${where} must be unordered or strict`);
  return value;
}

function parseFieldRef(value: unknown, key: string, where: string, pool: Readonly<Record<string, PropertyDefinition>>, ceiling: readonly string[] | undefined): LayerFieldRef {
  const input = record(value, where);
  for (const override of FORBIDDEN_FIELD_OVERRIDES) {
    if (Object.hasOwn(input, override)) {
      fail("TEMPLATE_POLICY_INVALID", `${where}.${override} cannot be declared on a layer; it belongs to the property pool`);
    }
  }
  if (input.required !== undefined && input.required !== true) fail("TEMPLATE_POLICY_INVALID", `${where}.required may only be true`);
  const property = token(input.property, `${where}.property`);
  const mapKey = token(key, where);
  if (property !== mapKey) fail("TEMPLATE_POLICY_INVALID", `${where}.property must equal its map key`);
  if (!Object.hasOwn(pool, property)) fail("TEMPLATE_POLICY_DANGLING_FIELD", `${where} references unknown property ${property}`);
  const allowedValues = parseAllowed(input.allowedValues, `${where}.allowedValues`);
  assertSubset(allowedValues, ceiling ?? pool[property]?.allowedValues, `${where}.allowedValues`);
  const preserved = extensions(input, new Set(["property", "required", "allowedValues", "extensions", ...FORBIDDEN_FIELD_OVERRIDES]), where);
  return {
    property,
    ...(input.required === true ? { required: true as const } : {}),
    ...(allowedValues === undefined ? {} : { allowedValues }),
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

function parseFields(
  value: unknown,
  where: string,
  pool: Readonly<Record<string, PropertyDefinition>>,
  parent: Readonly<Record<string, LayerFieldRef>> | undefined,
): Readonly<Record<string, LayerFieldRef>> {
  const input = record(value, where);
  const fields: Record<string, LayerFieldRef> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    const property = token(key, `${where} key`);
    if (Object.hasOwn(fields, property)) fail("TEMPLATE_POLICY_INVALID", `${where} contains canonically equivalent property keys for ${property}`);
    const parentField = parent?.[property];
    const ceiling = parentField?.allowedValues ?? pool[property]?.allowedValues;
    fields[property] = parseFieldRef(raw, key, `${where}.${key}`, pool, parent === undefined ? pool[property]?.allowedValues : ceiling);
  }
  return fields;
}

function parseSource(value: unknown, where: string): TemplateSourceRef {
  const input = record(value, where);
  let path: TemplateSourceRef["path"];
  try {
    path = normalizeTemplateSourcePath(exactString(input.path, `${where}.path`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("TEMPLATE_SOURCE_UNSAFE:") ? "TEMPLATE_SOURCE_UNSAFE" : "TEMPLATE_SOURCE_INVALID";
    fail(code, `${where}.path ${cause(error)}`);
  }
  const preserved = extensions(input, new Set(["path", "identity", "rawDigest", "extensions"]), where);
  if (preserved !== undefined) fail("TEMPLATE_POLICY_INVALID", `${where} does not accept unknown source members`);
  return {
    path,
    identity: token(input.identity, `${where}.identity`),
    rawDigest: digest(input.rawDigest, `${where}.rawDigest`),
  };
}

function parseLayer(value: unknown, where: string, expectedPath: ManagedTemplatePath, pool: Readonly<Record<string, PropertyDefinition>>, parent: ContractLayer | undefined, rubricId: string): ContractLayer {
  const input = record(value, where);
  rejectRetired(input, RETIRED_LAYER_KEYS, where);
  if (lexicalPath(input.templatePath, `${where}.templatePath`) !== expectedPath) {
    fail("TEMPLATE_SOURCE_INVALID", `${where}.templatePath must be ${expectedPath}`);
  }
  const approvedMarkdown = exactString(input.approvedMarkdown, `${where}.approvedMarkdown`);
  const approvedMarkdownDigest = digest(input.approvedMarkdownDigest, `${where}.approvedMarkdownDigest`);
  if (digestBytes(approvedMarkdown) !== approvedMarkdownDigest) {
    fail("CONTRACT_UNVERIFIABLE", `${where}.approvedMarkdownDigest does not match the exact approved markdown bytes`);
  }
  const headingOrder = parseHeadingOrder(input.headingOrder, `${where}.headingOrder`);
  const reserved = new Set(["templatePath", "approvedMarkdown", "approvedMarkdownDigest", "fields", "headings", "headingOrder", "semanticCriteria", "extensions", "templateId", "source"]);
  const preserved = extensions(input, reserved, where);
  return {
    templatePath: expectedPath,
    approvedMarkdown,
    approvedMarkdownDigest,
    fields: parseFields(input.fields, `${where}.fields`, pool, parent?.fields),
    headings: parseHeadings(input.headings, `${where}.headings`),
    ...(headingOrder === undefined ? {} : { headingOrder }),
    semanticCriteria: parseCriteria(input.semanticCriteria, `${where}.semanticCriteria`, rubricId),
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

function parseProperties(value: unknown): Readonly<Record<string, PropertyDefinition>> {
  const input = record(value, "policy.properties");
  const properties: Record<string, PropertyDefinition> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    const where = `policy.properties.${key}`;
    const name = token(key, "policy.properties key");
    if (Object.hasOwn(properties, name)) fail("TEMPLATE_POLICY_INVALID", `policy.properties contains canonically equivalent keys for ${name}`);
    const property = record(raw, where);
    const type = policyType(property.type, `${where}.type`);
    const format = property.format === undefined ? undefined : property.format;
    if (format !== undefined && format !== "url") fail("TEMPLATE_POLICY_INVALID", `${where}.format is invalid`);
    if (format === "url" && !STRING_FORMAT_TYPES.has(type)) {
      fail("CONTRACT_COMPOSITION_CONFLICT", `${where}.format url conflicts with type ${type}`);
    }
    const allowed = parseAllowed(property.allowedValues, `${where}.allowedValues`);
    const preserved = extensions(property, new Set(["type", "intent", "allowedValues", "format", "extensions"]), where);
    properties[name] = {
      type,
      intent: text(property.intent, `${where}.intent`),
      ...(allowed === undefined ? {} : { allowedValues: allowed }),
      ...(format === undefined ? {} : { format: "url" as const }),
      ...(preserved === undefined ? {} : { extensions: preserved }),
    };
  }
  return properties;
}

function parseRepair(value: unknown): AgentRepairPolicy {
  if (value === undefined) return { enabled: false };
  const input = record(value, "policy.completion.agentRepair");
  const enabled = input.enabled === undefined ? false : input.enabled;
  if (typeof enabled !== "boolean") fail("TEMPLATE_POLICY_INVALID", "policy.completion.agentRepair.enabled must be boolean");
  let contexts: readonly AgentRepairContext[] | undefined;
  if (input.contexts !== undefined) {
    if (!Array.isArray(input.contexts)) fail("TEMPLATE_POLICY_INVALID", "policy.completion.agentRepair.contexts must be an array");
    const parsed = input.contexts.map((item, index) => {
      if (item !== "post-write" && item !== "maintenance") {
        fail("TEMPLATE_POLICY_INVALID", `policy.completion.agentRepair.contexts[${index}] is not a user-owned repair context`);
      }
      return item;
    });
    if (new Set(parsed).size !== parsed.length) fail("TEMPLATE_POLICY_INVALID", "policy.completion.agentRepair.contexts contains duplicates");
    contexts = parsed;
  }
  const preserved = extensions(input, new Set(["enabled", "contexts", "extensions"]), "policy.completion.agentRepair");
  return { enabled, ...(contexts === undefined ? {} : { contexts }), ...(preserved === undefined ? {} : { extensions: preserved }) };
}

function parseCompletion(value: unknown): CompletionPolicy {
  if (value === undefined) return { retryBudget: COMPLETION_RETRY_BUDGET_DEFAULT, agentRepair: { enabled: false } };
  const input = record(value, "policy.completion");
  const retryBudget = input.retryBudget === undefined ? COMPLETION_RETRY_BUDGET_DEFAULT : input.retryBudget;
  if (typeof retryBudget !== "number" || !Number.isSafeInteger(retryBudget) || Object.is(retryBudget, -0) || retryBudget < 0) {
    fail("TEMPLATE_POLICY_INVALID", "policy.completion.retryBudget must be a finite nonnegative safe integer");
  }
  const preserved = extensions(input, new Set(["retryBudget", "agentRepair", "extensions"]), "policy.completion");
  return {
    retryBudget,
    agentRepair: parseRepair(input.agentRepair),
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

function sharedIds(left: readonly { readonly id: string }[], right: readonly { readonly id: string }[], noun: string, templateId: string): void {
  const seen = new Set(left.map(item => item.id));
  for (const item of right) {
    if (seen.has(item.id)) {
      fail("CONTRACT_COMPOSITION_CONFLICT", `${noun} ${item.id} is already declared on the default layer; template ${templateId} must add a new id instead of redeclaring it`);
    }
  }
}

function assertComposition(layer: ContractLayer, template: TemplateLayer): void {
  const baseOrder = layer.headingOrder ?? "unordered";
  if (baseOrder === "strict" && template.headingOrder === "unordered") {
    fail("CONTRACT_COMPOSITION_CONFLICT", `template ${template.templateId} cannot weaken headingOrder from strict to unordered`);
  }
  sharedIds(layer.headings.map(heading => ({ id: heading.headingId })), template.headings.map(heading => ({ id: heading.headingId })), "heading", template.templateId);
  sharedIds(layer.semanticCriteria.map(criterion => ({ id: criterion.criterionId })), template.semanticCriteria.map(criterion => ({ id: criterion.criterionId })), "criterion", template.templateId);
}

/** Reads a version 4 policy. Version 3 and older authoring shapes are rejected without conversion. */
export function parseTemplatePolicy(input: string | unknown): TemplatePolicy {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input) as unknown; } catch { fail("TEMPLATE_POLICY_INVALID", "JSON parse failed"); }
  }
  const root = record(value, "policy");
  if (root.version !== 4) {
    const seen = root.version === 3 ? "version 3" : `version ${JSON.stringify(root.version)}`;
    fail("TEMPLATE_POLICY_VERSION_UNSUPPORTED", `${seen} is unsupported. Approve a version 4 policy with a properties pool, an always-on default layer, and template layers. Automatic migration is not available.`);
  }
  rejectRetired(root, RETIRED_POLICY_KEYS, "policy");
  const properties = parseProperties(root.properties);
  const defaultLayer = parseLayer(root.default, "policy.default", DEFAULT_MANAGED_TEMPLATE_PATH, properties, undefined, "default");
  if (Object.hasOwn(record(root.default, "policy.default"), "templateId") || Object.hasOwn(record(root.default, "policy.default"), "source")) {
    fail("TEMPLATE_POLICY_INVALID", "policy.default cannot carry a template id or raw source reference");
  }
  const rawTemplates = record(root.templates, "policy.templates");
  const templates: Record<string, TemplateLayer> = {};
  const sources = new Set<string>();
  for (const [rawKey, raw] of Object.entries(rawTemplates)) {
    const templateId = validatedTemplateId(rawKey);
    if (templateId === "default") fail("TEMPLATE_POLICY_INVALID", "template id default is reserved for the always-on default layer");
    if (Object.hasOwn(templates, templateId)) fail("TEMPLATE_ID_DUPLICATE", `policy.templates contains canonically equivalent template keys for ${templateId}`);
    const body = record(raw, `policy.templates.${rawKey}`);
    let declared = templateId;
    if (body.templateId !== undefined) {
      declared = validatedTemplateId(exactString(body.templateId, `policy.templates.${rawKey}.templateId`));
    }
    if (declared !== templateId) fail("TEMPLATE_POLICY_INVALID", `policy.templates.${rawKey}.templateId must equal its stable map key`);
    const layer = parseLayer(body, `policy.templates.${rawKey}`, managedPath(templateId), properties, defaultLayer, templateId);
    const source = body.source === undefined ? undefined : parseSource(body.source, `policy.templates.${rawKey}.source`);
    if (source !== undefined) {
      if (sources.has(source.path)) fail("TEMPLATE_SOURCE_DUPLICATE", `${source.path} is referenced more than once`);
      sources.add(source.path);
    }
    const template: TemplateLayer = { ...layer, templateId, ...(source === undefined ? {} : { source }) };
    assertComposition(defaultLayer, template);
    templates[templateId] = template;
  }
  const preserved = extensions(root, new Set(["version", "properties", "default", "templates", "completion", "extensions", ...RETIRED_POLICY_KEYS]), "policy");
  return {
    version: 4,
    properties,
    default: defaultLayer,
    templates,
    completion: parseCompletion(root.completion),
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, member]) => [key, stable(member)]));
  }
  return value;
}

function policyToJson(policy: TemplatePolicy): JsonValue {
  return json({
    version: policy.version,
    properties: policy.properties,
    default: policy.default,
    templates: policy.templates,
    completion: policy.completion,
    ...(policy.extensions === undefined ? {} : { extensions: policy.extensions }),
  }, "policy");
}

export function serializeTemplatePolicy(policy: TemplatePolicy): string {
  return `${JSON.stringify(stable(policyToJson(parseTemplatePolicy(policy))), null, 2)}\n`;
}

/** Effective order after inheritance. Explicit weakening is rejected again for hand-built objects. */
export function effectiveHeadingOrder(defaultLayer: ContractLayer, templateLayer?: ContractLayer | null): HeadingOrder {
  const base = defaultLayer.headingOrder ?? "unordered";
  if (templateLayer == null || templateLayer.headingOrder === undefined) return base;
  if (base === "strict" && templateLayer.headingOrder === "unordered") {
    fail("CONTRACT_COMPOSITION_CONFLICT", "headingOrder cannot be weakened from strict to unordered");
  }
  return templateLayer.headingOrder;
}

function propertyView(property: PropertyDefinition): JsonValue {
  return { type: property.type, intent: property.intent, allowedValues: property.allowedValues ?? null, format: property.format ?? null };
}

function fieldView(field: LayerFieldRef): JsonValue {
  return { property: field.property, required: field.required === true, allowedValues: field.allowedValues ?? null };
}

function headingView(heading: HeadingContract): { readonly headingId: string; readonly title: string; readonly level: number; readonly required: true } {
  return { headingId: heading.headingId, title: heading.title, level: heading.level, required: true };
}

function layerView(layer: ContractLayer, order: HeadingOrder): { readonly templatePath: ManagedTemplatePath; readonly approvedMarkdownDigest: Digest; readonly headingOrder: HeadingOrder; readonly fields: Readonly<Record<string, JsonValue>>; readonly headings: readonly ReturnType<typeof headingView>[]; readonly semanticCriteria: ContractLayer["semanticCriteria"] } {
  const headings = layer.headings.map(headingView);
  if (order === "unordered") headings.sort((left, right) => compareText(left.headingId, right.headingId));
  return {
    templatePath: layer.templatePath,
    approvedMarkdownDigest: layer.approvedMarkdownDigest,
    headingOrder: order,
    fields: Object.fromEntries(Object.entries(layer.fields).map(([key, field]) => [key, fieldView(field)])),
    headings,
    semanticCriteria: layer.semanticCriteria,
  };
}

/**
 * Canonical digest of the approved contract inputs for one template, or the default layer when `templateId` is null.
 * Completion settings and preserved unknown extensions are not inputs. Placement is caller-supplied taxonomy data.
 */
export function contractDigest(policy: TemplatePolicy, templateId: string | null, placement: JsonValue | null = null): Digest {
  const parsed = parseTemplatePolicy(policy);
  const id = templateId === null ? null : validatedTemplateId(templateId);
  const template = id === null ? null : parsed.templates[id];
  if (id !== null && template === undefined) fail("TEMPLATE_POLICY_INVALID", `template ${id} is not registered`);
  const names = new Set<string>([
    ...Object.keys(parsed.default.fields),
    ...(template === null || template === undefined ? [] : Object.keys(template.fields)),
  ]);
  const properties = Object.fromEntries([...names].sort(compareText).map(name => {
    const property = parsed.properties[name];
    if (property === undefined) fail("TEMPLATE_POLICY_DANGLING_FIELD", `referenced property ${name} is not in the pool`);
    return [name, propertyView(property)];
  }));
  const defaultOrder = effectiveHeadingOrder(parsed.default);
  const templateOrder = template === null || template === undefined ? null : effectiveHeadingOrder(parsed.default, template);
  try {
    return hashCanonical("oms.template-policy.contract.v4", {
      version: 4,
      templateId: id,
      properties,
      defaultLayer: layerView(parsed.default, templateOrder ?? defaultOrder),
      templateLayer: template === null || template === undefined ? null : {
        ...layerView(template, templateOrder ?? defaultOrder),
        templateId: template.templateId,
        source: template.source === undefined ? null : { path: template.source.path, identity: template.source.identity, rawDigest: template.source.rawDigest },
      },
      placement,
    }) as Digest;
  } catch (error) {
    fail("TEMPLATE_POLICY_INVALID", error instanceof Error ? error.message : String(error));
  }
}

function parseResolvedField(value: unknown, key: string, where: string): ResolvedField {
  const input = record(value, where, "PROJECTION_INVALID");
  const property = token(input.property, `${where}.property`, "PROJECTION_INVALID");
  if (property !== token(key, where, "PROJECTION_INVALID")) fail("PROJECTION_INVALID", `${where}.property must equal its map key`);
  const type = policyType(input.type, `${where}.type`, "PROJECTION_INVALID");
  const format = input.format === undefined ? undefined : input.format;
  if (format !== undefined && format !== "url") fail("PROJECTION_INVALID", `${where}.format is invalid`);
  if (format === "url" && !STRING_FORMAT_TYPES.has(type)) fail("CONTRACT_COMPOSITION_CONFLICT", `${where}.format url conflicts with type ${type}`);
  if (typeof input.required !== "boolean") fail("PROJECTION_INVALID", `${where}.required must be boolean`);
  const allowedValues = parseAllowed(input.allowedValues, `${where}.allowedValues`, "PROJECTION_INVALID");
  const preserved = extensions(input, new Set(["property", "type", "intent", "required", "allowedValues", "format", "extensions"]), where, "PROJECTION_INVALID");
  if (preserved !== undefined) fail("PROJECTION_INVALID", `${where} does not accept unknown field members`);
  return {
    property,
    type,
    intent: text(input.intent, `${where}.intent`, "PROJECTION_INVALID"),
    required: input.required,
    ...(allowedValues === undefined ? {} : { allowedValues }),
    ...(format === undefined ? {} : { format: "url" as PropertyFormat }),
  };
}

function parseResolvedFields(value: unknown, where: string): Readonly<Record<string, ResolvedField>> {
  const input = record(value, where, "PROJECTION_INVALID");
  const fields: Record<string, ResolvedField> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    const name = token(key, `${where} key`, "PROJECTION_INVALID");
    if (Object.hasOwn(fields, name)) fail("PROJECTION_INVALID", `${where} contains canonically equivalent field keys for ${name}`);
    fields[name] = parseResolvedField(raw, key, `${where}.${key}`);
  }
  return fields;
}

function parseProjectionHeadings(value: unknown, where: string): readonly HeadingContract[] {
  return parseHeadings(value, where, "PROJECTION_INVALID");
}

function parseAxes(value: unknown): GlobalAxes {
  const input = record(value, "managed.globalAxes", "PROJECTION_INVALID");
  const axes: Record<string, GlobalAxis> = Object.create(null);
  for (const [name, raw] of Object.entries(input)) {
    const where = `managed.globalAxes.${name}`;
    const axis = record(raw, where, "PROJECTION_INVALID");
    if (axis.kind !== "folder" && axis.kind !== "link") fail("PROJECTION_INVALID", `${where}.kind is invalid`);
    if (!Array.isArray(axis.members)) fail("PROJECTION_INVALID", `${where}.members must be an array`);
    const axisName = token(name, "managed.globalAxes key", "PROJECTION_INVALID");
    if (Object.hasOwn(axes, axisName)) fail("PROJECTION_INVALID", `managed.globalAxes contains canonically equivalent keys for ${axisName}`);
    const preserved = extensions(axis, new Set(["kind", "key", "type", "intent", "members", "extensions"]), where, "PROJECTION_INVALID");
    axes[axisName] = {
      kind: axis.kind,
      key: token(axis.key, `${where}.key`, "PROJECTION_INVALID"),
      type: policyType(axis.type, `${where}.type`, "PROJECTION_INVALID"),
      ...(axis.intent === undefined ? {} : { intent: text(axis.intent, `${where}.intent`, "PROJECTION_INVALID") }),
      members: axis.members.map((member, index) => json(member, `${where}.members[${index}]`, "PROJECTION_INVALID")),
      ...(preserved === undefined ? {} : { extensions: preserved }),
    };
  }
  return axes;
}

function parseProjectionTemplate(value: unknown, key: string): DerivedTemplateProjection {
  const where = `managed.templates.${key}`;
  const input = record(value, where, "PROJECTION_INVALID");
  rejectRetired(input, [...RETIRED_LAYER_KEYS, "base", "keyOrder", "bodySignature"], where, "PROJECTION_INVALID", "is an oms.types.v1 member and is not migrated.");
  let templateId: TemplateId;
  try { templateId = validateTemplateId(key); } catch (error) {
    fail("PROJECTION_INVALID", cause(error));
  }
  const declared = token(input.templateId, `${where}.templateId`, "PROJECTION_INVALID");
  if (declared !== templateId) fail("PROJECTION_INVALID", `${where}.templateId must equal its map key`);
  const headingOrder = input.headingOrder;
  if (headingOrder !== "unordered" && headingOrder !== "strict") fail("PROJECTION_INVALID", `${where}.headingOrder must be unordered or strict`);
  const preserved = extensions(input, new Set(["templateId", "headingOrder", "fields", "headings", "contractDigest", "approvedMarkdownDigest", "extensions", ...RETIRED_LAYER_KEYS, "base", "keyOrder", "bodySignature"]), where, "PROJECTION_INVALID");
  return {
    templateId,
    headingOrder,
    fields: parseResolvedFields(input.fields, `${where}.fields`),
    headings: parseProjectionHeadings(input.headings, `${where}.headings`),
    contractDigest: digest(input.contractDigest, `${where}.contractDigest`, "PROJECTION_INVALID"),
    approvedMarkdownDigest: digest(input.approvedMarkdownDigest, `${where}.approvedMarkdownDigest`, "PROJECTION_INVALID"),
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

export function parseDerivedProjection(input: string | unknown): DerivedProjection {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input) as unknown; } catch { fail("PROJECTION_INVALID", "JSON parse failed"); }
  }
  const root = record(value, "projection", "PROJECTION_INVALID");
  if (root.version !== "oms.types.v2") {
    fail("PROJECTION_INVALID", `${JSON.stringify(root.version)} is unsupported. Derived projection version must be oms.types.v2. oms.types.v1 is not migrated.`);
  }
  const managed = record(root.managed, "managed", "PROJECTION_INVALID");
  if (managed.headingOrder !== "unordered" && managed.headingOrder !== "strict") {
    fail("PROJECTION_INVALID", "managed.headingOrder must be unordered or strict");
  }
  const rawTemplates = record(managed.templates, "managed.templates", "PROJECTION_INVALID");
  const templates: Record<string, DerivedTemplateProjection> = {};
  for (const [key, raw] of Object.entries(rawTemplates)) {
    const parsed = parseProjectionTemplate(raw, key);
    if (Object.hasOwn(templates, parsed.templateId)) fail("TEMPLATE_ID_DUPLICATE", `managed.templates contains canonically equivalent keys for ${parsed.templateId}`);
    templates[parsed.templateId] = parsed;
  }
  const preserved = extensions(root, new Set(["version", "generatedFrom", "managed", "extensions"]), "projection", "PROJECTION_INVALID");
  const managedExtensions = extensions(managed, new Set(["headingOrder", "fields", "headings", "globalAxes", "templates", "extensions"]), "managed", "PROJECTION_INVALID");
  return {
    version: "oms.types.v2",
    generatedFrom: digest(root.generatedFrom, "generatedFrom", "PROJECTION_INVALID"),
    managed: {
      headingOrder: managed.headingOrder,
      fields: parseResolvedFields(managed.fields, "managed.fields"),
      headings: parseProjectionHeadings(managed.headings, "managed.headings"),
      globalAxes: parseAxes(managed.globalAxes),
      templates,
      ...(managedExtensions === undefined ? {} : { extensions: managedExtensions }),
    },
    ...(preserved === undefined ? {} : { extensions: preserved }),
  };
}

function projectionToJson(projection: DerivedProjection): JsonValue {
  return json(projection, "projection", "PROJECTION_INVALID");
}

export function serializeDerivedProjection(projection: DerivedProjection): string {
  return `${JSON.stringify(stable(projectionToJson(parseDerivedProjection(projection))), null, 2)}\n`;
}

export function validateDerivedProjection(input: string | unknown, managed: DerivedProjection["managed"]): DerivedProjection {
  const projection = parseDerivedProjection(input);
  if (JSON.stringify(stable(json(projection.managed, "projection.managed", "PROJECTION_INVALID"))) !== JSON.stringify(stable(json(managed, "managed", "PROJECTION_INVALID")))) {
    fail("PROJECTION_PAYLOAD_TAMPERED", "managed payload does not match the derived projection");
  }
  return projection;
}
