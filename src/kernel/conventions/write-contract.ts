import type { BaseContract, FieldPolicy, JsonValue, ResolvedTemplate, WriterRegistry } from "../templates/types.js";

export type TemplateContractRule = "required" | "type" | "allowed-values" | "format" | "writer-identity";

export interface TemplateContractViolation {
  readonly field: string;
  readonly rule: TemplateContractRule;
  readonly message: string;
}

export interface TemplateContractResult {
  readonly valid: boolean;
  readonly violations: readonly TemplateContractViolation[];
}

const STRING_TYPES = new Set(["text", "string", "select", "file"]);
const LIST_TYPES = new Set(["list", "multitext", "multi", "tags", "aliases"]);

function valueMatchesType(value: JsonValue, type: FieldPolicy["type"]): boolean {
  if (type === undefined) return true;
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "datetime") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  return LIST_TYPES.has(type) && Array.isArray(value) && (type === "list" || type === "multi" || value.every(item => typeof item === "string"));
}

function empty(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Evaluates resolved template fields while retaining undeclared frontmatter. */
export function evaluateResolvedTemplateContract(
  frontmatter: Readonly<Record<string, JsonValue>>,
  template: ResolvedTemplate,
  base: BaseContract,
  writers?: WriterRegistry,
): TemplateContractResult {
  const violations: TemplateContractViolation[] = [];
  const fields: Record<string, FieldPolicy> = { ...base.fields, ...template.fields };

  for (const [field, policy] of Object.entries(fields)) {
    const value = frontmatter[field];
    if (policy.required === true && empty(value)) {
      violations.push({ field, rule: "required", message: `Field "${field}" is required.` });
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!valueMatchesType(value, policy.type)) {
      violations.push({ field, rule: "type", message: `Field "${field}" must be ${policy.type ?? "a valid value"}.` });
      continue;
    }
    if (policy.allowedValues !== undefined && (typeof value !== "string" || !policy.allowedValues.includes(value))) {
      violations.push({ field, rule: "allowed-values", message: `Field "${field}" is not an allowed value.` });
    }
    if (policy.format === "url" && (typeof value !== "string" || !validUrl(value))) {
      violations.push({ field, rule: "format", message: `Field "${field}" must be an http(s) URL.` });
    }
  }

  if (writers !== undefined) {
    const value = frontmatter[writers.field];
    if (empty(value)) violations.push({ field: writers.field, rule: "writer-identity", message: `Writer field "${writers.field}" is required.` });
    else if (typeof value !== "string" || !writers.identifiers.includes(value)) violations.push({ field: writers.field, rule: "writer-identity", message: `Value "${String(value)}" for writer field "${writers.field}" is not a registered writer identifier.` });
  }

  return { valid: violations.length === 0, violations };
}
