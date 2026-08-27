import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ContractAxisKind = "folder" | "field" | "link";
export type ContractValueType =
  | "text"
  | "string"
  | "select"
  | "number"
  | "boolean"
  | "checkbox"
  | "date"
  | "datetime"
  | "list"
  | "multitext"
  | "multi"
  | "tags"
  | "aliases"
  | "file";

export interface ContractAllowedValue {
  readonly value: string;
  readonly intent?: string;
  readonly [key: string]: unknown;
}

export type AllowedValue = string | ContractAllowedValue;

export interface ContractAxis {
  readonly [key: string]: unknown;
  readonly kind: ContractAxisKind;
  readonly key: string;
  readonly type: ContractValueType;
  readonly intent?: string;
  readonly required?: boolean;
  readonly normalize?: "lower" | "trim" | "kebab";
  readonly allowedValues?: readonly AllowedValue[];
}

/** Tracked, user-owned frontmatter contract stored at `<vault>/.oms/types.json`. */
export interface FrontmatterContract {
  readonly [key: string]: unknown;
  readonly version: number;
  readonly intent?: string;
  readonly axes: readonly ContractAxis[];
  /** Type declarations keyed by a field/property name. */
  readonly types: Readonly<Record<string, ContractValueType>>;
  /** Closed vocabularies keyed by a field/property name. */
  readonly allowedValues: Readonly<Record<string, readonly AllowedValue[]>>;
}

export interface ObsidianTypeAuthority {
  readonly types: Readonly<Record<string, ContractValueType>>;
  readonly source: string;
}

const AXIS_KINDS: readonly ContractAxisKind[] = ["folder", "field", "link"];
const VALUE_TYPES: readonly ContractValueType[] = [
  "text",
  "string",
  "select",
  "number",
  "boolean",
  "checkbox",
  "date",
  "datetime",
  "list",
  "multitext",
  "multi",
  "tags",
  "aliases",
  "file",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid frontmatter contract: ${message}`);
}

function asAxisKind(value: unknown, where: string): ContractAxisKind {
  if (typeof value === "string" && (AXIS_KINDS as readonly string[]).includes(value)) {
    return value as ContractAxisKind;
  }
  fail(`${where}.kind must be one of folder, field, or link.`);
}

function asValueType(value: unknown, where: string): ContractValueType {
  if (isRecord(value) && value["type"] !== undefined) return asValueType(value["type"], `${where}.type`);
  if (typeof value === "string" && (VALUE_TYPES as readonly string[]).includes(value)) {
    return value as ContractValueType;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const aliases: Readonly<Record<string, ContractValueType>> = {
      text: "text",
      input: "text",
      string: "string",
      select: "select",
      number: "number",
      boolean: "boolean",
      checkbox: "checkbox",
      date: "date",
      datetime: "datetime",
      list: "list",
      multi: "multi",
      multitext: "multitext",
      tags: "tags",
      aliases: "aliases",
      file: "file",
    };
    const alias = aliases[normalized];
    if (alias !== undefined) return alias;
  }
  fail(`${where}.type must be a supported Obsidian property type.`);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${where} must be a non-empty string.`);
  return value.trim();
}

function asAllowedValues(value: unknown, where: string): AllowedValue[] {
  if (!Array.isArray(value)) fail(`${where} must be an array.`);
  return (value as unknown[]).map((item, index) => {
    if (typeof item === "string") return asString(item, `${where}[${index}]`);
    if (!isRecord(item)) fail(`${where}[${index}] must be a string or object.`);
    const extras = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "value" && key !== "intent"));
    const intent = item["intent"] === undefined ? undefined : asString(item["intent"], `${where}[${index}].intent`);
    const allowed = {
      ...extras,
      value: asString(item["value"], `${where}[${index}].value`),
      ...(intent === undefined ? {} : { intent }),
    } as ContractAllowedValue;
    return allowed;
  });
}

function parseAxis(value: unknown, where: string, impliedKind?: ContractAxisKind, impliedKey?: string): ContractAxis {
  if (!isRecord(value)) fail(`${where} must be an object.`);
  const kind = asAxisKind(value["kind"] ?? impliedKind, where);
  const key = asString(value["key"] ?? impliedKey, `${where}.key`);
  const type = asValueType(value["type"], where);
  const intent = value["intent"] === undefined ? undefined : asString(value["intent"], `${where}.intent`);
  const required = value["required"] === undefined ? undefined : value["required"];
  if (required !== undefined && typeof required !== "boolean") fail(`${where}.required must be boolean.`);
  const normalize = value["normalize"];
  if (normalize !== undefined && normalize !== "lower" && normalize !== "trim" && normalize !== "kebab") {
    fail(`${where}.normalize must be lower, trim, or kebab.`);
  }
  const allowedValues = value["allowedValues"] === undefined
    ? undefined
    : asAllowedValues(value["allowedValues"], `${where}.allowedValues`);
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !["kind", "key", "type", "intent", "required", "normalize", "allowedValues"].includes(key)));
  return {
    ...extras,
    kind,
    key,
    type,
    ...(intent === undefined ? {} : { intent }),
    ...(required === undefined ? {} : { required }),
    ...(normalize === undefined ? {} : { normalize }),
    ...(allowedValues === undefined ? {} : { allowedValues }),
  };
}

