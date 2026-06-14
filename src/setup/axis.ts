import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseNote } from "../conventions/frontmatter.js";
import type { Concept, FieldType, OntologyField, OntologyLens } from "../ontology/types.js";

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

const SKIP_DIRS = new Set(["node_modules"]);

async function* walkVaultMarkdown(
  dir: string,
  base: string,
): AsyncGenerator<{ readonly relativePath: string; readonly fullPath: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkVaultMarkdown(fullPath, base);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield {
        relativePath: path.relative(base, fullPath).replace(/\\/g, "/"),
        fullPath,
      };
    }
  }
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

export async function collectObservedFields(opts: {
  readonly vault: string;
  readonly maxFilesPerFolder?: number;
}): Promise<readonly ObservedFolderSummary[]> {
  const fieldsByFolder = new Map<string, Map<string, FieldAccumulator>>();
  const warningsByFolder = new Map<string, string[]>();
  const filesByFolder = new Map<string, number>();
  const maxFilesPerFolder = opts.maxFilesPerFolder ?? 100;

  for await (const file of walkVaultMarkdown(opts.vault, opts.vault)) {
    const folder = firstFolder(file.relativePath);
    if (folder === null) continue;
    const seen = filesByFolder.get(folder) ?? 0;
    if (seen >= maxFilesPerFolder) continue;
    filesByFolder.set(folder, seen + 1);

    const raw = await readFile(file.fullPath, "utf-8");
    const parsed = parseNote(raw);
    if (parsed.diagnostics.length > 0) {
      const warnings = warningsByFolder.get(folder) ?? [];
      for (const diagnostic of parsed.diagnostics) {
        warnings.push(`${file.relativePath}: ${diagnostic.message}`);
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
