import { compareCodePoints } from "../conventions/canonical.js";
import { FIELD_TYPES } from "./obsidian.js";
import { scanTemplateSources } from "./scan.js";
import { isSafeName } from "./store.js";
import type { Digest, FieldType, JsonScalar, VariableKind } from "./types.js";

/**
 * A template interpretation submitted by an agent and verified by OMS.
 *
 * OMS does not read template text: a template may be Templater JavaScript, may hold
 * variables in structural positions, and may carry no frontmatter at all, so no
 * deterministic reading of it is trustworthy. The agent reads the source and submits
 * what it declares; OMS checks the submission against the sources it enumerated
 * itself and computes every hash it later trusts. The interpretation only decides
 * which questions the owner is asked; every contract value still comes from the
 * owner's answers.
 */

export interface InterpretedField {
  readonly name: string;
  readonly inferredType: FieldType;
  /** The literal value in the template, or null when it is a variable or empty. */
  readonly literal: JsonScalar | readonly JsonScalar[] | null;
  readonly variable: VariableKind | null;
}

export interface InterpretedHeading {
  readonly title: string;
  readonly level: number;
  /** True when the heading text contains a template variable. */
  readonly variable: boolean;
}

/** What an agent submits for one template source. */
export interface TemplateInterpretation {
  /** Vault-relative source path; it must be one OMS enumerated. */
  readonly source: string;
  /** The digest of the bytes the agent read. Verified against the source, never stored. */
  readonly observedHash: Digest;
  readonly fields: readonly InterpretedField[];
  readonly headings: readonly InterpretedHeading[];
}

/** One verified interpretation with the identity and hash OMS assigned to it. */
export interface InterpretedTemplate {
  readonly name: string;
  readonly source: string;
  /** Computed by OMS from the enumerated source, never taken from the submission. */
  readonly sourceHash: Digest;
  readonly fields: readonly InterpretedField[];
  readonly headings: readonly InterpretedHeading[];
}

/** The template sources OMS enumerated, with the digest it computed for each. */
export interface EnumeratedSource {
  readonly path: string;
  readonly digest: Digest;
}

export type EnumeratedSources =
  | { readonly ok: true; readonly sources: readonly EnumeratedSource[] }
  | { readonly ok: false; readonly diagnostics: readonly { readonly code: string; readonly message: string }[] };

/**
 * Enumerates template sources and computes each one's digest. This is the only thing OMS
 * reads about a template: the bytes' hash, never their meaning. The hash is what the
 * contract stores, what drift is measured against, and what a submitted `observedHash`
 * must equal, so it can never come from a submission.
 */
export async function enumerateTemplateSources(
  vault: string,
  selection: { readonly path: string; readonly kind: "file" | "folder" },
): Promise<EnumeratedSources> {
  let inventory;
  try {
    inventory = await scanTemplateSources(vault, [selection]);
  } catch (error: unknown) {
    return { ok: false, diagnostics: [{ code: "TEMPLATE_SOURCE_READ_FAILED", message: error instanceof Error ? error.message : String(error) }] };
  }
  if (!inventory.complete) {
    const diagnostics = inventory.diagnostics.map(item => ({ code: item.code, message: item.message }));
    return { ok: false, diagnostics: diagnostics.length > 0 ? diagnostics : [{ code: "TEMPLATE_SOURCE_MISSING", message: "Template source is absent" }] };
  }
  return { ok: true, sources: inventory.sources.map(source => ({ path: String(source.path), digest: source.rawDigest })) };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VARIABLE_KINDS: readonly VariableKind[] = ["date", "datetime", "title", "free"];
const MAX_HEADING_LEVEL = 6;

/** `/` is not usable in a template name (`isSafeName`), so a scope is joined with `__`. */
export const SCOPE_SEPARATOR = "__";

/**
 * The template name: its path relative to the template folder, without `.md`, with the
 * folder separator replaced by `__`. A template directly in the folder keeps its plain
 * file name, so only nested templates gain a scope.
 */
export function scopedTemplateName(templateFolder: string, source: string): string {
  const prefix = `${templateFolder.replace(/\/+$/, "")}/`;
  const relative = source.startsWith(prefix) ? source.slice(prefix.length) : source.slice(source.lastIndexOf("/") + 1);
  const withoutExtension = relative.endsWith(".md") ? relative.slice(0, -3) : relative;
  return withoutExtension.split("/").join(SCOPE_SEPARATOR);
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, where: string): InterpretedField {
  if (!isRecord(value)) throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: a field must be an object`);
  const name = value["name"];
  if (typeof name !== "string" || name === "") throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: a field needs a non-empty name`);
  const inferredType = value["inferredType"];
  if (typeof inferredType !== "string" || !(FIELD_TYPES as readonly string[]).includes(inferredType)) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: field ${JSON.stringify(name)} needs one of these types: ${FIELD_TYPES.join(", ")}`);
  }
  const variable = value["variable"] ?? null;
  if (variable !== null && !(VARIABLE_KINDS as readonly unknown[]).includes(variable)) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: field ${JSON.stringify(name)} has an unknown variable kind`);
  }
  const raw = value["literal"] ?? null;
  const literal = Array.isArray(raw) ? raw : raw;
  if (Array.isArray(literal) ? !literal.every(isScalar) : !isScalar(literal)) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: field ${JSON.stringify(name)} has a literal that is not a scalar or a list of scalars`);
  }
  return { name, inferredType: inferredType as FieldType, literal: literal as InterpretedField["literal"], variable: variable as VariableKind | null };
}

function heading(value: unknown, where: string): InterpretedHeading {
  if (!isRecord(value)) throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: a heading must be an object`);
  const title = value["title"];
  if (typeof title !== "string" || title === "") throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: a heading needs a non-empty title`);
  const level = value["level"];
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > MAX_HEADING_LEVEL) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: heading ${JSON.stringify(title)} needs a level from 1 to ${MAX_HEADING_LEVEL}`);
  }
  const variable = value["variable"] ?? false;
  if (typeof variable !== "boolean") throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: heading ${JSON.stringify(title)} needs a boolean variable flag`);
  return { title, level, variable };
}

function interpretation(value: unknown, index: number): TemplateInterpretation {
  const where = `interpretation ${index + 1}`;
  if (!isRecord(value)) throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: each interpretation must be an object`);
  const source = value["source"];
  if (typeof source !== "string" || source === "") throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: needs the vault-relative source path`);
  const observedHash = value["observedHash"];
  if (typeof observedHash !== "string" || !DIGEST.test(observedHash)) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: needs observedHash as sha256:<64 hex>`);
  }
  const rawFields = value["fields"] ?? [];
  const rawHeadings = value["headings"] ?? [];
  if (!Array.isArray(rawFields) || !Array.isArray(rawHeadings)) {
    throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: fields and headings must be arrays`);
  }
  const fields = rawFields.map(entry => field(entry, where));
  const names = new Set<string>();
  for (const entry of fields) {
    if (names.has(entry.name)) throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${where}: field ${JSON.stringify(entry.name)} appears twice`);
    names.add(entry.name);
  }
  return { source, observedHash: observedHash as Digest, fields, headings: rawHeadings.map(entry => heading(entry, where)) };
}