/**
 * Parse the two contract shapes emitted by setup: the canonical axis array and
 * the convenient `{ folder: {...}, field: {...} }` grouping form. Both become
 * one deterministic in-memory representation.
 */
function parseAxes(value: unknown): ContractAxis[] {
  if (Array.isArray(value)) return value.map((axis, index) => parseAxis(axis, `axes[${index}]`));
  if (!isRecord(value)) fail("axes must be an array or object.");

  const axes: ContractAxis[] = [];
  for (const [kindKey, group] of Object.entries(value)) {
    if (!(AXIS_KINDS as readonly string[]).includes(kindKey)) fail(`axes.${kindKey} is not a supported axis kind.`);
    const kind = kindKey as ContractAxisKind;
    if (Array.isArray(group)) {
      group.forEach((axis, index) => axes.push(parseAxis(axis, `axes.${kind}[${index}]`, kind)));
      continue;
    }
    if (!isRecord(group)) fail(`axes.${kind} must be an object or array.`);
    if (group["type"] !== undefined || group["key"] !== undefined || group["kind"] !== undefined) {
      axes.push(parseAxis(group, `axes.${kind}`, kind));
      continue;
    }
    for (const [key, descriptor] of Object.entries(group)) {
      axes.push(parseAxis(descriptor, `axes.${kind}.${key}`, kind, key));
    }
  }
  return axes;
}

function parseTypeMap(value: unknown, where: string): Record<string, ContractValueType> {
  if (!isRecord(value)) fail(`${where} must be an object.`);
  const types: Record<string, ContractValueType> = {};
  for (const [key, type] of Object.entries(value)) {
    types[asString(key, `${where} key`)] = asValueType(type, `${where}.${key}`);
  }
  return types;
}

function parseAllowedValues(value: unknown): Record<string, AllowedValue[]> {
  if (!isRecord(value)) fail("allowedValues must be an object.");
  const allowedValues: Record<string, AllowedValue[]> = {};
  for (const [key, values] of Object.entries(value)) {
    allowedValues[asString(key, "allowedValues key")] = asAllowedValues(values, `allowedValues.${key}`);
  }
  return allowedValues;
}

function validateUniqueAxes(axes: readonly ContractAxis[]): void {
  const seen = new Set<string>();
  for (const axis of axes) {
    const identity = `${axis.kind}:${axis.key.toLowerCase()}`;
    if (seen.has(identity)) fail(`duplicate axis ${axis.kind}:${axis.key}.`);
    seen.add(identity);
  }
}

/** Parse and validate a JSON contract. Malformed contracts always throw. */
export function parseContract(input: string | unknown): FrontmatterContract {
  let value: unknown;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      fail(`JSON parse failed (${message}).`);
    }
  } else {
    value = input;
  }
  if (!isRecord(value)) fail("root must be an object.");
  const version = value["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    fail("version must be a positive integer.");
  }
  const intent = value["intent"] === undefined ? undefined : asString(value["intent"], "intent");
  const axes = parseAxes(value["axes"]);
  const types = parseTypeMap(value["types"], "types");
  const allowedValues = parseAllowedValues(value["allowedValues"]);
  validateUniqueAxes(axes);

  // Axis-local declarations are copied into the top-level indexes so callers
  // have one lookup path. Conflicting declarations are contract errors.
  for (const axis of axes) {
    const priorType = types[axis.key];
    if (priorType !== undefined && priorType !== axis.type) fail(`types.${axis.key} conflicts with axis type.`);
    if (axis.allowedValues !== undefined) {
      const priorValues = allowedValues[axis.key];
      if (priorValues !== undefined && JSON.stringify(priorValues) !== JSON.stringify(axis.allowedValues)) {
        fail(`allowedValues.${axis.key} conflicts with axis declaration.`);
      }
      if (priorValues === undefined) allowedValues[axis.key] = [...axis.allowedValues];
    }
    if (priorType === undefined) types[axis.key] = axis.type;
  }
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !["version", "intent", "axes", "types", "allowedValues"].includes(key)));
  return {
    ...extras,
    version,
    ...(intent === undefined ? {} : { intent }),
    axes,
    types,
    allowedValues,
  };
}

