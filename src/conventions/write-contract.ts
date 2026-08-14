import type { Concept, Ontology, OntologyField } from "../core/ontology/types.js";
import { validateFrontmatter } from "./validate.js";

export type WriteContractRule = "required" | "type" | "enum" | "routing-law";

export interface WriteContractViolation {
  field: string;
  rule: WriteContractRule;
  message: string;
}

export interface WriteContractResult {
  valid: boolean;
  violations: WriteContractViolation[];
}

export interface WriteFieldDescriptor {
  name: string;
  type: OntologyField["type"];
  required: boolean;
  intent: string;
  enum?: string[];
}

/**
 * Kernel-owned write contract. Does not throw. Does not check allowlist —
 * undeclared keys are preserved (additionalProperties: preserve).
 */
export function evaluateWriteContract(
  frontmatter: Record<string, unknown>,
  concept: Concept,
  notePath: string,
  strictZones: ReadonlySet<string>,
): WriteContractResult {
  const violations: WriteContractViolation[] = [];

  const fieldResult = validateFrontmatter(frontmatter, concept);
  for (const violation of fieldResult.violations) {
    if (violation.rule === "immutable") {
      continue;
    }
    violations.push({
      field: violation.field,
      rule: violation.rule,
      message: violation.message,
    });
  }

  violations.push(...enumViolations(frontmatter, concept));
  violations.push(...routingLawViolations(frontmatter, notePath, strictZones));

  return { valid: violations.length === 0, violations };
}

export function routingLawStrictFolders(ontology: Ontology): Set<string> {
  const zones = new Set<string>();
  for (const [folder, binding] of Object.entries(ontology.taxonomy.folders)) {
    if (binding.agentWritable === true && binding.routingLawStrict === true) {
      zones.add(folder);
    }
  }
  return zones;
}

export function writeFieldDescriptors(concept: Concept): WriteFieldDescriptor[] {
  return concept.fields.map((field) => {
    const descriptor: WriteFieldDescriptor = {
      name: field.name,
      type: field.type,
      required: field.required === true,
      intent: field.intent,
    };
    if (field.enum !== undefined) {
      descriptor.enum = field.enum;
    }
    return descriptor;
  });
}

export function enumViolations(
  frontmatter: Record<string, unknown>,
  concept: Concept,
): WriteContractViolation[] {
  const violations: WriteContractViolation[] = [];
  for (const field of concept.fields) {
    if (!field.enum || field.enum.length === 0) {
      continue;
    }
    const value = frontmatter[field.name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    if (!field.enum.includes(value)) {
      violations.push({
        field: field.name,
        rule: "enum",
        message:
          `Field "${field.name}" value "${value}" is not one of` +
          ` [${field.enum.map((entry) => `"${entry}"`).join(", ")}].`,
      });
    }
  }
  return violations;
}

export function routingLawViolations(
  frontmatter: Record<string, unknown>,
  notePath: string,
  strictZones: ReadonlySet<string>,
): WriteContractViolation[] {
  const folder = notePath.split("/")[0] ?? "";
  if (!strictZones.has(folder)) {
    return [];
  }

  const createdBy = frontmatter["created_by"];
  const missing =
    createdBy === undefined ||
    createdBy === null ||
    (typeof createdBy === "string" && createdBy.trim() === "");

  if (!missing) {
    return [];
  }

  return [
    {
      field: "created_by",
      rule: "routing-law",
      message:
        `Note in agent-writable zone "${folder}" must carry "created_by"` +
        ` to satisfy the ROUTING LAW (agent-authored notes are traceable).`,
    },
  ];
}
