import { digestBytes, parseDigest } from "./canonical.js";
import { parseLegacyJson } from "./legacy-json.js";
import { normalizeTemplateSourcePath, validateTemplateId } from "./paths.js";
import type { Digest, JsonValue, ObsidianContractType } from "./types.js";

export type ValuePolicy = "free" | "suggest" | "closed";
export type AdditionalHeadings = "subordinate" | "allow";

export interface FieldRulesV5 {
  readonly type?: ObsidianContractType;
  readonly intent?: string;
  readonly required?: boolean;
  readonly valuePolicy?: ValuePolicy;
  readonly allowedValues?: readonly string[] | null;
  readonly format?: "url" | null;
  readonly minItems?: number | null;
  readonly maxItems?: number | null;
  readonly minimum?: number | null;
  readonly maximum?: number | null;
}
export interface PropertyDefinitionV5 extends FieldRulesV5 {
  readonly type: ObsidianContractType;
}
export interface FieldRefV5 extends FieldRulesV5 {
  readonly property?: string;
}
export interface HeadingV5 {
  readonly headingId: string;
  readonly title?: string;
  /** An agent supplies this declared slot before writing; it never replaces a fixed title. */
  readonly binding?: string;
  readonly level: number;
  readonly required?: boolean;
}
export interface ContractRulesV5 {
  readonly fields: Readonly<Record<string, FieldRefV5>>;
  /** Omitted inherits; an explicit array replaces, rather than appends to, common headings. */
  readonly headings?: readonly HeadingV5[];
  readonly headingOrder?: "strict" | "unordered";
  /** Omitted inherits; selected overrides common, otherwise subordinate. */
  readonly additionalHeadings?: AdditionalHeadings;
}

export interface ActiveCommonContractV5 extends ContractRulesV5 {
  readonly status: "active";
}
export interface ContractSourceV5 {
  readonly identity: string;
  readonly path: string;
  readonly rawDigest: Digest;
}
export interface ActiveTemplateContractV5 extends ContractRulesV5 {
  readonly status: "active";
  readonly source: ContractSourceV5;
}
export interface ReviewRequiredContractV5 {
  readonly status: "review-required";
  readonly reasons: readonly string[];
  /** Historical evidence, never executable or a substitute for an active contract. */
  readonly legacy: JsonValue;
}
export type CommonContractV5 = ActiveCommonContractV5 | ReviewRequiredContractV5;
export type RegisteredContractV5 = ActiveTemplateContractV5 | ReviewRequiredContractV5;
export interface ContractPolicyV5 {
  readonly version: 5;
  readonly revision: number;
  readonly properties: Readonly<Record<string, PropertyDefinitionV5>>;
  readonly common: CommonContractV5;
  readonly templates: Readonly<Record<string, RegisteredContractV5>>;
}
export interface EffectiveFieldV5 extends FieldRulesV5 {
  readonly property: string;
  readonly type: ObsidianContractType;
  readonly required: boolean;
  readonly valuePolicy: ValuePolicy;
}
export interface EffectiveContractV5 {
  readonly templateId: string | null;
  readonly fields: Readonly<Record<string, EffectiveFieldV5>>;
  readonly headings: readonly HeadingV5[];
  readonly headingOrder: "strict" | "unordered";
  readonly additionalHeadings: AdditionalHeadings;
  readonly contractDigest: Digest;
}
export type ContractV5ErrorCode = "CONTRACT_POLICY_INVALID" | "CONTRACT_VERSION_UNSUPPORTED" | "CONTRACT_REVIEW_REQUIRED" | "CONTRACT_UNKNOWN_TEMPLATE";
export class ContractV5Error extends Error {
  constructor(readonly code: ContractV5ErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ContractV5Error";
  }
}

const TYPES = new Set<ObsidianContractType>(["text", "string", "select", "number", "boolean", "checkbox", "date", "datetime", "list", "multitext", "multi", "tags", "aliases", "file"]);
const LIST_TYPES = new Set<ObsidianContractType>(["list", "multitext", "multi", "tags", "aliases"]);
const STRING_TYPES = new Set<ObsidianContractType>(["text", "string", "select", "file"]);
const RULE_KEYS = ["type", "intent", "required", "valuePolicy", "allowedValues", "format", "minItems", "maxItems", "minimum", "maximum"] as const;

