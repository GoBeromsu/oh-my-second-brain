import type { BaseContract, FieldDefault, FieldPolicy, JsonValue, ObsidianContractType } from "./types.js";

export type WriteMode = "create" | "append" | "update";

export interface ResolvedDefaults {
  readonly resolvedAt: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface ResolveDefaultsRequest {
  readonly mode: WriteMode;
  readonly fields: Readonly<Record<string, FieldPolicy>>;
  readonly template: Readonly<Record<string, JsonValue>>;
  readonly caller?: Readonly<Record<string, JsonValue>>;
  readonly resolvedAt?: string;
}

const STRING_TYPES = new Set<ObsidianContractType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<ObsidianContractType>(["list", "multitext", "multi", "tags", "aliases"]);

function fail(code: string, field: string, detail: string): never {
  throw new Error(`${code}: ${field} ${detail}`);
}

function empty(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function dateAt(resolvedAt: string): string {
  return resolvedAt.slice(0, 10);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function compatible(type: ObsidianContractType | undefined, value: JsonValue): boolean {
  if (type === undefined) return true;
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && validDate(value);
  if (type === "datetime") return typeof value === "string" && validInstant(value);
  return LIST_TYPES.has(type) && Array.isArray(value) && (type === "list" || type === "multi" || value.every(item => typeof item === "string"));
}

function normalize(value: JsonValue, policy: FieldPolicy): JsonValue {
  if (policy.normalize === undefined || typeof value !== "string") return value;
  if (policy.normalize === "trim") return value.trim();
  if (policy.normalize === "lower") return value.toLowerCase();
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveDefault(spec: FieldDefault, resolvedAt: string, field: string, caller: Readonly<Record<string, JsonValue>>): JsonValue {
  if (spec.kind === "literal") return spec.value;
  if (spec.token === "today") return dateAt(resolvedAt);
  if (spec.token === "now") return resolvedAt;
  const title = caller.title;
  if (typeof title !== "string" || title.trim() === "") fail("TEMPLATE_TITLE_REQUIRED", field, "requires caller title");
  return title.trim();
}

function validate(field: string, value: JsonValue, policy: FieldPolicy): JsonValue {
  if (!compatible(policy.type, value)) fail("DEFAULT_TYPE_MISMATCH", field, `is incompatible with ${policy.type ?? "its inferred type"}`);
  const normalized = normalize(value, policy);
  if (policy.allowedValues !== undefined && (typeof normalized !== "string" || !policy.allowedValues.includes(normalized))) fail("ALLOWED_VALUE_INVALID", field, "is not an allowed value");
  if (policy.format === "url" && (typeof normalized !== "string" || !validUrl(normalized))) fail("FORMAT_URL_INVALID", field, "is not an http(s) URL");
  return normalized;
}

/** Resolves every dynamic default once and returns a new, immutable preparation value. */
export function resolveDefaults(request: ResolveDefaultsRequest): ResolvedDefaults {
  const resolvedAt = request.resolvedAt ?? new Date().toISOString();
  if (!validInstant(resolvedAt)) throw new Error("RESOLVED_AT_INVALID: resolvedAt must be an ISO instant");
  const caller = request.caller ?? {};
  const result: Record<string, JsonValue> = {};

  for (const [field, policy] of Object.entries(request.fields)) {
    const callerValue = caller[field];
    const templateValue = request.template[field];
    let value: JsonValue | undefined;
    if (!empty(callerValue)) value = callerValue;
    else if (request.mode === "create" && !empty(templateValue)) value = templateValue;
    else if (request.mode === "create" && policy.default !== undefined) value = resolveDefault(policy.default, resolvedAt, field, caller);
    if (value === undefined || empty(value)) {
      if (request.mode === "create" && policy.required === true) fail("FIELD_REQUIRED", field, "is required");
      continue;
    }
    result[field] = validate(field, value, policy);
  }

  for (const [field, value] of Object.entries(caller)) if (!Object.hasOwn(request.fields, field)) result[field] = value;
  return { resolvedAt, fields: result };
}

/** Rejects contract specializations that weaken base invariants. */
export function validateBaseSpecialization(base: BaseContract, specialization: BaseContract): void {
  for (const [field, basePolicy] of Object.entries(base.fields)) {
    const policy = specialization.fields[field];
    if (policy === undefined) continue;
    if (basePolicy.required === true && policy.required === false) fail("BASE_CONTRACT_CONFLICT", field, "weakens required");
    if (basePolicy.immutable === true && policy.immutable === false) fail("BASE_CONTRACT_CONFLICT", field, "weakens immutable");
    if (basePolicy.type !== undefined && policy.type !== undefined && basePolicy.type !== policy.type) fail("BASE_CONTRACT_CONFLICT", field, "changes type");
    if (basePolicy.default !== undefined && policy.default !== undefined && !basePolicy.allowTemplateDefault) fail("BASE_CONTRACT_CONFLICT", field, "specializes a base default without permission");
    if (basePolicy.allowedValues !== undefined && policy.allowedValues !== undefined && policy.allowedValues.some(value => !basePolicy.allowedValues?.includes(value))) fail("BASE_CONTRACT_CONFLICT", field, "widens allowed values");
  }
}