/**
 * Parses a submission: one JSON array of interpretations, or one object from source path
 * to interpretation. Every rejection names the offending entry and no vault content.
 */
export function parseInterpretations(text: string): readonly TemplateInterpretation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("CONTRACT_INTERPRETATION_INVALID: the interpretations are not valid JSON");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Object.entries(parsed).map(([source, value]) => (isRecord(value) ? { source, ...value } : value))
      : null;
  if (entries === null) {
    throw new Error("CONTRACT_INTERPRETATION_INVALID: the interpretations must be a JSON array, or an object from source path to interpretation");
  }
  const submitted = entries.map((entry, index) => interpretation(entry, index));
  const seen = new Set<string>();
  for (const entry of submitted) {
    if (seen.has(entry.source)) throw new Error(`CONTRACT_INTERPRETATION_INVALID: ${JSON.stringify(entry.source)} was submitted twice`);
    seen.add(entry.source);
  }
  return submitted;
}

export type ResolvedInterpretations =
  | { readonly ok: true; readonly templates: readonly InterpretedTemplate[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Pairs the enumerated sources with the submission. Every rule here is a refusal, not a
 * repair: a submission that names an unknown source, leaves one out, or carries a hash
 * that no longer matches the file is rejected, so what the owner is asked about is always
 * the set of templates OMS itself found, read at the bytes the agent actually saw.
 */
export function resolveInterpretations(
  templateFolder: string,
  sources: readonly EnumeratedSource[],
  submitted: readonly TemplateInterpretation[],
): ResolvedInterpretations {
  const reasons: string[] = [];
  const enumerated = new Map(sources.map(source => [source.path, source.digest]));
  const bySource = new Map(submitted.map(entry => [entry.source, entry]));
  for (const entry of submitted) {
    if (!enumerated.has(entry.source)) reasons.push(`The interpretation names ${JSON.stringify(entry.source)}, which is not a template source in the template folder.`);
  }
  const templates: InterpretedTemplate[] = [];
  const byName = new Map<string, string>();
  for (const source of [...sources].sort((left, right) => compareCodePoints(left.path, right.path))) {
    const entry = bySource.get(source.path);
    if (entry === undefined) {
      reasons.push(`The template source ${JSON.stringify(source.path)} has no interpretation; interpret every template or none.`);
      continue;
    }
    if (entry.observedHash !== source.digest) {
      reasons.push(`The interpretation of ${JSON.stringify(source.path)} was read from different bytes than the file now holds; read it again and submit it again.`);
      continue;
    }
    const name = scopedTemplateName(templateFolder, source.path);
    if (!isSafeName(name)) {
      reasons.push(`A template file name is not usable as a template name (${JSON.stringify(name)}).`);
      continue;
    }
    const taken = byName.get(name);
    if (taken !== undefined) {
      reasons.push(`Two templates share the name "${name}"; rename one.`);
      continue;
    }
    byName.set(name, source.path);
    templates.push({ name, source: source.path, sourceHash: source.digest, fields: entry.fields, headings: entry.headings });
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, templates };
}

/**
 * The interpretation as shown to the owner for confirmation, one line per entry. A
 * literal is reported as present, never printed: the seal screen already treats template
 * literal values as hidden (the `:allowed` default is `secret`), and these lines reach an
 * agent through the scripted interview's notes.
 */
export function interpretationLines(template: InterpretedTemplate): string[] {
  const lines = [`Interpretation of "${template.name}" (${template.source}):`];
  if (template.fields.length === 0 && template.headings.length === 0) lines.push("  no properties and no headings");
  for (const entry of template.fields) {
    const value = entry.variable !== null
      ? `variable ${entry.variable}`
      : entry.literal === null || Array.isArray(entry.literal) && entry.literal.length === 0 ? "no value" : "a fixed value";
    lines.push(`  property ${entry.name} (${entry.inferredType}): ${value}`);
  }
  for (const entry of template.headings) {
    lines.push(`  heading ${"#".repeat(entry.level)} ${entry.title}${entry.variable ? " (variable)" : ""}`);
  }
  return lines;
}