function invalid(message: string): never {
  throw new ContractV5Error("CONTRACT_POLICY_INVALID", message);
}
function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f]/u.test(value)) invalid(`${where} must be non-empty text without control characters`);
}

/** Validate before cloning: JSON.stringify alone would silently drop undefined or coerce NaN. */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("non-finite JSON number");
    return;
  }
  if (typeof value !== "object") invalid("only JSON values may be stored in a contract policy");
  if (ancestors.has(value)) invalid("cyclic policy value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid("policy objects must be plain JSON objects");
  if (Object.getOwnPropertySymbols(value).length) invalid("symbol policy members are not JSON");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const member of value) assertJson(member, ancestors);
  } else {
    for (const member of Object.values(value)) assertJson(member, ancestors);
  }
  ancestors.delete(value);
}

function validateRules(value: Record<string, unknown>, where: string): void {
  if (Object.hasOwn(value, "type") && !TYPES.has(value.type as ObsidianContractType)) invalid(`${where}.type is unsupported`);
  if (Object.hasOwn(value, "intent") && typeof value.intent !== "string") invalid(`${where}.intent must be text`);
  if (Object.hasOwn(value, "required") && typeof value.required !== "boolean") invalid(`${where}.required must be boolean`);
  if (Object.hasOwn(value, "valuePolicy") && !["free", "suggest", "closed"].includes(value.valuePolicy as string)) invalid(`${where}.valuePolicy must be free, suggest or closed`);
  if (Object.hasOwn(value, "allowedValues") && value.allowedValues !== null) {
    if (!Array.isArray(value.allowedValues) || !value.allowedValues.every(member => typeof member === "string")) invalid(`${where}.allowedValues must be a string array or null`);
    if (new Set(value.allowedValues).size !== value.allowedValues.length) invalid(`${where}.allowedValues has duplicates`);
  }
  if (Object.hasOwn(value, "format") && value.format !== null && value.format !== "url") invalid(`${where}.format must be url or null`);
  for (const key of ["minItems", "maxItems", "minimum", "maximum"] as const) {
    if (!Object.hasOwn(value, key) || value[key] === null) continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) invalid(`${where}.${key} must be a finite number or null`);
    if ((key === "minItems" || key === "maxItems") && (!Number.isSafeInteger(number) || number < 0)) invalid(`${where}.${key} must be a non-negative safe integer or null`);
  }
}
function validateHeadings(value: unknown, where: string): void {
  if (!Array.isArray(value)) invalid(`${where} must be an array`);
  const ids = new Set<string>();
  const bindings = new Set<string>();
  for (const [index, member] of value.entries()) {
    const heading = record(member, `${where}[${index}]`);
    nonempty(heading.headingId, `${where}[${index}].headingId`);
    if (ids.has(heading.headingId)) invalid(`${where} contains duplicate heading ids`);
    ids.add(heading.headingId);
    if (!Number.isInteger(heading.level) || Number(heading.level) < 1 || Number(heading.level) > 6) invalid(`${where}[${index}].level must be 1..6`);
    const fixed = Object.hasOwn(heading, "title");
    const dynamic = Object.hasOwn(heading, "binding");
    if (fixed === dynamic) invalid(`${where}[${index}] needs exactly one of title or binding`);
    if (fixed) nonempty(heading.title, `${where}[${index}].title`);
    if (dynamic) {
      nonempty(heading.binding, `${where}[${index}].binding`);
      if (bindings.has(heading.binding)) invalid(`${where} contains duplicate binding slots`);
      bindings.add(heading.binding);
    }
    if (Object.hasOwn(heading, "required") && typeof heading.required !== "boolean") invalid(`${where}[${index}].required must be boolean`);
  }
}
function validateLayer(value: unknown, where: string, individual: boolean): void {
  const layer = record(value, where);
  if (layer.status === "review-required") {
    if (!Array.isArray(layer.reasons) || layer.reasons.length === 0) invalid(`${where}.reasons must identify the unresolved rules`);
    for (const reason of layer.reasons) nonempty(reason, `${where}.reasons`);
    if (!Object.hasOwn(layer, "legacy")) invalid(`${where} must preserve legacy evidence`);
    return;
  }
  if (layer.status !== "active") invalid(`${where}.status must be active or review-required`);
  for (const [field, member] of Object.entries(record(layer.fields, `${where}.fields`))) {
    nonempty(field, `${where}.fields key`);
    const ref = record(member, `${where}.fields.${field}`);
    if (Object.hasOwn(ref, "property")) nonempty(ref.property, `${where}.fields.${field}.property`);
    validateRules(ref, `${where}.fields.${field}`);
  }
  if (Object.hasOwn(layer, "headings")) validateHeadings(layer.headings, `${where}.headings`);
  if (Object.hasOwn(layer, "headingOrder") && layer.headingOrder !== "strict" && layer.headingOrder !== "unordered") invalid(`${where}.headingOrder must be strict or unordered`);
  if (Object.hasOwn(layer, "additionalHeadings") && layer.additionalHeadings !== "subordinate" && layer.additionalHeadings !== "allow") invalid(`${where}.additionalHeadings must be subordinate or allow`);
  if (individual) {
    const source = record(layer.source, `${where}.source`);
    nonempty(source.identity, `${where}.source.identity`);
    nonempty(source.path, `${where}.source.path`);
    try {
      if (normalizeTemplateSourcePath(source.path) !== source.path) invalid(`${where}.source.path must be canonical and vault-relative`);
      if (typeof source.rawDigest !== "string") invalid(`${where}.source.rawDigest must be a SHA-256 digest`);
      parseDigest(source.rawDigest);
    } catch (error) {
      invalid(`${where}.source: ${error instanceof Error ? error.message : "invalid source"}`);
    }
  }
}

