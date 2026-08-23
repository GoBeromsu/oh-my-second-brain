import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import { walkVaultMarkdown } from "../conventions/vault-walk.js";
import { resolveConcept } from "../ontology/resolver.js";
import { matchesAnyGlob, resolveExcludeGlobs, validateVaultLintFolder } from "../engine/conventions/vault-lint.js";
import type { Concept, FieldType, Ontology, OntologyField, OntologyLens } from "../ontology/types.js";

export interface ObservedField {
  readonly name: string;
  readonly type: FieldType;
  readonly count: number;
}

export interface ObservedFolderSummary {
  readonly folder: string;
  readonly fields: readonly ObservedField[];
  readonly warnings: readonly string[];
}

interface FieldAccumulator {
  count: number;
  values: unknown[];
}


function firstFolder(relativePath: string): string | null {
  const slashIndex = relativePath.indexOf("/");
  if (slashIndex <= 0) return null;
  return relativePath.slice(0, slashIndex);
}

function looksLikeUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function looksLikeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function inferFieldType(values: readonly unknown[]): FieldType {
  const presentValues = values.filter((value) => value !== null && value !== undefined);
  if (presentValues.length === 0) return "string";
  if (presentValues.every((value) => Array.isArray(value))) return "list";
  if (presentValues.every((value) => typeof value === "boolean")) return "boolean";
  if (presentValues.every((value) => typeof value === "number")) return "number";
  if (presentValues.every((value) => value instanceof Date)) return "date";
  if (presentValues.every((value) => typeof value === "string" && looksLikeUrl(value))) {
    return "url";
  }
  if (presentValues.every((value) => typeof value === "string" && looksLikeDate(value))) {
    return "date";
  }
  return "string";
}

function getOrCreateAccumulator(
  folderMap: Map<string, Map<string, FieldAccumulator>>,
  folder: string,
  field: string,
): FieldAccumulator {
  let fields = folderMap.get(folder);
  if (fields === undefined) {
    fields = new Map<string, FieldAccumulator>();
    folderMap.set(folder, fields);
  }
  let accumulator = fields.get(field);
  if (accumulator === undefined) {
    accumulator = { count: 0, values: [] };
    fields.set(field, accumulator);
  }
  return accumulator;
}

interface ObservedScanOptions {
  readonly vault: string;
  readonly ontology?: Ontology;
  readonly folder?: string;
  readonly excludeGlobs?: readonly string[];
  readonly maxFilesPerFolder?: number;
}

function scanExcludeGlobs(opts: { readonly ontology?: Ontology; readonly excludeGlobs?: readonly string[] }): readonly string[] {
  if (opts.ontology === undefined) return opts.excludeGlobs ?? [];
  return resolveExcludeGlobs(opts.ontology, opts.excludeGlobs ?? []);
}

async function validateObservedFolderScope(opts: ObservedScanOptions): Promise<void> {
  if (opts.ontology === undefined) return;
  await validateVaultLintFolder(opts.vault, opts.ontology, opts.folder);
}

