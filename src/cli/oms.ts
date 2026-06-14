#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, readdir, mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { loadOntology } from "../ontology/loader.js";
import { resolveConcept } from "../ontology/resolver.js";
import { parseNote } from "../conventions/frontmatter.js";
import { validateFrontmatter } from "../conventions/validate.js";
import { detectLinkIssues } from "../conventions/lint.js";
import { runMcpServer } from "../mcp/server.js";
import { runPreToolUse } from "../hook/pre-tool-use.js";
import { runPostToolUse } from "../hook/post-tool-use.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";
import {
  collectObservedFields,
  mergeObservedFieldsIntoConcept,
  parseLensDefinitions,
  type ObservedField,
} from "../setup/axis.js";
import {
  checkUpdateNotice,
  formatUpdateNotice,
  formatUpdateResult,
  runUpdate,
  type UpdateRunner,
} from "../update/update.js";
import {
  formatHostOperationResults,
  runHostOperation,
  type RuntimeSelection,
} from "../install/hosts.js";
import { isSemanticCliCommand, runSemanticCli } from "./semantic.js";
import type { Concept, FieldType, FolderBinding, OntologyField, OntologyLens, Taxonomy } from "../ontology/types.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const bundledAssets = resolveBundledAssetPaths();

function bundledOntologyDir(): string {
  return bundledAssets.ontologyDir;
}

function bundledClaudeAdapterDir(): string {
  return bundledAssets.claudeAdapterDir;
}

function bundledAdapterRoot(): string {
  return bundledAssets.adapterRoot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Humanize a folder name: "references" → "References". */
function humanize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Quote a value for copy/pasteable POSIX shell commands. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCurrentPackageVersion(): Promise<string | null> {
  const packageJson: unknown = JSON.parse(
    await readFile(path.join(bundledAssets.packageRoot, "package.json"), "utf-8"),
  );
  return isRecord(packageJson) && typeof packageJson["version"] === "string"
    ? packageJson["version"]
    : null;
}

function updateNoticeDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["OMS_UPDATE_NOTICE"] === "0" || env["OMS_NO_UPDATE_NOTICE"] === "1";
}

