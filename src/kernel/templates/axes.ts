import type { EffectiveFieldV5 } from "./contract-v5.js";
import type {
  Digest,
  GlobalAxis,
  GlobalAxes,
  JsonValue,
  TemplateId,
} from "./types.js";

/**
 * Field semantics for retrieval. This carries no policy document, source bytes,
 * or approved Markdown: a query needs the effective rules and the template
 * identities, nothing else.
 *
 * `null` means unavailable, not empty. A null field map keeps a known template
 * identity whose rules could not be established; an empty map is an observed
 * empty declaration. Retrieval never fabricates a declaration it did not read.
 */
export type RetrievalFields = Readonly<Record<string, EffectiveFieldV5>>;

export interface TemplateRetrievalSource {
  readonly generationDigest: Digest;
  readonly defaultFields: RetrievalFields | null;
  readonly templates: Readonly<Record<string, RetrievalFields | null>> | null;
  readonly globalAxes: GlobalAxes | null;
  /** Registered original-source paths from the same policy read. */
  readonly sourcePaths: readonly string[] | null;
}

export interface TemplateIdentityAxis {
  readonly kind: "identity";
  readonly key: "template";
  readonly type: "string";
  readonly templateId: TemplateId;
}

/** The note key plus every effective rule, copied without coercion. */
export type TemplateFieldAxis = { readonly kind: "field"; readonly key: string } & EffectiveFieldV5;

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
    || typeof snapshot.generationDigest !== "string"
    || !Object.hasOwn(snapshot, "defaultFields")
    || (snapshot.defaultFields !== null && !isMapping(snapshot.defaultFields))
    || !Object.hasOwn(snapshot, "templates")
    || (snapshot.templates !== null && !isMapping(snapshot.templates))
    || !Object.hasOwn(snapshot, "globalAxes")
    || (snapshot.globalAxes !== null && !isMapping(snapshot.globalAxes))
    || !Object.hasOwn(snapshot, "sourcePaths")
    || (snapshot.sourcePaths !== null && !Array.isArray(snapshot.sourcePaths))
  ) {
    fail("snapshot must include generationDigest, defaultFields, templates, globalAxes, and sourcePaths");
  }
}

function fieldAxis(key: string, field: EffectiveFieldV5, label: string): TemplateFieldAxis {
  if (!isMapping(field) || typeof field.property !== "string" || typeof field.type !== "string"
    || typeof field.required !== "boolean" || typeof field.valuePolicy !== "string") {
    fail(`${label}:${key}`);
  }
  // Every effective rule survives: a suggested list never becomes a closed
  // filter, and numeric or cardinality metadata is not dropped.
  return { kind: "field", key, ...field };
}

/** Effective-field order is the contract's own key order, not an invented alphabetical order. */
function fieldAxes(fields: RetrievalFields | null, label: string): readonly TemplateFieldAxis[] {
  if (fields === null) return [];
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
  const defaultAxes = fieldAxes(snapshot.defaultFields, "default");
  const seen = new Set<string>();
  const templates: TemplateAxisSet[] = (snapshot.templates === null ? [] : [...ownEntries(snapshot.templates)])
    .map(([key, fields]) => {
      const templateId = key.normalize("NFC") as TemplateId;
      if (seen.has(templateId)) fail(`${templateId}:templateId`);
      seen.add(templateId);
      return {
        templateId,
        // A known identity stays queryable even when its rules are unavailable.
        axes: [
          { kind: "identity" as const, key: "template" as const, type: "string" as const, templateId },
          ...fieldAxes(fields, templateId),
        ],
      };
    })
    .sort((left, right) => compareText(left.templateId, right.templateId));
  const globalAxes = (snapshot.globalAxes === null ? [] : [...ownEntries(snapshot.globalAxes)])
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
