import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stringify as yamlStringify } from "yaml";
import { loadOntology } from "../ontology/loader.js";
import type { FolderBinding, OntologyField, OntologyLens, Taxonomy } from "../ontology/types.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";
import {
  collectObservedFields,
  mergeObservedFieldsIntoConcept,
  parseLensDefinitions,
  type ObservedField,
} from "../setup/axis.js";
import {
  buildClaudeInstallPlan,
  printClaudeInstallPlan,
} from "./claude-install-plan.js";
import {
  buildPromptConcepts,
  conceptRefToPromptDefault,
  defaultConceptForFolder,
  isFieldType,
  mergeAdditionalFields,
  mergeAdditionalLenses,
  readConceptDocuments,
  readExistingTaxonomy,
  writeConcept,
} from "./setup-documents.js";

const bundledAssets = resolveBundledAssetPaths();

export interface SetupPrompt {
  question(query: string): Promise<string>;
  close(): void;
}

function bundledOntologyDir(): string {
  return bundledAssets.ontologyDir;
}

function humanize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export async function runSetup(opts: {
  vault: string;
  yes: boolean;
  installClaude?: boolean;
  suggestFields?: boolean;
  prompt?: SetupPrompt;
}): Promise<void> {
  const { vault, yes, installClaude = false, suggestFields = false } = opts;
  const nonInteractive = yes || process.env["OMS_NON_INTERACTIVE"] === "1";

  const ontologyDir = bundledOntologyDir();
  const ontology = await loadOntology(ontologyDir);
  const observedSummaries = await collectObservedFields({ vault });
  const observedByFolder = new Map(observedSummaries.map((summary) => [summary.folder, summary]));

  const topEntries = await readdir(vault, { withFileTypes: true });
  const folders = topEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  const omsDir = path.join(vault, ".oms");
  const existingTaxonomy = await readExistingTaxonomy(omsDir);
  const existingConceptDocuments = await readConceptDocuments(omsDir);
  const promptConcepts = buildPromptConcepts(ontology.concepts, existingConceptDocuments);
  const folderBindings: Record<string, FolderBinding> = { ...(existingTaxonomy?.folders ?? {}) };
  const observedFieldsByConcept = new Map<string, ObservedField[]>();
  const interactiveFieldsByConcept = new Map<string, OntologyField[]>();
  const interactiveLensesByConcept = new Map<string, OntologyLens[]>();

  if (nonInteractive) {
    for (const folder of folders) {
      const existing = folderBindings[folder];
      const conceptName =
        conceptRefToPromptDefault(existing?.concept ?? null) ??
        defaultConceptForFolder(promptConcepts, folder);
      folderBindings[folder] = {
        intent: existing?.intent || humanize(folder),
        concept: conceptName,
      };
      if (suggestFields && conceptName !== null) {
        const summary = observedByFolder.get(folder);
        if (summary !== undefined) {
          observedFieldsByConcept.set(conceptName, [
            ...(observedFieldsByConcept.get(conceptName) ?? []),
            ...summary.fields,
          ]);
        }
      }
    }
  } else {
    const rl: SetupPrompt =
      opts.prompt ??
      createInterface({
        input: process.stdin,
        output: process.stdout,
      });

    const conceptNames = Array.from(promptConcepts.keys());

    try {
      console.log("\nOh My Second Brain Setup — adopting existing vault folders.\n");
      console.log(`Available concepts: ${conceptNames.join(", ") || "(none)"}\n`);

      for (const folder of folders) {
        const existing = folderBindings[folder];
        const defaultIntent = existing?.intent || humanize(folder);
        const rawIntent = await rl.question(
          `Folder "${folder}" — intent [${defaultIntent}]: `,
        );
        const intent = rawIntent.trim() || defaultIntent;

        const defaultConcept =
          conceptRefToPromptDefault(existing?.concept ?? null) ??
          defaultConceptForFolder(promptConcepts, folder);

        const conceptPrompt = defaultConcept
          ? `  Bind concept [${defaultConcept}] (blank = ${defaultConcept}, "null" = none): `
          : `  Bind concept (${conceptNames.join("/") || "none"}, blank = none): `;

        const rawConcept = await rl.question(conceptPrompt);
        const trimmed = rawConcept.trim();
        let conceptName: string | null;
        if (trimmed === "null" || trimmed === "") {
          conceptName = trimmed === "null" ? null : (defaultConcept ?? null);
        } else if (promptConcepts.has(trimmed)) {
          conceptName = trimmed;
        } else {
          console.warn(`  Unknown concept "${trimmed}"; binding as null.`);
          conceptName = null;
        }

        folderBindings[folder] = { intent, concept: conceptName };

        const summary = observedByFolder.get(folder);
        if (summary !== undefined && summary.fields.length > 0 && conceptName !== null) {
          const observedNames = summary.fields.map((field) => `${field.name}:${field.type}`).join(", ");
          console.log(`  Observed fields: ${observedNames}`);
          for (const warning of summary.warnings) {
            console.warn(`  Frontmatter warning: ${warning}`);
          }
          const rawFields = await rl.question(
            "  Add observed fields (comma-separated names, blank = none): ",
          );
          const requested = new Set(
            rawFields
              .split(",")
              .map((field) => field.trim())
              .filter((field) => field.length > 0),
          );
          const selected: OntologyField[] = [];
          for (const observed of summary.fields) {
            if (!requested.has(observed.name)) continue;
            const rawType = await rl.question(
              `    Field "${observed.name}" type [${observed.type}]: `,
            );
            const trimmedType = rawType.trim();
            const fieldType = isFieldType(trimmedType) ? trimmedType : observed.type;
            const rawRequired = await rl.question(`    Field "${observed.name}" required? [n]: `);
            const rawFieldIntent = await rl.question(
              `    Field "${observed.name}" intent [Observed ${observed.name}]: `,
            );
            selected.push({
              name: observed.name,
              type: fieldType,
              required: /^y(?:es)?$/i.test(rawRequired.trim()),
              intent: rawFieldIntent.trim() || `Observed ${observed.name}`,
            });
          }
          if (selected.length > 0) {
            interactiveFieldsByConcept.set(conceptName, [
              ...(interactiveFieldsByConcept.get(conceptName) ?? []),
              ...selected,
            ]);
          }
          const knownFields = new Set([
            ...Array.from(promptConcepts.get(conceptName)?.fields ?? []).map((field) => field.name),
            ...selected.map((field) => field.name),
          ]);
          const rawLenses = await rl.question(
            "  Retrieval lenses (name:field1,field2; blank = none): ",
          );
          const lenses = parseLensDefinitions(rawLenses, knownFields);
          if (lenses.length > 0) {
            interactiveLensesByConcept.set(conceptName, [
              ...(interactiveLensesByConcept.get(conceptName) ?? []),
              ...lenses,
            ]);
          }
        }
      }
    } finally {
      rl.close();
    }
  }

  const taxonomy: Taxonomy = { version: existingTaxonomy?.version ?? 0, folders: folderBindings };
  const conceptsOutDir = path.join(omsDir, "concepts");
  await mkdir(conceptsOutDir, { recursive: true });
  await writeFile(path.join(omsDir, "taxonomy.yaml"), yamlStringify(taxonomy), "utf-8");

  const conceptsSourceDir = path.join(ontologyDir, "concepts");
  let copiedFiles: string[] = [];
  try {
    const conceptFiles = await readdir(conceptsSourceDir);
    for (const file of conceptFiles) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        const target = path.join(conceptsOutDir, file);
        try {
          await readFile(target, "utf-8");
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await copyFile(path.join(conceptsSourceDir, file), target);
          copiedFiles.push(file);
        }
      }
    }
  } catch (err) {
    console.warn("[oms] Could not copy concept files:", err);
  }

  const localOntology = await loadOntology(omsDir);
  const localConceptDocuments = await readConceptDocuments(omsDir);
  const conceptNamesToUpdate = new Set([
    ...observedFieldsByConcept.keys(),
    ...interactiveFieldsByConcept.keys(),
    ...interactiveLensesByConcept.keys(),
  ]);
  for (const conceptName of conceptNamesToUpdate) {
    const concept = localOntology.concepts.get(conceptName);
    if (concept === undefined) continue;
    const withObserved = mergeObservedFieldsIntoConcept(
      concept,
      observedFieldsByConcept.get(conceptName) ?? [],
    );
    const withInteractiveFields = mergeAdditionalFields(
      withObserved,
      interactiveFieldsByConcept.get(conceptName) ?? [],
    );
    const withLenses = mergeAdditionalLenses(
      withInteractiveFields,
      interactiveLensesByConcept.get(conceptName) ?? [],
    );
    await writeConcept(omsDir, withLenses, localConceptDocuments.get(conceptName));
  }

  console.log(`\nOh My Second Brain setup complete.`);
  console.log(`  Vault:    ${vault}`);
  console.log(`  Written:  ${path.join(omsDir, "taxonomy.yaml")}`);
  console.log(`  Concepts: ${copiedFiles.join(", ") || "(none)"}`);
  console.log(`  Folders:  ${Object.keys(folderBindings).join(", ") || "(none)"}`);
  console.log(`\nRun "oh-my-second-brain doctor" to validate existing notes.\n`);

  if (installClaude) {
    printClaudeInstallPlan(buildClaudeInstallPlan({ vault }));
    console.log("");
  }
}