export async function collectObservedFields(opts: ObservedScanOptions): Promise<readonly ObservedFolderSummary[]> {
  const fieldsByFolder = new Map<string, Map<string, FieldAccumulator>>();
  const warningsByFolder = new Map<string, string[]>();
  const filesByFolder = new Map<string, number>();
  const maxFilesPerFolder = opts.maxFilesPerFolder ?? 100;
  const excludeGlobs = scanExcludeGlobs(opts);
  await validateObservedFolderScope(opts);

  for await (const relativePath of walkVaultMarkdown(opts.vault)) {
    if (matchesAnyGlob(relativePath, excludeGlobs)) continue;
    const folder = firstFolder(relativePath);
    if (folder === null || (opts.folder !== undefined && folder !== opts.folder)) continue;
    const seen = filesByFolder.get(folder) ?? 0;
    if (seen >= maxFilesPerFolder) continue;
    filesByFolder.set(folder, seen + 1);

    const raw = await readFile(path.join(opts.vault, relativePath), "utf-8");
    const parsed = parseNote(raw);
    if (parsed.diagnostics.length > 0) {
      const warnings = warningsByFolder.get(folder) ?? [];
      for (const diagnostic of parsed.diagnostics) {
        warnings.push(`${relativePath}: ${diagnostic.message}`);
      }
      warningsByFolder.set(folder, warnings);
      continue;
    }

    for (const [field, value] of Object.entries(parsed.frontmatter)) {
      const accumulator = getOrCreateAccumulator(fieldsByFolder, folder, field);
      accumulator.count += 1;
      accumulator.values.push(value);
    }
  }

  return Array.from(fieldsByFolder.entries())
    .map(([folder, fields]) => ({
      folder,
      fields: Array.from(fields.entries())
        .map(([name, accumulator]) => ({
          name,
          type: inferFieldType(accumulator.values),
          count: accumulator.count,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      warnings: warningsByFolder.get(folder) ?? [],
    }))
    .sort((left, right) => left.folder.localeCompare(right.folder));
}

// ── Enum drift detection ──────────────────────────────────────────────────────

/** One frontmatter value observed outside a field's declared `enum`. */
export interface ObservedFieldValueDrift {
  readonly folder: string;
  readonly field: string;
  readonly value: string;
  readonly count: number;
}

/**
 * Scan the vault for string values that violate declared enum constraints,
 * grouped by folder/field/value with a frequency count.
 */
export async function collectObservedFieldValues(opts: ObservedScanOptions & {
  readonly ontology: Ontology;
}): Promise<readonly ObservedFieldValueDrift[]> {
  const drift = new Map<string, Map<string, Map<string, { count: number }>>>();
  const filesByFolder = new Map<string, number>();
  const excludeGlobs = scanExcludeGlobs(opts);
  await validateObservedFolderScope(opts);

  for await (const relativePath of walkVaultMarkdown(opts.vault)) {
    if (matchesAnyGlob(relativePath, excludeGlobs)) continue;
    const folder = firstFolder(relativePath);
    if (folder === null || (opts.folder !== undefined && folder !== opts.folder)) continue;

    if (opts.maxFilesPerFolder !== undefined) {
      const seen = filesByFolder.get(folder) ?? 0;
      if (seen >= opts.maxFilesPerFolder) continue;
      filesByFolder.set(folder, seen + 1);
    }
    const concept = resolveConcept(opts.ontology, relativePath);
    if (!concept) continue;

    const raw = await readFile(path.join(opts.vault, relativePath), "utf-8");
    const parsed = parseNote(raw);
    if (parsed.diagnostics.length > 0) continue;

    for (const field of concept.fields) {
      if (!field.enum || field.enum.length === 0) continue;
      const value = parsed.frontmatter[field.name];
      if (typeof value !== "string" || value.trim() === "") continue;
      if (field.enum.includes(value)) continue;

      const byField = drift.get(folder) ?? new Map<string, Map<string, { count: number }>>();
      drift.set(folder, byField);
      const byValue = byField.get(field.name) ?? new Map<string, { count: number }>();
      byField.set(field.name, byValue);
      const entry = byValue.get(value);
      if (entry) {
        entry.count += 1;
      } else {
        byValue.set(value, { count: 1 });
      }
    }
  }

  const results: ObservedFieldValueDrift[] = [];
  for (const [folder, byField] of drift) {
    for (const [field, byValue] of byField) {
      for (const [value, entry] of byValue) {
        results.push({ folder, field, value, count: entry.count });
      }
    }
  }

  return results.sort(
    (left, right) => right.count - left.count || left.value.localeCompare(right.value),
  );
}

function observedFieldIntent(field: ObservedField): string {
  return `Observed frontmatter field "${field.name}" in existing vault notes (${field.count} sample${field.count === 1 ? "" : "s"}).`;
}

export function mergeObservedFieldsIntoConcept(
  concept: Concept,
  observedFields: readonly ObservedField[],
): Concept {
  const existingNames = new Set(concept.fields.map((field) => field.name));
  const addedFields: OntologyField[] = [];
  for (const observed of observedFields) {
    if (existingNames.has(observed.name)) continue;
    addedFields.push({
      name: observed.name,
      type: observed.type,
      required: false,
      intent: observedFieldIntent(observed),
    });
  }
  return {
    ...concept,
    fields: [...concept.fields, ...addedFields],
    lenses: concept.lenses ?? [],
  };
}

export function parseLensDefinitions(
  input: string,
  knownFields: ReadonlySet<string>,
): readonly OntologyLens[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  return trimmed
    .split(";")
    .map((rawLens) => rawLens.trim())
    .filter((rawLens) => rawLens.length > 0)
    .map((rawLens) => {
      const separatorIndex = rawLens.indexOf(":");
      if (separatorIndex <= 0) {
        throw new Error(`Lens definition "${rawLens}" must use name:field1,field2 syntax.`);
      }
      const name = rawLens.slice(0, separatorIndex).trim();
      const fields = rawLens
        .slice(separatorIndex + 1)
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0);
      for (const field of fields) {
        if (!knownFields.has(field)) {
          throw new Error(`Lens "${name}" references unknown field "${field}".`);
        }
      }
      return {
        name,
        intent: `Retrieval lens for ${name}.`,
        fields,
      };
    });
}
