import type {
  BaseContract, ContractDefinition, DerivedProjection, DerivedTemplateProjection, DestinationClass,
  Extensions, FieldDefault, FieldPolicy, GlobalAxes, GlobalAxis, JsonValue, ObsidianContractType,
  RetrievalView, SourceDescriptor, TemplateBinding, TemplateFolderPath, TemplateId, TemplatePolicy,
  TemplateSourcePath, WriterRegistry,
} from "./types.js";
import {
  deriveManagedSourcePath,
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  validateTemplateId,
} from "./paths.js";
import { validateBaseSpecialization } from "./defaults.js";

const TYPES = ["text", "string", "select", "number", "boolean", "checkbox", "date", "datetime", "list", "multitext", "multi", "tags", "aliases", "file"] as const;
const TYPE_SET = new Set<string>(TYPES);
const RESERVED_POLICY = new Set(["version", "templateFolder", "base", "contracts", "templates", "writers", "extensions"]);
const RESERVED_PROJECTION = new Set(["version", "generatedFrom", "managed", "extensions"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export { validateTemplateId } from "./paths.js";

export const TEMPLATE_POLICY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: true,
  required: ["version", "templateFolder", "base", "contracts", "templates"],
  properties: { version: { const: 1 }, templateFolder: { type: "string", minLength: 1 }, base: { type: "object" }, contracts: { type: "object" }, templates: { type: "object" }, writers: { type: "object", required: ["field", "identifiers"] }, extensions: { type: "object", additionalProperties: true } },
} as const;
export const DERIVED_PROJECTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: true,
  required: ["version", "generatedFrom", "managed"],
  properties: { version: { const: "oms.types.v1" }, generatedFrom: { type: "object" }, managed: { type: "object", required: ["base", "templates", "globalAxes"] }, extensions: { type: "object", additionalProperties: true } },
} as const;