/** Canonical stable JSON representation (two-space indent, trailing newline). */
export function serializeContract(contract: FrontmatterContract): string {
  const parsed = parseContract(contract);
  const axes = [...parsed.axes]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key))
    .map((axis) => {
      const extras = Object.fromEntries(
        Object.entries(axis)
          .filter(([key]) => !["kind", "key", "type", "required", "normalize", "allowedValues", "intent"].includes(key))
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      return {
        kind: axis.kind,
        key: axis.key,
        type: axis.type,
        ...(axis.required === undefined ? {} : { required: axis.required }),
        ...(axis.normalize === undefined ? {} : { normalize: axis.normalize }),
        ...(axis.allowedValues === undefined ? {} : { allowedValues: [...axis.allowedValues] }),
        ...(axis.intent === undefined ? {} : { intent: axis.intent }),
        ...extras,
      };
    });
  const types = Object.fromEntries(Object.entries(parsed.types).sort(([left], [right]) => left.localeCompare(right)));
  const allowedValues = Object.fromEntries(
    Object.entries(parsed.allowedValues)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values]]),
  );
  const extras = Object.fromEntries(
    Object.entries(parsed)
      .filter(([key]) => !["version", "intent", "axes", "types", "allowedValues"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify({
    version: parsed.version,
    ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
    axes,
    types,
    allowedValues,
    ...extras,
  }, null, 2)}\n`;
}

export const CONTRACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
  required: ["version", "axes", "types", "allowedValues"],
  properties: {
    version: { type: "integer", minimum: 1 },
    intent: { type: "string", minLength: 1 },
    axes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["kind", "key", "type"],
        properties: {
          kind: { enum: ["folder", "field", "link"] },
          key: { type: "string", minLength: 1 },
          type: { enum: VALUE_TYPES },
          intent: { type: "string", minLength: 1 },
          required: { type: "boolean" },
          normalize: { enum: ["lower", "trim", "kebab"] },
          allowedValues: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  additionalProperties: true,
                  required: ["value"],
                  properties: { value: { type: "string", minLength: 1 }, intent: { type: "string", minLength: 1 } },
                },
              ],
            },
          },
        },
      },
    },
    types: { type: "object", additionalProperties: { enum: VALUE_TYPES } },
    allowedValues: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: true,
              required: ["value"],
              properties: { value: { type: "string", minLength: 1 }, intent: { type: "string", minLength: 1 } },
            },
          ],
        },
      },
    },
  },
} as const;

function omsTypesPath(input: string): string {
  if (path.basename(input) === "types.json") return input;
  if (path.basename(input) === ".oms") return path.join(input, "types.json");
  return path.join(input, ".oms", "types.json");
}

function obsidianTypesPath(input: string): string {
  if (path.basename(input) === "types.json" && path.basename(path.dirname(input)) === ".obsidian") return input;
  if (path.basename(input) === "types.json" && path.basename(path.dirname(input)) === ".oms") {
    return path.join(path.dirname(path.dirname(input)), ".obsidian", "types.json");
  }
  if (path.basename(input) === ".obsidian") return path.join(input, "types.json");
  return path.join(input, ".obsidian", "types.json");
}

/** Read the tracked JSON contract. Legacy YAML files are deliberately ignored. */
export async function loadContract(input: string, options: { readonly obsidianTypes?: boolean } = {}): Promise<FrontmatterContract | null> {
  let raw: string;
  try {
    raw = await readFile(omsTypesPath(input), "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const contract = parseContract(raw);
  if (options.obsidianTypes === false) return contract;
  const authority = await loadObsidianTypes(input);
  if (authority === null) return contract;
  const types = { ...contract.types, ...authority.types };
  const axes = contract.axes.map((axis) => ({ ...axis, type: types[axis.key] ?? axis.type }));
  return { ...contract, axes, types };
}

/** Read `.obsidian/types.json` through one adapter; this function never writes. */
export async function loadObsidianTypes(input: string): Promise<ObsidianTypeAuthority | null> {
  let raw: string;
  const source = obsidianTypesPath(input);
  try {
    raw = await readFile(source, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Invalid Obsidian types authority: JSON parse failed (${message}).`);
  }
  if (!isRecord(parsed)) throw new Error("Invalid Obsidian types authority: root must be an object.");
  const candidate = parsed["types"] ?? parsed;
  const types: Record<string, ContractValueType> = {};
  if (Array.isArray(candidate)) {
    candidate.forEach((entry, index) => {
      if (!isRecord(entry)) throw new Error(`Invalid Obsidian types authority: types[${index}] must be an object.`);
      const name = asString(entry["name"] ?? entry["key"], `types[${index}].name`);
      types[name] = asValueType(entry["type"], `types[${index}]`);
    });
  } else {
    Object.assign(types, parseTypeMap(candidate, "types"));
  }
  return { types, source };
}

/** Persist a validated contract to `.oms/types.json`; no YAML is migrated. */
export async function writeContract(input: string, contract: FrontmatterContract): Promise<void> {
  const target = omsTypesPath(input);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serializeContract(contract), "utf-8");
}

