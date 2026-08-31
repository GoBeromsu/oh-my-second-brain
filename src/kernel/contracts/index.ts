import { readFile } from "node:fs/promises";
import path from "node:path";

export {
  DERIVED_PROJECTION_SCHEMA,
  parseDerivedProjection,
  parseTemplatePolicy,
  serializeDerivedProjection,
  serializeTemplatePolicy,
  TEMPLATE_POLICY_SCHEMA,
  validateDerivedProjection,
} from "../templates/policy.js";
export type {
  BaseContract,
  DerivedProjection,
  FieldPolicy,
  ObsidianContractType,
  TemplatePolicy,
} from "../templates/types.js";

export type ContractValueType =
  | "text" | "string" | "select" | "number" | "boolean" | "checkbox"
  | "date" | "datetime" | "list" | "multitext" | "multi" | "tags" | "aliases" | "file";

export interface ObsidianTypeAuthority {
  readonly types: Readonly<Record<string, ContractValueType>>;
  readonly source: string;
}

const VALUE_TYPES: readonly ContractValueType[] = [
  "text", "string", "select", "number", "boolean", "checkbox", "date", "datetime",
  "list", "multitext", "multi", "tags", "aliases", "file",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid Obsidian types authority: ${message}`);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${where} must be a non-empty string.`);
  return value.trim();
}

function asValueType(value: unknown, where: string): ContractValueType {
  if (isRecord(value) && value["type"] !== undefined) return asValueType(value["type"], `${where}.type`);
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if ((VALUE_TYPES as readonly string[]).includes(normalized)) return normalized as ContractValueType;
    if (normalized === "input") return "text";
  }
  return fail(`${where} must be a supported Obsidian property type.`);
}

function parseTypeMap(value: unknown, where: string): Record<string, ContractValueType> {
  if (!isRecord(value)) fail(`${where} must be an object.`);
  const types: Record<string, ContractValueType> = {};
  for (const [key, type] of Object.entries(value)) types[asString(key, `${where} key`)] = asValueType(type, `${where}.${key}`);
  return types;
}

function obsidianTypesPath(input: string): string {
  if (path.basename(input) === "types.json" && path.basename(path.dirname(input)) === ".obsidian") return input;
  if (path.basename(input) === "types.json" && path.basename(path.dirname(input)) === ".oms") return path.join(path.dirname(path.dirname(input)), ".obsidian", "types.json");
  if (path.basename(input) === ".obsidian") return path.join(input, "types.json");
  return path.join(input, ".obsidian", "types.json");
}

/** Read `.obsidian/types.json` through one read-only authority adapter. */
export async function loadObsidianTypes(input: string): Promise<ObsidianTypeAuthority | null> {
  const source = obsidianTypesPath(input);
  let raw: string;
  try { raw = await readFile(source, "utf-8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch (error) { fail(`JSON parse failed (${error instanceof Error ? error.message : "invalid JSON"}).`); }
  if (!isRecord(parsed)) fail("root must be an object.");
  const candidate = parsed["types"] ?? parsed;
  const types: Record<string, ContractValueType> = {};
  if (Array.isArray(candidate)) {
    candidate.forEach((entry, index) => {
      if (!isRecord(entry)) fail(`types[${index}] must be an object.`);
      const name = asString(entry["name"] ?? entry["key"], `types[${index}].name`);
      types[name] = asValueType(entry["type"], `types[${index}]`);
    });
  } else Object.assign(types, parseTypeMap(candidate, "types"));
  return { types, source };
}