function parseUpdateNoticeTimeout(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env["OMS_UPDATE_NOTICE_TIMEOUT_MS"];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function maybePrintUpdateNotice(options: {
  readonly currentVersion?: string | null;
  readonly latestVersion?: string;
  readonly timeoutMs?: number;
  readonly runner?: UpdateRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (message: string) => void;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (updateNoticeDisabled(env)) return;

  const currentVersion = options.currentVersion ?? await readCurrentPackageVersion();
  const notice = await checkUpdateNotice({
    currentVersion,
    latestVersion: options.latestVersion ?? env["OMS_UPDATE_LATEST_VERSION"],
    timeoutMs: options.timeoutMs ?? parseUpdateNoticeTimeout(env),
    runner: options.runner,
  });
  const formatted = formatUpdateNotice(notice);
  if (formatted.length === 0) return;

  const write = options.write ?? ((message: string) => console.error(message));
  write(`\n${formatted}`);
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

interface ConceptDocument {
  readonly filePath: string;
  readonly raw: Record<string, unknown>;
  readonly concept: Concept;
}

export interface SetupPrompt {
  question(query: string): Promise<string>;
  close(): void;
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

async function readConceptDocuments(omsDir: string): Promise<Map<string, ConceptDocument>> {
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

function buildPromptConcepts(
  shippedConcepts: ReadonlyMap<string, Concept>,
  localDocuments: ReadonlyMap<string, ConceptDocument>,
): Map<string, Concept> {
  const concepts = new Map(shippedConcepts);
  for (const [name, document] of localDocuments) {
    concepts.set(name, document.concept);
  }
  return concepts;
}

async function readExistingTaxonomy(omsDir: string): Promise<Taxonomy | null> {
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

function defaultConceptForFolder(
  concepts: ReadonlyMap<string, Concept>,
  folder: string,
): string | null {
  for (const [name, concept] of concepts) {
    if (concept.folder === folder) return name;
  }
  return null;
}

function conceptRefToPromptDefault(concept: FolderBinding["concept"]): string | null {
  if (Array.isArray(concept)) return concept[0] ?? null;
  return concept;
}

function isFieldType(value: string): value is FieldType {
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

function mergeAdditionalFields(concept: Concept, fields: readonly OntologyField[]): Concept {
  const existing = new Set(concept.fields.map((field) => field.name));
  const additions = fields.filter((field) => !existing.has(field.name));
  return {
    ...concept,
    fields: [...concept.fields, ...additions],
    lenses: concept.lenses ?? [],
  };
}

function mergeAdditionalLenses(concept: Concept, lenses: readonly OntologyLens[]): Concept {
  const existing = new Set((concept.lenses ?? []).map((lens) => lens.name));
  const additions = lenses.filter((lens) => !existing.has(lens.name));
  return {
    ...concept,
    fields: concept.fields,
    lenses: [...(concept.lenses ?? []), ...additions],
  };
}

async function writeConcept(
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

export interface ClaudeInstallPlan {
  pluginPath: string;
  pluginInstallCommand: string;
  mcpRegistrationCommand: string;
  mcpRuntimeStatus: "read-status-runtime";
}

export function buildClaudeInstallPlan(opts: { vault: string }): ClaudeInstallPlan {
  const pluginPath = bundledClaudeAdapterDir();
  return {
    pluginPath,
    pluginInstallCommand: `claude plugin install ${shellQuote(pluginPath)}`,
    mcpRegistrationCommand: `claude mcp add oms -- oms mcp --vault ${shellQuote(opts.vault)}`,
    mcpRuntimeStatus: "read-status-runtime",
  };
}

function printClaudeInstallPlan(plan: ClaudeInstallPlan): void {
  console.log("Claude Code harness install plan (dry-run).");
  console.log(`  Plugin path: ${plan.pluginPath}`);
  console.log(`  Plugin command: ${plan.pluginInstallCommand}`);
  console.log(`  MCP command: ${plan.mcpRegistrationCommand}`);
  console.log(
    "  MCP status: status/read/cache/retrieval plus safe capture; commit is gated by vault confinement and contract validation.",
  );
}

/** Walk a directory recursively, yielding relative paths for all .md files. */
async function* walkMarkdown(
  dir: string,
  base: string,
  skipDirs: Set<string>,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base, skipDirs);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.relative(base, full).replace(/\\/g, "/");
    }
  }
}

// ---------------------------------------------------------------------------
// runSetup
// ---------------------------------------------------------------------------

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

  // Load shipped concepts so we can offer meaningful defaults.
  const ontology = await loadOntology(ontologyDir);
  const observedSummaries = await collectObservedFields({ vault });
  const observedByFolder = new Map(observedSummaries.map((summary) => [summary.folder, summary]));

  // Scan vault top-level directories (skip dotfiles).
  const topEntries = await readdir(vault, { withFileTypes: true });
  const folders = topEntries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  const omsDir = path.join(vault, ".oms");
  const existingTaxonomy = await readExistingTaxonomy(omsDir);
  const existingConceptDocuments = await readConceptDocuments(omsDir);
  const promptConcepts = buildPromptConcepts(ontology.concepts, existingConceptDocuments);
  const folderBindings: Record<string, FolderBinding> = { ...(existingTaxonomy?.folders ?? {}) };
  const observedFieldsByConcept = new Map<string, ObservedField[]>();
  const interactiveFieldsByConcept = new Map<string, OntologyField[]>();
  const interactiveLensesByConcept = new Map<string, OntologyLens[]>();

  if (nonInteractive) {
    // Non-interactive: use defaults without readline.
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
    // Interactive: ask intent and concept for each folder.
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

        // Find default concept
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

  // Write the vault-local ontology. ``.oms/` IS the ontology directory:
  // `.oms/taxonomy.yaml` + `.oms/concepts/*.yaml`, matching loadOntology's
  // contract so `oms doctor` can load it directly.
  const conceptsOutDir = path.join(omsDir, "concepts");
  await mkdir(conceptsOutDir, { recursive: true });

  await writeFile(path.join(omsDir, "taxonomy.yaml"), yamlStringify(taxonomy), "utf-8");

  // Copy shipped concept yaml files into vault/.oms/concepts/
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

  // Summary
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

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

export async function runDoctor(opts: { vault: string }): Promise<number> {
  const { vault } = opts;

  // Doctor is non-blocking (onViolation: warn). It must ALWAYS exit 0 in v0,
  // even if the ontology is missing or unparseable — wrap the whole body so a
  // failure surfaces as a warning, never a non-zero exit.
  try {
    // Load ontology: prefer the vault-local `.oms/` ontology, fall back to the
    // bundled defaults. The vault-local layout is `.oms/taxonomy.yaml` +
    // `.oms/concepts/`, so `.oms/` itself is the ontology dir.
    const localOntologyDir = path.join(vault, ".oms");
    let ontologyDir: string;
    try {
      await readdir(path.join(localOntologyDir, "concepts"));
      ontologyDir = localOntologyDir;
    } catch {
      ontologyDir = bundledOntologyDir();
    }

    const ontology = await loadOntology(ontologyDir);

    const skipDirs = new Set(["node_modules"]);
    let totalNotes = 0;
    let totalViolations = 0;
    let notesWithViolations = 0;

    for await (const relPath of walkMarkdown(vault, vault, skipDirs)) {
      const concept = resolveConcept(ontology, relPath);
      if (!concept) continue;

      totalNotes++;
      const fullPath = path.join(vault, relPath);
      let raw: string;
      try {
        raw = await readFile(fullPath, "utf-8");
      } catch {
        console.warn(`[oms] Could not read ${relPath}`);
        continue;
      }

      const { frontmatter } = parseNote(raw);
      const result = validateFrontmatter(frontmatter, concept);

      if (result.violations.length > 0) {
        notesWithViolations++;
        totalViolations += result.violations.length;
        console.log(`\n  ${relPath} [concept: ${concept.concept}]`);
        for (const v of result.violations) {
          console.log(`    [${v.rule}] ${v.message}`);
        }
      }
    }

    console.log(
      `\nOh My Second Brain doctor: ${totalNotes} notes checked, ${notesWithViolations} with violations, ${totalViolations} total violations.`,
    );
    console.log("All violations are warnings (onViolation: warn). Exit 0.\n");

    // Broken-link and orphan detection (C4 lint port).
    try {
      const lintResult = await detectLinkIssues(vault);
      if (lintResult.brokenLinks.length > 0) {
        console.log(`\n--- Broken wikilinks (${lintResult.brokenLinks.length}) ---`);
        for (const { notePath, target } of lintResult.brokenLinks) {
          console.log(`  [broken-link] ${notePath} -> [[${target}]]`);
        }
      } else {
        console.log("Broken wikilinks: 0");
      }

      const orphanCount = lintResult.orphanPaths.length;
      if (orphanCount > 0) {
        console.log(`\n--- Orphan notes (no incoming links): ${orphanCount} ---`);
        for (const p of lintResult.orphanPaths.slice(0, 20)) {
          console.log(`  [orphan] ${p}`);
        }
        if (orphanCount > 20) {
          console.log(`  ... and ${orphanCount - 20} more`);
        }
      } else {
        console.log("Orphan notes: 0");
      }
    } catch (lintErr) {
      console.warn("[oms] lint detection could not complete:", lintErr);
    }
  } catch (err) {
    console.warn("[oms] doctor could not complete:", err);
  }

  // Always exit 0 in v0 (non-blocking, onViolation: warn).
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
oh-my-second-brain — Oh My Second Brain convention layer for Obsidian vaults

Usage:
  oh-my-second-brain setup [--vault <path>] [--yes] [--suggest-fields] [--install-claude]
  oh-my-second-brain install [--vault <path>] [--runtime <auto|all|claude|codex|hermes>] [--dry-run] [--execute] [--yes]
  oh-my-second-brain uninstall [--runtime <all|claude|codex|hermes>] [--dry-run] [--execute] [--yes]
  oh-my-second-brain update [--check] [--dry-run] [--yes] [--runtime <auto|all|claude|codex|hermes>] [--vault <path>]
  oh-my-second-brain doctor [--vault <path>]
  oh-my-second-brain semantic <status|sync|query|search|vsearch|get|multi-get|collection> [options]
  oh-my-second-brain mcp [--vault <path>]
  oh-my-second-brain hook pre-tool-use [--vault <path>]
  oh-my-second-brain hook post-tool-use [--vault <path>]

Compatibility alias: oms <command>

Commands:
  setup    Adopt an existing vault into the Oh My Second Brain convention.
  install  Install Oh My Second Brain host adapters and MCP registration.
  uninstall Remove Oh My Second Brain host adapters and MCP registration.
  update   Check for or apply an explicit package update, then refresh host adapters.
  doctor   Validate vault notes against the active ontology (includes broken-link and orphan detection).
  semantic Native markdown semantic index/search/get commands.
  mcp      Start the read/status MCP stdio server.
  hook     Vault guard hooks for Claude Code PreToolUse / PostToolUse events.
             pre-tool-use  Read PreToolUse JSON from stdin; block unregistered folder creation.
             post-tool-use Read PostToolUse JSON from stdin; audit frontmatter + trigger graph build.

Options:
  --vault <path>   Path to the vault root (default: current directory).
  --yes            Non-interactive setup, uninstall confirmation, or update execution.
  --suggest-fields During setup --yes, add conservative observed frontmatter fields to concepts.
  --install-claude Print Claude Code plugin install and MCP registration commands (dry-run).
  --runtime <name> Select host runtime (default: auto for install, all for uninstall).
  --dry-run        Preview host config changes without writing files.
  --execute        Allow external host CLIs such as \`claude\` to run when available.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // Parse shared flags.
  let vault = process.cwd();
  let yes = false;
  let installClaude = false;
  let suggestFields = false;
  let runtime: RuntimeSelection | undefined;
  let dryRun = false;
  let executeExternal = false;
  let checkUpdate = false;
  let timeoutMs: number | undefined;
  let agentVault: string | undefined;
  const unknownFlags: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--vault" && argv[i + 1]) {
      vault = path.resolve(argv[i + 1]!);
      i++;
    } else if (argv[i] === "--yes") {
      yes = true;
    } else if (argv[i] === "--install-claude") {
      installClaude = true;
    } else if (argv[i] === "--suggest-fields") {
      suggestFields = true;
    } else if (argv[i] === "--check") {
      checkUpdate = true;
    } else if (argv[i] === "--timeout-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`[oms] Unsupported timeout: ${argv[i + 1]!}`);
        process.exitCode = 1;
        return;
      }
      timeoutMs = parsed;
      i++;
    } else if (argv[i] === "--runtime" && argv[i + 1]) {
      const rawRuntime = argv[i + 1]!;
      if (
        rawRuntime === "auto" ||
        rawRuntime === "all" ||
        rawRuntime === "claude" ||
        rawRuntime === "codex" ||
        rawRuntime === "hermes"
      ) {
        runtime = rawRuntime;
      } else {
        console.error(`[oms] Unsupported runtime: ${rawRuntime}`);
        process.exitCode = 1;
        return;
      }
      i++;
    } else if (argv[i] === "--agent-vault" && argv[i + 1]) {
      agentVault = path.resolve(argv[i + 1]!);
      i++;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--execute") {
      executeExternal = true;
    } else {
      unknownFlags.push(argv[i]!);
    }
  }

  if (command === "setup") {
    await runSetup({ vault, yes, installClaude, suggestFields });
    await maybePrintUpdateNotice();
  } else if (command === "install" || command === "uninstall") {
    const selectedRuntime = runtime ?? (command === "install" ? "auto" : "all");
    if (command === "uninstall" && !yes && !dryRun && process.env["OMS_NON_INTERACTIVE"] !== "1") {
      console.error("[oms] Refusing uninstall without --yes or --dry-run.");
      process.exitCode = 1;
      return;
    }
    const results = await runHostOperation({
      action: command,
      runtime: selectedRuntime,
      vault,
      agentVault,
      dryRun,
      executeExternal,
      yes,
      adapterRoot: bundledAdapterRoot(),
    });
    console.log(formatHostOperationResults(results, dryRun));
    await maybePrintUpdateNotice();
  } else if (command === "update") {
    if (unknownFlags.length > 0) {
      console.error(`[oms] Unsupported update option: ${unknownFlags.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const currentVersion = await readCurrentPackageVersion();
    const latestVersion = process.env["OMS_UPDATE_LATEST_VERSION"];
    const result = await runUpdate({
      currentVersion,
      latestVersion,
      runtime: runtime ?? "all",
      vault,
      check: checkUpdate,
      dryRun,
      yes,
      executeExternal,
      timeoutMs,
      reconcileCommand: {
        command: process.execPath,
        argsPrefix: process.argv[1] === undefined ? [] : [process.argv[1]],
      },
    });
    console.log(formatUpdateResult(result));
    process.exitCode = result.success ? 0 : 1;
  } else if (command === "update-reconcile") {
    if (process.env["OMS_UPDATE_RECONCILE"] !== "1" && !dryRun) {
      console.error("[oms] update-reconcile is internal; run `oms update --yes` instead.");
      process.exitCode = 1;
      return;
    }
    const results = await runHostOperation({
      action: "install",
      runtime: runtime ?? "all",
      vault,
      dryRun,
      executeExternal,
      yes: true,
      adapterRoot: bundledAdapterRoot(),
    });
    console.log(formatHostOperationResults(results, dryRun));
  } else if (command === "doctor") {
    process.exitCode = await runDoctor({ vault });
    await maybePrintUpdateNotice();
  } else if (isSemanticCliCommand(command)) {
    process.exitCode = await runSemanticCli({
      argv,
      vault,
    });
    await maybePrintUpdateNotice();
  } else if (command === "mcp") {
    await runMcpServer({ vault });
  } else if (command === "hook") {
    const subcommand = argv[1];
    if (subcommand === "pre-tool-use") {
      await runPreToolUse({ vault });
    } else if (subcommand === "post-tool-use") {
      await runPostToolUse({ vault });
    } else {
      console.error(`[oms] Unknown hook subcommand: ${subcommand ?? "(none)"}`);
      console.error("Usage: oms hook <pre-tool-use|post-tool-use> [--vault <path>]");
      process.exitCode = 1;
    }
  } else {
    printUsage();
    process.exitCode = 0;
  }
}

// Guard: only run main() when this file is the entry point.
// Works for both source (`src/cli/oms.ts`) and built (`dist/cli/oms.js`) paths.
const __filename = fileURLToPath(import.meta.url);

function sameEntrypoint(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
  } catch {
    return false;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (sameEntrypoint(process.argv[1], __filename) ||
    sameEntrypoint(process.argv[1], __filename.replace(/\.ts$/, ".js")));

if (isMain) {
  main().catch((err: unknown) => {
    console.error("[oms] Fatal error:", err);
    process.exitCode = 1;
  });
}
