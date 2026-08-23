import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { loadOntology } from "../ontology/loader.js";
import type { Concept, FolderBinding, OntologyField, OntologyLens, Taxonomy } from "../ontology/types.js";
import { collectObservedFields, mergeObservedFieldsIntoConcept, type ObservedField, type ObservedFolderSummary } from "./axis.js";
import {
  buildPromptConcepts,
  conceptRefToPromptDefault,
  defaultConceptForFolder,
  mergeAdditionalFields,
  mergeAdditionalLenses,
  readConceptDocuments,
  readExistingTaxonomy,
  writeConcept,
  type ConceptDocument,
} from "./documents.js";

export interface SetupState {
  readonly vault: string;
  readonly ontologyDir: string;
  readonly omsDir: string;
  readonly folders: readonly string[];
  readonly existingTaxonomy: Taxonomy | null;
  readonly promptConcepts: ReadonlyMap<string, Concept>;
  readonly observedByFolder: ReadonlyMap<string, ObservedFolderSummary>;
  readonly localConceptDocuments: ReadonlyMap<string, ConceptDocument>;
  readonly bundledConceptFiles: readonly string[];
}

export interface SetupInputs {
  readonly folderBindings: Readonly<Record<string, FolderBinding>>;
  readonly observedFieldsByConcept?: ReadonlyMap<string, readonly ObservedField[]>;
  readonly additionalFieldsByConcept?: ReadonlyMap<string, readonly OntologyField[]>;
  readonly additionalLensesByConcept?: ReadonlyMap<string, readonly OntologyLens[]>;
}

export interface SetupDecision {
  readonly vault: string;
  readonly omsDir: string;
  readonly ontologyDir: string;
  readonly taxonomy: Taxonomy;
  readonly bundledConceptFiles: readonly string[];
  readonly concepts: readonly { concept: Concept; existingDocument?: ConceptDocument }[];
}

export async function inspectSetup({ vault, ontologyDir }: { vault: string; ontologyDir: string }): Promise<SetupState> {
  const [ontology, observedSummaries, topEntries, existingTaxonomy, localConceptDocuments, conceptEntries] = await Promise.all([
    loadOntology(ontologyDir),
    collectObservedFields({ vault }),
    readdir(vault, { withFileTypes: true }),
    readExistingTaxonomy(path.join(vault, ".oms")),
    readConceptDocuments(path.join(vault, ".oms")),
    readdir(path.join(ontologyDir, "concepts")),
  ]);
  return {
    vault, ontologyDir, omsDir: path.join(vault, ".oms"),
    folders: topEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name),
    existingTaxonomy,
    promptConcepts: buildPromptConcepts(ontology.concepts, localConceptDocuments),
    observedByFolder: new Map(observedSummaries.map((summary) => [summary.folder, summary])),
    localConceptDocuments,
    bundledConceptFiles: conceptEntries.filter((file) => file.endsWith(".yaml") || file.endsWith(".yml")),
  };
}

export function defaultSetupBinding(state: SetupState, folder: string): FolderBinding {
  const existing = state.existingTaxonomy?.folders[folder];
  return {
    intent: existing?.intent || `${folder.charAt(0).toUpperCase()}${folder.slice(1)}`,
    concept: conceptRefToPromptDefault(existing?.concept ?? null) ?? defaultConceptForFolder(state.promptConcepts, folder),
  };
}

export function decideSetup(state: SetupState, inputs: SetupInputs): SetupDecision {
  const observed = inputs.observedFieldsByConcept ?? new Map();
  const additionalFields = inputs.additionalFieldsByConcept ?? new Map();
  const additionalLenses = inputs.additionalLensesByConcept ?? new Map();
  const names = new Set([...observed.keys(), ...additionalFields.keys(), ...additionalLenses.keys()]);
  const concepts = [...names].flatMap((name) => {
    const concept = state.promptConcepts.get(name);
    if (concept === undefined) return [];
    return [{
      concept: mergeAdditionalLenses(
        mergeAdditionalFields(mergeObservedFieldsIntoConcept(concept, observed.get(name) ?? []), additionalFields.get(name) ?? []),
        additionalLenses.get(name) ?? [],
      ),
      existingDocument: state.localConceptDocuments.get(name),
    }];
  });
  return {
    vault: state.vault, omsDir: state.omsDir, ontologyDir: state.ontologyDir,
    taxonomy: { version: state.existingTaxonomy?.version ?? 0, folders: { ...inputs.folderBindings } },
    bundledConceptFiles: state.bundledConceptFiles,
    concepts,
  };
}

export function decideNonInteractiveSetup(state: SetupState, suggestFields: boolean): SetupDecision {
  const folderBindings: Record<string, FolderBinding> = { ...(state.existingTaxonomy?.folders ?? {}) };
  const observedFieldsByConcept = new Map<string, readonly ObservedField[]>();
  for (const folder of state.folders) {
    const binding = defaultSetupBinding(state, folder);
    folderBindings[folder] = binding;
    if (suggestFields && typeof binding.concept === "string") {
      const fields = state.observedByFolder.get(folder)?.fields;
      if (fields !== undefined) observedFieldsByConcept.set(binding.concept, [...(observedFieldsByConcept.get(binding.concept) ?? []), ...fields]);
    }
  }
  return decideSetup(state, { folderBindings, observedFieldsByConcept });
}

export async function applySetup(decision: SetupDecision, { dryRun = false }: { dryRun?: boolean } = {}): Promise<{ copiedFiles: readonly string[]; copyError?: unknown }> {
  if (dryRun) return { copiedFiles: [] };
  const conceptsOutDir = path.join(decision.omsDir, "concepts");
  await mkdir(conceptsOutDir, { recursive: true });
  await writeFile(path.join(decision.omsDir, "taxonomy.yaml"), yamlStringify(decision.taxonomy), "utf-8");
  const copiedFiles: string[] = [];
  let copyError: unknown;
  try {
    for (const file of decision.bundledConceptFiles) {
      const target = path.join(conceptsOutDir, file);
      try {
        await readFile(target, "utf-8");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await copyFile(path.join(decision.ontologyDir, "concepts", file), target);
        copiedFiles.push(file);
      }
    }
  } catch (error) {
    copyError = error;
  }
  for (const { concept, existingDocument } of decision.concepts) await writeConcept(decision.omsDir, concept, existingDocument);
  return { copiedFiles, copyError };
}