function effectiveRules(...layers: readonly FieldRulesV5[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const key of RULE_KEYS) if (Object.hasOwn(layer, key)) result[key] = layer[key];
  }
  return result;
}
function validateEffectiveField(field: EffectiveFieldV5, where: string): void {
  if (field.valuePolicy === "closed" && field.allowedValues == null) invalid(`${where}: closed values require an explicit allowedValues array`);
  if (field.minItems != null && field.maxItems != null && field.minItems > field.maxItems) invalid(`${where}: minItems exceeds maxItems`);
  if (field.minimum != null && field.maximum != null && field.minimum > field.maximum) invalid(`${where}: minimum exceeds maximum`);
  if ((field.minItems != null || field.maxItems != null) && !LIST_TYPES.has(field.type)) invalid(`${where}: item limits require a list property`);
  if ((field.minimum != null || field.maximum != null) && field.type !== "number") invalid(`${where}: numeric limits require a number property`);
  if (field.format === "url" && !STRING_TYPES.has(field.type)) invalid(`${where}: URL format requires a string property`);
}

function composeActive(policy: ContractPolicyV5, templateId: string | null): Omit<EffectiveContractV5, "contractDigest"> {
  const selected = templateId === null ? undefined : policy.templates[templateId];
  if (templateId !== null && (!Object.hasOwn(policy.templates, templateId) || selected === undefined)) throw new ContractV5Error("CONTRACT_UNKNOWN_TEMPLATE", `template '${templateId}' is not registered`);
  if (policy.common.status !== "active") throw new ContractV5Error("CONTRACT_REVIEW_REQUIRED", "common rules require review before selecting any contract");
  if (selected?.status === "review-required") throw new ContractV5Error("CONTRACT_REVIEW_REQUIRED", `template '${templateId}' requires review`);
  const common = policy.common;
  const fields: Record<string, EffectiveFieldV5> = Object.create(null);
  const names = new Set([...Object.keys(common.fields), ...Object.keys(selected?.fields ?? {})]);
  for (const name of names) {
    const base = Object.hasOwn(common.fields, name) ? common.fields[name] : undefined;
    const override = selected && Object.hasOwn(selected.fields, name) ? selected.fields[name] : undefined;
    const property = override?.property ?? base?.property ?? name;
    if (!Object.hasOwn(policy.properties, property)) invalid(`field '${name}' references unknown property '${property}'`);
    const pool = policy.properties[property]!;
    const rules = effectiveRules(pool, base ?? {}, override ?? {});
    const field = { ...rules, property, required: rules.required ?? false, valuePolicy: rules.valuePolicy ?? "free" } as EffectiveFieldV5;
    validateEffectiveField(field, `field '${name}'`);
    fields[name] = field;
  }
  return {
    templateId,
    fields,
    headings: selected?.headings ?? common.headings ?? [],
    headingOrder: selected?.headingOrder ?? common.headingOrder ?? "strict",
    additionalHeadings: selected?.additionalHeadings ?? common.additionalHeadings ?? "subordinate",
  };
}

