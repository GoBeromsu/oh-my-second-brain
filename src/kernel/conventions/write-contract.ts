export type TemplateFieldType = "string" | "url" | "date" | "list" | "number" | "boolean";
export type TemplateFieldNormalization = "lower" | "trim" | "kebab";
export type TemplateFieldFormat = "url";
export type TemplateWriteContractRule = "required" | "type" | "allowed-values" | "format";

export interface TemplateField {
  readonly name: string;
  readonly type: TemplateFieldType;
  readonly required?: boolean;
  readonly normalize?: TemplateFieldNormalization;
  readonly allowedValues?: readonly string[];
  readonly format?: TemplateFieldFormat;
}

export interface TemplateWriteContract {
  readonly fields: readonly TemplateField[];
  readonly additionalProperties: "preserve";
}

export interface TemplateWriteContractViolation {
  readonly field: string;
  readonly rule: TemplateWriteContractRule;
  readonly message: string;
}

export interface TemplateWriteContractResult {
  readonly valid: boolean;
  readonly frontmatter: Record<string, unknown>;
  readonly violations: readonly TemplateWriteContractViolation[];
}

function normalizeString(value: string, normalization: TemplateFieldNormalization | undefined): string {
  if (normalization === "lower") return value.toLowerCase();
  if (normalization === "trim") return value.trim();
  if (normalization === "kebab") {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }
  return value;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");
}

function matchesType(value: unknown, type: TemplateFieldType): boolean {
  if (type === "string" || type === "url" || type === "date") return typeof value === "string";
  if (type === "list") return Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalizes declared fields and evaluates a resolved template contract.
 * Undeclared frontmatter is retained unchanged.
 */
export function evaluateTemplateWriteContract(
  frontmatter: Record<string, unknown>,
  contract: TemplateWriteContract,
): TemplateWriteContractResult {
  const normalized = { ...frontmatter };
  const violations: TemplateWriteContractViolation[] = [];

  for (const field of contract.fields) {
    const original = normalized[field.name];
    const value = typeof original === "string" ? normalizeString(original, field.normalize) : original;
    if (value !== original) normalized[field.name] = value;

    if (field.required === true && !hasValue(value)) {
      violations.push({ field: field.name, rule: "required", message: `Field "${field.name}" is required.` });
      continue;
    }
    if (value === undefined || value === null) continue;

    if (!matchesType(value, field.type)) {
      violations.push({ field: field.name, rule: "type", message: `Field "${field.name}" must be a ${field.type}.` });
      continue;
    }
    if (field.format === "url" && typeof value === "string" && !isUrl(value)) {
      violations.push({ field: field.name, rule: "format", message: `Field "${field.name}" must be an http(s) URL.` });
    }
    if (field.allowedValues !== undefined && typeof value === "string" && !field.allowedValues.includes(value)) {
      violations.push({
        field: field.name,
        rule: "allowed-values",
        message: `Field "${field.name}" must be one of [${field.allowedValues.map((entry) => `"${entry}"`).join(", ")}].`,
      });
    }
  }

  return { valid: violations.length === 0, frontmatter: normalized, violations };
}
