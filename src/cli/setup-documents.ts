import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { Concept, FieldType, FolderBinding, OntologyField, OntologyLens, Taxonomy } from "../kernel/ontology/types.js";

export interface ConceptDocument {
  readonly filePath: string;
  readonly raw: Record<string, unknown>;
  readonly concept: Concept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConceptRef(value: unknown): FolderBinding["concept"] {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return null;
}

function parseFolderBinding(value: unknown): FolderBinding | null {
  if (!isRecord(value)) return null;
  const rawIntent = value["intent"];
  return {
    intent: typeof rawIntent === "string" && rawIntent.trim() ? rawIntent : "",
    concept: parseConceptRef(value["concept"]),
  };
}

function parseConceptDocument(
  filePath: string,
  parsed: Record<string, unknown>,
): ConceptDocument {
  const concept: Concept = {
    concept: typeof parsed["concept"] === "string" ? parsed["concept"] : path.basename(filePath, path.extname(filePath)),
    intent: typeof parsed["intent"] === "string" ? parsed["intent"] : "",
    folder: typeof parsed["folder"] === "string" ? parsed["folder"] : "",
    fields: Array.isArray(parsed["fields"]) ? (parsed["fields"] as Concept["fields"]) : [],
    lenses: Array.isArray(parsed["lenses"]) ? (parsed["lenses"] as Concept["lenses"]) : [],
  };
  return { filePath, raw: parsed, concept };
}

export async function readConceptDocuments(omsDir: string): Promise<Map<string, ConceptDocument>> {
  const documents = new Map<string, ConceptDocument>();
  const conceptsDir = path.join(omsDir, "concepts");
  let entries;
  try {
    entries = await readdir(conceptsDir);
  } catch (error) {
    if (error instanceof Error) return documents;
    throw error;
  }
  for (const file of entries) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const filePath = path.join(conceptsDir, file);
    const parsed: unknown = yamlParse(await readFile(filePath, "utf-8"));
    if (!isRecord(parsed)) continue;
    const document = parseConceptDocument(filePath, parsed);
    documents.set(document.concept.concept, document);
  }
  return documents;
}

export function buildPromptConcepts(
  shippedConcepts: ReadonlyMap<string, Concept>,
  localDocuments: ReadonlyMap<string, ConceptDocument>,
): Map<string, Concept> {
  const concepts = new Map(shippedConcepts);
  for (const [name, document] of localDocuments) {
    concepts.set(name, document.concept);
  }
  return concepts;
}

export function defaultConceptForFolder(
  concepts: ReadonlyMap<string, Concept>,
  folder: string,
): string | null {
  for (const [name, concept] of concepts) {
    if (concept.folder === folder) return name;
  }
  return null;
}

export function conceptRefToPromptDefault(concept: FolderBinding["concept"]): string | null {
  if (Array.isArray(concept)) return concept[0] ?? null;
  return concept;
}

export function isFieldType(value: string): value is FieldType {
  switch (value) {
    case "string":
    case "url":
    case "date":
    case "list":
    case "number":
    case "boolean":
      return true;
    default:
      return false;
  }
}

export async function readExistingTaxonomy(omsDir: string): Promise<Taxonomy | null> {
  try {
    const raw = await readFile(path.join(omsDir, "taxonomy.yaml"), "utf-8");
    const parsed: unknown = yamlParse(raw);
    if (!isRecord(parsed)) return null;
    const rawFolders = parsed["folders"];
    const folders: Record<string, FolderBinding> = {};
    if (isRecord(rawFolders)) {
      for (const [folder, binding] of Object.entries(rawFolders)) {
        const parsedBinding = parseFolderBinding(binding);
        if (parsedBinding !== null) {
          folders[folder] = parsedBinding;
        }
      }
    }
    return {
      version: typeof parsed["version"] === "number" ? parsed["version"] : 0,
      folders,
    };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export function mergeAdditionalFields(concept: Concept, fields: readonly OntologyField[]): Concept {
  const existing = new Set(concept.fields.map((field) => field.name));
  const additions = fields.filter((field) => !existing.has(field.name));
  return {
    ...concept,
    fields: [...concept.fields, ...additions],
    lenses: concept.lenses ?? [],
  };
}

export function mergeAdditionalLenses(concept: Concept, lenses: readonly OntologyLens[]): Concept {
  const existing = new Set((concept.lenses ?? []).map((lens) => lens.name));
  const additions = lenses.filter((lens) => !existing.has(lens.name));
  return {
    ...concept,
    fields: concept.fields,
    lenses: [...(concept.lenses ?? []), ...additions],
  };
}

export async function writeConcept(
  omsDir: string,
  concept: Concept,
  existingDocument?: ConceptDocument,
): Promise<void> {
  const conceptsOutDir = path.join(omsDir, "concepts");
  await mkdir(conceptsOutDir, { recursive: true });
  const document: Record<string, unknown> = {
    ...(existingDocument?.raw ?? {}),
    concept: concept.concept,
    intent: concept.intent,
    folder: concept.folder,
    fields: concept.fields,
    lenses: concept.lenses ?? [],
  };
  await writeFile(
    existingDocument?.filePath ?? path.join(conceptsOutDir, `${concept.concept}.yaml`),
    yamlStringify(document),
    "utf-8",
  );
}