function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function record(value: unknown, where: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) fail("TEMPLATE_POLICY_INVALID", `${where} must be an object`); return value as Record<string, unknown>; }
function string(value: unknown, where: string): string { if (typeof value !== "string" || value.trim() === "") fail("TEMPLATE_POLICY_INVALID", `${where} must be a non-empty string`); return value.trim(); }
function json(value: unknown, where: string): JsonValue { if (value === null || typeof value === "string" || typeof value === "boolean") return value; if (typeof value === "number" && Number.isFinite(value)) return value; if (Array.isArray(value)) return value.map((item, index) => json(item, `${where}[${index}]`)); const input = record(value, where); return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, json(item, `${where}.${key}`)])); }
function extensions(input: Record<string, unknown>, reserved: ReadonlySet<string>, where: string): Extensions | undefined {
  const declared = input.extensions === undefined ? {} : record(input.extensions, `${where}.extensions`);
  for (const key of Object.keys(declared)) if (reserved.has(key)) fail("TEMPLATE_EXTENSION_RESERVED", `${where}.extensions.${key} shadows a managed key`);
  const direct = Object.fromEntries(Object.entries(input).filter(([key]) => !reserved.has(key)));
  for (const key of Object.keys(direct)) if (Object.hasOwn(declared, key)) fail("TEMPLATE_EXTENSION_CONFLICT", `${where}.${key} conflicts with extensions.${key}`);
  const merged = { ...direct, ...declared };
  return Object.keys(merged).length === 0 ? undefined : json(merged, `${where}.extensions`) as Extensions;
}
function policyType(value: unknown, where: string): ObsidianContractType { const type = string(value, where); if (!TYPE_SET.has(type)) fail("TEMPLATE_POLICY_INVALID", `${where} must be an Obsidian contract type`); return type as ObsidianContractType; }
function parseDefault(value: unknown, where: string): FieldDefault { const input = record(value, where); if (input.kind === "literal" && Object.keys(input).length === 2 && Object.hasOwn(input, "value")) return { kind: "literal", value: json(input.value, `${where}.value`) }; if (input.kind === "token" && Object.keys(input).length === 2 && (input.token === "today" || input.token === "now" || input.token === "title")) return { kind: "token", token: input.token }; fail("TEMPLATE_POLICY_INVALID", `${where} must be a supported literal or token default`); }
function compatible(type: ObsidianContractType, value: JsonValue): boolean {
  if (type === "number") return typeof value === "number";
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (["list", "multitext", "multi", "tags", "aliases"].includes(type)) return Array.isArray(value) && value.every(item => typeof item === "string");
  return typeof value === "string";
}
function parseField(value: unknown, where: string): FieldPolicy {
  const input = record(value, where); const reserved = new Set(["type", "required", "normalize", "allowedValues", "format", "default", "allowTemplateDefault", "immutable", "intent", "extensions"]);
  const type = input.type === undefined ? undefined : policyType(input.type, `${where}.type`);
  const required = input.required === undefined ? undefined : input.required;
  if (required !== undefined && typeof required !== "boolean") fail("TEMPLATE_POLICY_INVALID", `${where}.required must be boolean`);
  const normalize = input.normalize === undefined ? undefined : input.normalize;
  if (normalize !== undefined && normalize !== "lower" && normalize !== "trim" && normalize !== "kebab") fail("TEMPLATE_POLICY_INVALID", `${where}.normalize is invalid`);
  const allowedValues = input.allowedValues === undefined ? undefined : input.allowedValues;
  if (allowedValues !== undefined && (!Array.isArray(allowedValues) || allowedValues.some(item => typeof item !== "string" || item.trim() === ""))) fail("TEMPLATE_POLICY_INVALID", `${where}.allowedValues must contain non-empty strings`);
  const format = input.format === undefined ? undefined : input.format;
  if (format !== undefined && format !== "url") fail("TEMPLATE_POLICY_INVALID", `${where}.format is invalid`);
  const defaultValue = input.default === undefined ? undefined : parseDefault(input.default, `${where}.default`);
  if (type !== undefined && defaultValue?.kind === "literal" && !compatible(type, defaultValue.value)) fail("DEFAULT_TYPE_MISMATCH", `${where}.default is incompatible with ${type}`);
  if (format === "url" && defaultValue?.kind === "literal" && (typeof defaultValue.value !== "string" || !validUrl(defaultValue.value))) fail("FORMAT_URL_INVALID", `${where}.default is not a URL`);
  const allowTemplateDefault = input.allowTemplateDefault === undefined ? undefined : input.allowTemplateDefault;
  const immutable = input.immutable === undefined ? undefined : input.immutable;
  if (allowTemplateDefault !== undefined && typeof allowTemplateDefault !== "boolean") fail("TEMPLATE_POLICY_INVALID", `${where}.allowTemplateDefault must be boolean`);
  if (immutable !== undefined && typeof immutable !== "boolean") fail("TEMPLATE_POLICY_INVALID", `${where}.immutable must be boolean`);
  const intent = input.intent === undefined ? undefined : string(input.intent, `${where}.intent`);
  return { ...(type === undefined ? {} : { type }), ...(required === undefined ? {} : { required }), ...(normalize === undefined ? {} : { normalize }), ...(allowedValues === undefined ? {} : { allowedValues: [...allowedValues] as readonly string[] }), ...(format === undefined ? {} : { format }), ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(allowTemplateDefault === undefined ? {} : { allowTemplateDefault }), ...(immutable === undefined ? {} : { immutable }), ...(intent === undefined ? {} : { intent }), ...(extensions(input, reserved, where) === undefined ? {} : { extensions: extensions(input, reserved, where) }) };
}
function validUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
function parseBase(value: unknown, where: string, managedKeys: readonly string[] = []): BaseContract {
  const input = record(value, where);
  const fields = record(input.fields, `${where}.fields`);
  const parsed: Record<string, FieldPolicy> = {};
  for (const [key, field] of Object.entries(fields)) parsed[string(key, `${where}.fields key`)] = parseField(field, `${where}.fields.${key}`);
  const reserved = new Set(["fields", "extensions", ...managedKeys]);
  const preserved = extensions(input, reserved, where);
  return { fields: parsed, ...(preserved === undefined ? {} : { extensions: preserved }) };
}
function parseWriters(value: unknown, where: string): WriterRegistry {
  const input = record(value, where);
  const field = string(input.field, `${where}.field`);
  if (!Array.isArray(input.identifiers) || input.identifiers.length === 0) fail("TEMPLATE_POLICY_INVALID", `${where}.identifiers must be a non-empty array of unique non-empty strings`);
  const identifiers = input.identifiers.map((identifier, index) => string(identifier, `${where}.identifiers[${index}]`));
  if (new Set(identifiers).size !== identifiers.length) fail("TEMPLATE_POLICY_INVALID", `${where}.identifiers must contain unique strings`);
  return { field, identifiers };
}
function parseViews(value: unknown, where: string, fields: Readonly<Record<string, FieldPolicy>>): readonly RetrievalView[] { if (!Array.isArray(value)) fail("TEMPLATE_POLICY_INVALID", `${where} must be an array`); const names = new Set<string>(); return value.map((item, index) => { const input = record(item, `${where}[${index}]`); const name = string(input.name, `${where}[${index}].name`); if (names.has(name)) fail("TEMPLATE_POLICY_INVALID", `${where} contains duplicate view ${name}`); names.add(name); if (!Array.isArray(input.keys) || input.keys.some(key => typeof key !== "string" || !Object.hasOwn(fields, key))) fail("TEMPLATE_POLICY_DANGLING_FIELD", `${where}[${index}].keys references an unknown field`); return { name, keys: [...input.keys], ...(extensions(input, new Set(["name", "keys", "extensions"]), `${where}[${index}]`) === undefined ? {} : { extensions: extensions(input, new Set(["name", "keys", "extensions"]), `${where}[${index}]`) }) }; }); }
function merge(base: BaseContract, contract: ContractDefinition, _name: string): void {
  validateBaseSpecialization(base, { fields: contract.fields });
}
function parseBinding(value: unknown, where: string, folder: TemplateFolderPath, key: string, contracts: Readonly<Record<string, ContractDefinition>>): TemplateBinding { const input = record(value, where); const id = validateTemplateId(string(input.templateId, `${where}.templateId`)); if (id !== key) fail("TEMPLATE_POLICY_INVALID", `${where}.templateId must equal its stable map key`); const destinationClass = input.destinationClass; if (destinationClass !== "managed-default" && destinationClass !== "registered-existing") fail("TEMPLATE_POLICY_INVALID", `${where}.destinationClass is invalid`); const source = normalizeTemplateSourcePath(string(input.sourcePath, `${where}.sourcePath`)); if (destinationClass === "managed-default" && source !== deriveManagedSourcePath(folder, id)) fail("TEMPLATE_RECLASSIFY_PATH_MISMATCH", `${where}.sourcePath must be ${deriveManagedSourcePath(folder, id)}`); const contract = string(input.contract, `${where}.contract`); if (!Object.hasOwn(contracts, contract)) fail("TEMPLATE_POLICY_INVALID", `${where}.contract does not exist`); return { templateId: id, destinationClass: destinationClass as DestinationClass, sourcePath: source, contract, naming: string(input.naming, `${where}.naming`), ...(extensions(input, new Set(["templateId", "destinationClass", "sourcePath", "contract", "naming", "extensions"]), where) === undefined ? {} : { extensions: extensions(input, new Set(["templateId", "destinationClass", "sourcePath", "contract", "naming", "extensions"]), where) }) }; }

