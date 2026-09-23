import type {
  Digest,
  GlobalAxis,
  GlobalAxes,
  JsonValue,
  ObsidianContractType,
  PropertyFormat,
  ResolvedContract,
  ResolvedField,
  TemplateId,
  TemplatePolicy,
} from "./types.js";

/**
 * Structural slice of the P05 resolved snapshot.
 * Callers may pass the snapshot itself. This module does not load or refresh it.
 */
export interface TemplateRetrievalSource {
  readonly defaultContract: ResolvedContract;
  readonly templates: Readonly<Record<string, ResolvedContract>>;
  readonly globalAxes: GlobalAxes;
  readonly generationDigest: Digest;
  readonly policy: TemplatePolicy;
}

export interface TemplateIdentityAxis {
  readonly kind: "identity";
  readonly key: "template";
  readonly type: "string";
  readonly templateId: TemplateId;
}

export interface TemplateFieldAxis {
  readonly kind: "field";
  readonly key: string;
  readonly type: ObsidianContractType;
  readonly intent: string;
  readonly required: boolean;
  readonly allowedValues?: readonly string[];
  readonly format?: PropertyFormat;
}

export type SearchableAxis = TemplateIdentityAxis | TemplateFieldAxis | GlobalAxis;

export interface TemplateAxisSet {
  readonly templateId: TemplateId;
  readonly axes: readonly (TemplateIdentityAxis | TemplateFieldAxis)[];
}

export interface TemplateRetrievalAxes {
  readonly defaultAxes: readonly TemplateFieldAxis[];
  readonly templates: readonly TemplateAxisSet[];
  readonly globalAxes: readonly GlobalAxis[];
}

function fail(message: string): never {
  throw new Error(`TEMPLATE_AXIS_UNDECLARED_FIELD: ${message}`);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function ownEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  const entries: (readonly [string, T])[] = [];
  for (const key of Object.keys(record)) {
    const value = Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
    if (value !== undefined) entries.push([key, value]);
  }
  return entries;
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSnapshot(snapshot: TemplateRetrievalSource): void {
  if (
    !isMapping(snapshot)
    || !Object.hasOwn(snapshot, "defaultContract")
    || !isMapping(snapshot.defaultContract)
    || !Object.hasOwn(snapshot, "templates")
    || !isMapping(snapshot.templates)
    || !Object.hasOwn(snapshot, "globalAxes")
    || !isMapping(snapshot.globalAxes)
    || typeof snapshot.generationDigest !== "string"
    || !Object.hasOwn(snapshot, "policy")
    || !isMapping(snapshot.policy)
  ) {
    fail("snapshot must include defaultContract, templates, globalAxes, generationDigest, and policy");
  }
}

function fieldAxis(key: string, field: ResolvedField, label: string): TemplateFieldAxis {
  if (field.property !== key || typeof field.type !== "string" || typeof field.intent !== "string" || typeof field.required !== "boolean") {
    fail(`${label}:${key}`);
  }
  return {
    kind: "field",
    key,
    type: field.type,
    intent: field.intent,
    required: field.required,
    ...(field.allowedValues === undefined ? {} : { allowedValues: [...field.allowedValues] }),
    ...(field.format === undefined ? {} : { format: field.format }),
  };
}

/** Effective-field order is the contract's own key order, not an invented alphabetical order. */
function fieldAxes(fields: Readonly<Record<string, ResolvedField>>, label: string): readonly TemplateFieldAxis[] {
  if (!isMapping(fields)) fail(`${label}:fields`);
  return ownEntries(fields).map(([key, field]) => fieldAxis(key, field, label));
}

function copyExtensions(extensions: GlobalAxis["extensions"]): GlobalAxis["extensions"] | undefined {
  if (extensions === undefined) return undefined;
  if (!isMapping(extensions)) fail("global:extensions");
  const copy = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of ownEntries(extensions)) copy[key] = value;
  return copy;
}

function copyGlobalAxis(name: string, axis: GlobalAxis): GlobalAxis {
  if (
    !isMapping(axis)
    || (axis.kind !== "folder" && axis.kind !== "link")
    || typeof axis.key !== "string"
    || typeof axis.type !== "string"
    || !Array.isArray(axis.members)
  ) {
    fail(`global:${name}`);
  }
  const extensions = copyExtensions(axis.extensions);
  return {
    kind: axis.kind,
    key: axis.key,
    type: axis.type,
    ...(axis.intent === undefined ? {} : { intent: axis.intent }),
    members: [...axis.members],
    ...(extensions === undefined ? {} : { extensions }),
  };
}

/**
 * Derives retrieval metadata from an already resolved v4 snapshot.
 * It does not read the vault, compose policy, or invent views, names, or normalizers.
 */
export function deriveTemplateRetrievalAxes(snapshot: TemplateRetrievalSource): TemplateRetrievalAxes {
  assertSnapshot(snapshot);
  if (snapshot.defaultContract.templateId !== null) fail("default:templateId");
  const defaultAxes = fieldAxes(snapshot.defaultContract.fields, "default");
  const seen = new Set<string>();
  const templates: TemplateAxisSet[] = [...ownEntries(snapshot.templates)]
    .map(([key, contract]) => {
      const templateId = key.normalize("NFC") as TemplateId;
      if (seen.has(templateId) || !isMapping(contract) || contract.templateId !== templateId) fail(`${templateId}:templateId`);
      seen.add(templateId);
      return {
        templateId,
        axes: [
          { kind: "identity" as const, key: "template" as const, type: "string" as const, templateId },
          ...fieldAxes(contract.fields, templateId),
        ],
      };
    })
    .sort((left, right) => compareText(left.templateId, right.templateId));
  const globalAxes = [...ownEntries(snapshot.globalAxes)]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([name, axis]) => copyGlobalAxis(name, axis));
  return { defaultAxes, templates, globalAxes };
}

/** Note values allow finite decimals; contract-hash integer restrictions do not apply. */
export function axisValueEquals(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined) return false;
  if (typeof left === "number" || typeof right === "number") {
    return typeof left === "number" && typeof right === "number"
      && Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  if (typeof left === "string" && typeof right === "string") return left.normalize("NFC") === right.normalize("NFC");
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => axisValueEquals(value, right[index]!));
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  const indexed = new Map<string, JsonValue>(leftEntries.map(([key, value]) => [key.normalize("NFC"), value]));
  const rightKeys = new Set(rightEntries.map(([key]) => key.normalize("NFC")));
  return indexed.size === leftEntries.length && rightKeys.size === rightEntries.length
    && leftEntries.length === rightEntries.length
    && rightEntries.every(([key, value]) => axisValueEquals(indexed.get(key.normalize("NFC")), value));
}