/** Pure parser. It neither reads sources nor publishes/migrates control files. */
export function parseContractPolicyV5(input: string | unknown): ContractPolicyV5 {
  let decoded: unknown = input;
  if (typeof input === "string") {
    let parsed: ReturnType<typeof parseLegacyJson>;
    try { parsed = parseLegacyJson(input); }
    catch { invalid("policy is not valid JSON"); }
    // JSON.parse last-wins is not authority. Only an exhaustively unique raw document may be decoded.
    if (parsed.members !== "unique") invalid("policy JSON contains ambiguous or duplicate members and cannot authorize a contract");
    decoded = parsed.value;
  }
  assertJson(decoded);
  const document = JSON.parse(JSON.stringify(decoded)) as unknown;
  const root = record(document, "policy");
  if (root.version !== 5) throw new ContractV5Error("CONTRACT_VERSION_UNSUPPORTED", "expected version 5; legacy policies require explicit migration");
  if (!Number.isSafeInteger(root.revision) || Number(root.revision) < 0) invalid("policy.revision must be a non-negative safe integer");
  const properties = record(root.properties, "policy.properties");
  for (const [name, value] of Object.entries(properties)) {
    nonempty(name, "property name");
    const property = record(value, `properties.${name}`);
    if (!Object.hasOwn(property, "type")) invalid(`properties.${name}.type is required`);
    validateRules(property, `properties.${name}`);
  }
  validateLayer(root.common, "policy.common", false);
  const templates = record(root.templates, "policy.templates");
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const [id, value] of Object.entries(templates)) {
    try { if (validateTemplateId(id) !== id) invalid(`template id '${id}' is not canonical`); }
    catch (error) { invalid(error instanceof Error ? error.message : "invalid template id"); }
    validateLayer(value, `templates.${id}`, true);
    const entry = value as ActiveTemplateContractV5 | ReviewRequiredContractV5;
    if (entry.status === "active") {
      if (identities.has(entry.source.identity) || paths.has(entry.source.path)) invalid("registered templates must have unique source identities and paths");
      identities.add(entry.source.identity);
      paths.add(entry.source.path);
    }
  }
  const policy = document as ContractPolicyV5;
  if (policy.common.status === "active") {
    composeActive(policy, null);
    for (const [id, entry] of Object.entries(policy.templates)) if (entry.status === "active") composeActive(policy, id);
  }
  return policy;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, member]) => [key, sortedJson(member)]));
  return value;
}

/** Unknown JSON members remain user-owned and round-trip unchanged. */
export function serializeContractPolicyV5(policy: ContractPolicyV5): string {
  return `${JSON.stringify(sortedJson(parseContractPolicyV5(policy)), null, 2)}\n`;
}

export function composeContractV5(input: ContractPolicyV5, templateId: string | null): EffectiveContractV5 {
  const policy = parseContractPolicyV5(input);
  const effective = composeActive(policy, templateId);
  // Exact JSON strings preserve user text; legacy canonicalJson intentionally only supports integers.
  const contractDigest = digestBytes(`oms.contract.v5\n${JSON.stringify(sortedJson(effective))}`);
  return { ...effective, contractDigest };
}