export function parseTemplatePolicy(input: string | unknown): TemplatePolicy { let value: unknown = input; if (typeof input === "string") try { value = JSON.parse(input) as unknown; } catch { fail("TEMPLATE_POLICY_INVALID", "JSON parse failed"); } const root = record(value, "policy"); if (root.version !== 1) fail("TEMPLATE_POLICY_INVALID", "policy.version must be 1"); const folder = normalizeTemplateFolderPath(string(root.templateFolder, "policy.templateFolder")); const base = parseBase(root.base, "policy.base"); const rawContracts = record(root.contracts, "policy.contracts"); const contracts: Record<string, ContractDefinition> = {}; for (const [name, raw] of Object.entries(rawContracts)) { const parsed = parseBase(raw, `policy.contracts.${name}`, ["intent", "views"]); const source = record(raw, `policy.contracts.${name}`); const fields = { ...base.fields, ...parsed.fields }; const contract = { ...parsed, intent: string(source.intent, `policy.contracts.${name}.intent`), views: parseViews(source.views, `policy.contracts.${name}.views`, fields) }; merge(base, contract, name); contracts[string(name, "policy.contracts key")] = contract; } const rawTemplates = record(root.templates, "policy.templates"); const templates: Record<string, TemplateBinding> = {}; const sources = new Set<string>(); for (const [key, binding] of Object.entries(rawTemplates)) { const parsed = parseBinding(binding, `policy.templates.${key}`, folder, key, contracts); if (sources.has(parsed.sourcePath)) fail("TEMPLATE_SOURCE_DUPLICATE", `${parsed.sourcePath} is bound more than once`); sources.add(parsed.sourcePath); templates[key] = parsed; } const writers = root.writers === undefined ? undefined : parseWriters(root.writers, "policy.writers"); return { version: 1, templateFolder: folder, base, contracts, templates, ...(writers === undefined ? {} : { writers }), ...(extensions(root, RESERVED_POLICY, "policy") === undefined ? {} : { extensions: extensions(root, RESERVED_POLICY, "policy") }) }; }
function stable(value: JsonValue): JsonValue { if (Array.isArray(value)) return value.map(stable); if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => [key, stable(member)])); return value; }
export function serializeTemplatePolicy(policy: TemplatePolicy): string { return `${JSON.stringify(stable(policyToJson(parseTemplatePolicy(policy))), null, 2)}\n`; }
function policyToJson(policy: TemplatePolicy): JsonValue {
  return json({
    version: policy.version,
    templateFolder: policy.templateFolder,
    base: policy.base,
    contracts: Object.fromEntries(
      Object.entries(policy.contracts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    templates: Object.fromEntries(
      Object.entries(policy.templates).sort(([left], [right]) => left.localeCompare(right)),
    ),
    ...(policy.writers === undefined ? {} : { writers: policy.writers }),
    ...(policy.extensions === undefined ? {} : { extensions: policy.extensions }),
  }, "policy");
}
function parseSources(value: unknown): readonly SourceDescriptor[] {
  if (!Array.isArray(value)) fail("PROJECTION_INVALID", "generatedFrom.sources must be an array");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const where = `generatedFrom.sources[${index}]`;
    const source = record(item, where);
    const signature = string(source.signature, `${where}.signature`);
    if (!DIGEST.test(signature)) fail("PROJECTION_INVALID", `${where}.signature is invalid`);
    const hasPath = source.path !== undefined;
    const hasLogicalId = source.logicalId !== undefined;
    if (hasPath === hasLogicalId) fail("PROJECTION_INVALID", `${where} must contain exactly one of path or logicalId`);
    if (hasPath) {
      const sourcePath = normalizeTemplateSourcePath(string(source.path, `${where}.path`));
      if (seen.has(`path:${sourcePath}`)) fail("PROJECTION_INVALID", `generatedFrom.sources contains duplicate path ${sourcePath}`);
      seen.add(`path:${sourcePath}`);
      return {
        path: sourcePath,
        signature: signature as `sha256:${string}`,
        ...(extensions(source, new Set(["path", "signature", "extensions"]), where) === undefined ? {} : { extensions: extensions(source, new Set(["path", "signature", "extensions"]), where) }),
      };
    }
    const logicalId = string(source.logicalId, `${where}.logicalId`);
    try { validateTemplateId(logicalId); } catch { fail("PROJECTION_INVALID", `${where}.logicalId must be a stable logical identifier`); }
    if (seen.has(`logical:${logicalId}`)) fail("PROJECTION_INVALID", `generatedFrom.sources contains duplicate logicalId ${logicalId}`);
    seen.add(`logical:${logicalId}`);
    return {
      logicalId,
      signature: signature as `sha256:${string}`,
      ...(extensions(source, new Set(["logicalId", "signature", "extensions"]), where) === undefined ? {} : { extensions: extensions(source, new Set(["logicalId", "signature", "extensions"]), where) }),
    };
  });
}
export function parseDerivedProjection(input: string | unknown): DerivedProjection {
  let value: unknown = input;
  if (typeof input === "string") try { value = JSON.parse(input) as unknown; } catch { fail("PROJECTION_INVALID", "JSON parse failed"); }
  const root = record(value, "projection");
  if (root.version !== "oms.types.v1") fail("PROJECTION_INVALID", "version must be oms.types.v1");
  const generated = record(root.generatedFrom, "generatedFrom");
  if (generated.algorithm !== "sha256-lp-v1" || typeof generated.inputSignature !== "string" || !DIGEST.test(generated.inputSignature)) fail("PROJECTION_INVALID", "generatedFrom is invalid");
  const managed = record(root.managed, "managed");
  if (typeof managed.globalAxes !== "object" || managed.globalAxes === null || Array.isArray(managed.globalAxes)) fail("PROJECTION_INVALID", "managed.globalAxes must be an object");
  const base = parseBase(managed.base, "managed.base");
  const rawTemplates = record(managed.templates, "managed.templates");
  const templates: Record<string, DerivedTemplateProjection> = {};
  const paths = new Set<string>();
  for (const [id, raw] of Object.entries(rawTemplates)) {
    const item = record(raw, `managed.templates.${id}`);
    const folder = normalizeTemplateFolderPath(string(item.targetFolder, `managed.templates.${id}.targetFolder`));
    const templateId = validateTemplateId(string(item.templateId, `managed.templates.${id}.templateId`));
    if (templateId !== id) fail("PROJECTION_INVALID", `managed.templates.${id}.templateId must equal its stable map key`);
    if (item.destinationClass !== "managed-default" && item.destinationClass !== "registered-existing") fail("PROJECTION_INVALID", `managed.templates.${id}.destinationClass is invalid`);
    const destinationClass = item.destinationClass as DestinationClass;
    const sourcePath = normalizeTemplateSourcePath(string(item.sourcePath, `managed.templates.${id}.sourcePath`));
    const naming = string(item.naming, `managed.templates.${id}.naming`);
    const preserved = extensions(item, new Set(["templateId", "destinationClass", "sourcePath", "targetFolder", "keyOrder", "fields", "views", "naming", "bodySignature", "extensions"]), `managed.templates.${id}`);
    const template = { templateId, destinationClass, sourcePath, naming, ...(preserved === undefined ? {} : { extensions: preserved }) };
    if (!Array.isArray(item.keyOrder) || item.keyOrder.some(key => typeof key !== "string")) fail("PROJECTION_INVALID", `managed.templates.${id}.keyOrder is invalid`);
    const fields = parseBase({ fields: item.fields }, `managed.templates.${id}`).fields;
    const views = parseViews(item.views, `managed.templates.${id}.views`, fields);
    const bodySignature = string(item.bodySignature, `managed.templates.${id}.bodySignature`);
    if (!DIGEST.test(bodySignature)) fail("PROJECTION_INVALID", `managed.templates.${id}.bodySignature is invalid`);
    if (paths.has(template.sourcePath)) fail("TEMPLATE_SOURCE_DUPLICATE", `${template.sourcePath} is repeated`);
    paths.add(template.sourcePath);
    templates[id] = { ...template, targetFolder: folder as TemplateFolderPath, keyOrder: [...item.keyOrder], fields, views, bodySignature: bodySignature as `sha256:${string}` };
  }
  const rawAxes = managed.globalAxes as Record<string, unknown>;
  const globalAxes: Record<string, GlobalAxis> = {};
  for (const [name, raw] of Object.entries(rawAxes)) {
    const axis = record(raw, `managed.globalAxes.${name}`);
    if ((axis.kind !== "folder" && axis.kind !== "link") || !Array.isArray(axis.members)) fail("PROJECTION_INVALID", `managed.globalAxes.${name} is invalid`);
    globalAxes[name] = {
      kind: axis.kind,
      key: string(axis.key, `managed.globalAxes.${name}.key`),
      type: policyType(axis.type, `managed.globalAxes.${name}.type`),
      ...(axis.intent === undefined ? {} : { intent: string(axis.intent, `managed.globalAxes.${name}.intent`) }),
      members: axis.members.map((member, index) => json(member, `managed.globalAxes.${name}.members[${index}]`)),
      ...(extensions(axis, new Set(["kind", "key", "type", "intent", "members", "extensions"]), `managed.globalAxes.${name}`) === undefined ? {} : { extensions: extensions(axis, new Set(["kind", "key", "type", "intent", "members", "extensions"]), `managed.globalAxes.${name}`) }),
    };
  }
  return {
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: generated.inputSignature as `sha256:${string}`, sources: parseSources(generated.sources) },
    managed: { base, templates, globalAxes },
    ...(extensions(root, RESERVED_PROJECTION, "projection") === undefined ? {} : { extensions: extensions(root, RESERVED_PROJECTION, "projection") }),
  };
}
function projectionToJson(projection: DerivedProjection): JsonValue {
  return json(projection, "projection");
}

