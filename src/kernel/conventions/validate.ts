import type { Concept, OntologyField } from "../ontology/types.js";

export type ViolationRule = "required" | "type" | "immutable";

export interface Violation {
  field: string;
  rule: ViolationRule;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

/**
 * Check whether a value is "empty" for the purposes of the `required` rule.
 * A value is empty if it is undefined, null, an empty string, or an empty array.
 */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Check whether a value matches the declared FieldType.
 */
function matchesType(value: unknown, field: OntologyField): boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "list":
      return Array.isArray(value);
    case "url": {
      if (typeof value !== "string") return false;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }
    case "date": {
      if (value instanceof Date) return !isNaN(value.getTime());
      if (typeof value === "string") {
        // Accept YYYY-MM-DD and anything Date() parses to a valid date.
        if (!/\S/.test(value)) return false;
        const d = new Date(value);
        return !isNaN(d.getTime());
      }
      return false;
    }
  }
}

/**
 * Validate a note's frontmatter against a declared Concept.
 *
 * Rules:
 * - required: field absent or empty → Violation{rule:"required"}
 * - type: field present and non-empty, but wrong type → Violation{rule:"type"}
 * - immutable: intentionally suppressed in v0 (no baseline exists; union member
 *   kept for forward-compatibility with v1 delta-tracking).
 * - Undeclared frontmatter keys → NO violation (additionalProperties: preserve).
 *
 * NEVER throws. valid = violations.length === 0.
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  concept: Concept,
): ValidationResult {
  const violations: Violation[] = [];

  for (const field of concept.fields) {
    const value = frontmatter[field.name];

    if (field.required && isEmpty(value)) {
      violations.push({
        field: field.name,
        rule: "required",
        message: `Required field "${field.name}" is absent or empty.`,
      });
      // Skip type check — nothing to check if the value is absent/empty.
      continue;
    }

    // Type-check only if the value is present and non-empty.
    if (!isEmpty(value) && !matchesType(value, field)) {
      violations.push({
        field: field.name,
        rule: "type",
        message: `Field "${field.name}" expected type "${field.type}" but received ${Array.isArray(value) ? "array" : typeof value}.`,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}
