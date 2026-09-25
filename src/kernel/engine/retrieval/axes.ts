import type { Digest } from "../../conventions/canonical.js";
import type { ObsidianContractType } from "../../contract/obsidian.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type TemplateId = string & { readonly __kind: "TemplateId" };

/** One effective field as retrieval sees it; the optional rule fields are copied through, never coerced. */
export interface RetrievalField {
  readonly property: string;
  readonly type: ObsidianContractType;
  readonly required: boolean;
  readonly valuePolicy: "free" | "suggest" | "closed";
  readonly intent?: string;
  readonly allowedValues?: readonly string[] | null;
  readonly format?: "url" | null;
  readonly minItems?: number | null;
  readonly maxItems?: number | null;
  readonly minimum?: number | null;
  readonly maximum?: number | null;
}

export interface GlobalAxis {
  readonly kind: "folder" | "link";
  readonly key: string;
  readonly type: ObsidianContractType;
  readonly intent?: string;
  readonly members: readonly JsonValue[];
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}
export type GlobalAxes = Readonly<Record<string, GlobalAxis>>;

/**
 * Field semantics for retrieval. This carries no policy document, source bytes,
 * or approved Markdown: a query needs the effective rules and the template
 * identities, nothing else.
 *
 * `null` means unavailable, not empty. A null field map keeps a known template
 * identity whose rules could not be established; an empty map is an observed
 * empty declaration. Retrieval never fabricates a declaration it did not read.
 */
export type RetrievalFields = Readonly<Record<string, RetrievalField>>;

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
export type TemplateFieldAxis = { readonly kind: "field"; readonly key: string } & RetrievalField;

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

function fieldAxis(key: string, field: RetrievalField, label: string): TemplateFieldAxis {
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

export type NoteTemplateIdentity =
  | { readonly layer: "default"; readonly templateId: null }
  | { readonly layer: "template"; readonly templateId: TemplateId }
  | { readonly layer: "unresolved"; readonly templateId: null; readonly reason: "invalid-frontmatter" | "non-string" | "unknown" };

/** Classifies explicit identity only; it never judges the note's writing contract. */
export function classifyNoteTemplateIdentity(
  frontmatter: Readonly<Record<string, unknown>>,
  templateIds: ReadonlySet<string>,
  malformed = false,
): NoteTemplateIdentity {
  if (malformed) return { layer: "unresolved", templateId: null, reason: "invalid-frontmatter" };
  if (!Object.hasOwn(frontmatter, "template")) return { layer: "default", templateId: null };
  const value = frontmatter["template"];
  if (typeof value !== "string") return { layer: "unresolved", templateId: null, reason: "non-string" };
  const id = value.normalize("NFC");
  if (!templateIds.has(id)) return { layer: "unresolved", templateId: null, reason: "unknown" };
  return { layer: "template", templateId: id as TemplateId };
}
