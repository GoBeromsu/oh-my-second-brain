import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { FolderBinding, OntologyField, OntologyLens } from "../kernel/ontology/types.js";
import { resolveBundledAssetPaths } from "../kernel/runtime/assets.js";
import { parseLensDefinitions } from "../kernel/setup/axis.js";
import {
  applySetup,
  decideNonInteractiveSetup,
  decideSetup,
  defaultSetupBinding,
  inspectSetup,
} from "../kernel/setup/service.js";
import { isFieldType } from "../kernel/setup/documents.js";
import { buildClaudeInstallPlan, printClaudeInstallPlan } from "./claude-install-plan.js";

const bundledAssets = resolveBundledAssetPaths();

export interface SetupPrompt {
  question(query: string): Promise<string>;
  close(): void;
}

export async function runSetup(opts: {
  vault: string;
  yes: boolean;
  installClaude?: boolean;
  suggestFields?: boolean;
  dryRun?: boolean;
  prompt?: SetupPrompt;
}): Promise<void> {
  const { vault, yes, installClaude = false, suggestFields = false, dryRun = false } = opts;
  const nonInteractive = yes || process.env["OMS_NON_INTERACTIVE"] === "1";
  const state = await inspectSetup({ vault, ontologyDir: bundledAssets.ontologyDir });
  let decision;

  if (nonInteractive) {
    decision = decideNonInteractiveSetup(state, suggestFields);
  } else {
    const rl: SetupPrompt = opts.prompt ?? createInterface({ input: process.stdin, output: process.stdout });
    const folderBindings: Record<string, FolderBinding> = { ...(state.existingTaxonomy?.folders ?? {}) };
    const interactiveFieldsByConcept = new Map<string, OntologyField[]>();
    const interactiveLensesByConcept = new Map<string, OntologyLens[]>();
    const conceptNames = Array.from(state.promptConcepts.keys());

    try {
      console.log("\nOh My Second Brain Setup — adopting existing vault folders.\n");
      console.log(`Available concepts: ${conceptNames.join(", ") || "(none)"}\n`);
      for (const folder of state.folders) {
        const defaults = defaultSetupBinding(state, folder);
        const rawIntent = await rl.question(`Folder "${folder}" — intent [${defaults.intent}]: `);
        const intent = rawIntent.trim() || defaults.intent;
        const defaultConcept = typeof defaults.concept === "string" ? defaults.concept : null;
        const conceptPrompt = defaultConcept
          ? `  Bind concept [${defaultConcept}] (blank = ${defaultConcept}, "null" = none): `
          : `  Bind concept (${conceptNames.join("/") || "none"}, blank = none): `;
        const trimmed = (await rl.question(conceptPrompt)).trim();
        let conceptName: string | null;
        if (trimmed === "null" || trimmed === "") {
          conceptName = trimmed === "null" ? null : (defaultConcept ?? null);
        } else if (state.promptConcepts.has(trimmed)) {
          conceptName = trimmed;
        } else {
          console.warn(`  Unknown concept "${trimmed}"; binding as null.`);
          conceptName = null;
        }
        folderBindings[folder] = { intent, concept: conceptName };

        const summary = state.observedByFolder.get(folder);
        if (summary !== undefined && summary.fields.length > 0 && conceptName !== null) {
          console.log(`  Observed fields: ${summary.fields.map((field) => `${field.name}:${field.type}`).join(", ")}`);
          for (const warning of summary.warnings) console.warn(`  Frontmatter warning: ${warning}`);
          const requested = new Set((await rl.question("  Add observed fields (comma-separated names, blank = none): ")).split(",").map((field) => field.trim()).filter(Boolean));
          const selected: OntologyField[] = [];
          for (const observed of summary.fields) {
            if (!requested.has(observed.name)) continue;
            const rawType = await rl.question(`    Field "${observed.name}" type [${observed.type}]: `);
            const rawRequired = await rl.question(`    Field "${observed.name}" required? [n]: `);
            const rawFieldIntent = await rl.question(`    Field "${observed.name}" intent [Observed ${observed.name}]: `);
            const requestedType = rawType.trim();
            selected.push({ name: observed.name, type: isFieldType(requestedType) ? requestedType : observed.type, required: /^y(?:es)?$/i.test(rawRequired.trim()), intent: rawFieldIntent.trim() || `Observed ${observed.name}` });
          }
          if (selected.length > 0) interactiveFieldsByConcept.set(conceptName, [...(interactiveFieldsByConcept.get(conceptName) ?? []), ...selected]);
          const knownFields = new Set([...(state.promptConcepts.get(conceptName)?.fields ?? []).map((field) => field.name), ...selected.map((field) => field.name)]);
          const lenses = parseLensDefinitions(await rl.question("  Retrieval lenses (name:field1,field2; blank = none): "), knownFields);
          if (lenses.length > 0) interactiveLensesByConcept.set(conceptName, [...(interactiveLensesByConcept.get(conceptName) ?? []), ...lenses]);
        }
      }
    } finally {
      rl.close();
    }
    decision = decideSetup(state, { folderBindings, additionalFieldsByConcept: interactiveFieldsByConcept, additionalLensesByConcept: interactiveLensesByConcept });
  }

  const { copiedFiles, copyError } = await applySetup(decision, { dryRun });
  if (copyError !== undefined) console.warn("[oms] Could not copy concept files:", copyError);
  console.log(`\nOh My Second Brain setup ${dryRun ? "preview complete" : "complete"}.`);
  console.log(`  Vault:    ${vault}`);
  console.log(`  ${dryRun ? "Would write" : "Written"}:  ${path.join(state.omsDir, "taxonomy.yaml")}`);
  console.log(`  Concepts: ${dryRun ? decision.bundledConceptFiles.join(", ") || "(none)" : copiedFiles.join(", ") || "(none)"}`);
  console.log(`  Folders:  ${Object.keys(decision.taxonomy.folders).join(", ") || "(none)"}`);
  console.log(`\nRun "oh-my-second-brain doctor" to validate existing notes.\n`);
  if (installClaude) {
    printClaudeInstallPlan(buildClaudeInstallPlan({ vault }));
    console.log("");
  }
}