export function serializeDerivedProjection(projection: DerivedProjection): string {
  return `${JSON.stringify(stable(projectionToJson(parseDerivedProjection(projection))), null, 2)}\n`;
}
export function validateDerivedProjection(input: string | unknown, managed: DerivedProjection["managed"]): DerivedProjection {
  const projection = parseDerivedProjection(input);
  if (JSON.stringify(stable(json(projection.managed, "projection.managed"))) !== JSON.stringify(stable(json(managed, "managed")))) {
    fail("PROJECTION_PAYLOAD_TAMPERED", "managed payload does not match the derived projection");
  }
  return projection;
}

/** Applies only binding and folder semantics; bytes and publication are resolver concerns. */
export function applyTemplatePolicyChange(current: TemplatePolicy, change: import("./types.js").TemplateSemanticChange): TemplatePolicy {
  const templates: Record<string, TemplateBinding> = { ...current.templates };
  if (change.mode === "create") {
    if (templates[change.binding.templateId] !== undefined) fail("TEMPLATE_ID_DUPLICATE", `template ${change.binding.templateId} already exists`);
    templates[change.binding.templateId] = change.binding;
  } else if (change.mode === "update") {
    if (change.templateId !== change.binding.templateId) fail("TEMPLATE_IDENTITY_IMMUTABLE", "templateId cannot change");
    if (templates[change.templateId] === undefined) fail("TEMPLATE_SOURCE_INVALID", "template does not exist");
    templates[change.templateId] = change.binding;
  } else if (change.mode === "reclassify") {
    const binding = templates[change.templateId];
    if (binding === undefined) fail("TEMPLATE_SOURCE_INVALID", "template does not exist");
    if (change.toClass === "managed-default" && binding.sourcePath !== deriveManagedSourcePath(current.templateFolder, binding.templateId)) {
      fail("TEMPLATE_RECLASSIFY_PATH_MISMATCH", "move or relocate before reclassifying to managed-default");
    }
    templates[change.templateId] = { ...binding, destinationClass: change.toClass };
  } else {
    const folder = normalizeTemplateFolderPath(change.templateFolder);
    if (!Object.values(templates).some(binding => binding.destinationClass === "managed-default")) return current;
    for (const [id, binding] of Object.entries(templates)) {
      if (binding.destinationClass === "managed-default") templates[id] = { ...binding, sourcePath: deriveManagedSourcePath(folder, binding.templateId) };
    }
    return parseTemplatePolicy({ ...current, templateFolder: folder, templates });
  }
  return parseTemplatePolicy({ ...current, templates });
}
