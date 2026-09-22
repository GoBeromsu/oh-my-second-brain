import { evaluateTemplateBodyContract } from "../templates/content-contract.js";
import type { JsonValue, ObsidianContractType, ResolvedContract } from "../templates/types.js";

export type TemplateContractRule = "required" | "type" | "allowed-values" | "format" | "heading";
export interface TemplateContractViolation {
  readonly field: string;
  readonly rule: TemplateContractRule;
  readonly message: string;
}
export interface TemplateContractResult {
  readonly valid: boolean;
  readonly violations: readonly TemplateContractViolation[];
}
const STRING_TYPES = new Set<ObsidianContractType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<ObsidianContractType>(["list", "multitext", "multi", "tags", "aliases"]);

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function valueMatchesType(value: JsonValue, type: ObsidianContractType): boolean {
  if (STRING_TYPES.has(type)) return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "checkbox") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && validDate(value);
  if (type === "datetime") return typeof value === "string" && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
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

/** Reads only managed fields and the complete saved body. Never fills, normalizes, or strips note values. */
export function evaluateResolvedTemplateContract(
  frontmatter: Readonly<Record<string, JsonValue>>,
  contract: ResolvedContract,
  body: string,
): TemplateContractResult {
  if (typeof body !== "string") throw new TypeError("The complete saved note body is required for contract validation");
  const violations: TemplateContractViolation[] = [];
  for (const [field, policy] of Object.entries(contract.fields)) {
    const value = Object.hasOwn(frontmatter, field) ? frontmatter[field] : undefined;
    if (policy.required && empty(value)) {
      violations.push({ field, rule: "required", message: `Field "${field}" is required.` });
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!valueMatchesType(value, policy.type)) {
      violations.push({ field, rule: "type", message: `Field "${field}" must be ${policy.type}.` });
      continue;
    }
    if (policy.allowedValues !== undefined) {
      const values = Array.isArray(value) ? value : [value];
      if (!values.every(member => typeof member === "string" && policy.allowedValues!.includes(member))) {
        violations.push({ field, rule: "allowed-values", message: `Field "${field}" contains a value outside the approved set.` });
      }
    }
    if (policy.format === "url" && (typeof value !== "string" || !validUrl(value))) {
      violations.push({ field, rule: "format", message: `Field "${field}" must be an http(s) URL.` });
    }
  }
  const bodyResult = evaluateTemplateBodyContract(body, contract);
  for (const violation of bodyResult.violations) {
    violations.push({ field: `body:${violation.headingId ?? violation.ruleId}`, rule: "heading", message: violation.message });
  }
  return { valid: violations.length === 0, violations };
}
