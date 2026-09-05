import {
  createVaultLink,
  LINKED_GITIGNORE_PATTERN,
  LINKED_DIR_RELATIVE,
  readLinkRecord,
  resolveEffectiveVault,
  type CreateVaultLinkResult,
} from "../kernel/link/link.js";
import { admitWriteTarget } from "../kernel/capture/safe.js";
import { loadResolvedTemplates } from "../kernel/templates/index.js";
import { applyLinksForNote, suggestLinksForNote } from "../kernel/link/workflow.js";
import { writeConventionUsageSection } from "../kernel/link/convention-note.js";
import { lstat, readlink, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { runLinkCheck } from "./link-check.js";

type Options = Record<string, string | boolean | string[]>;
interface Parsed {
  readonly verb: string;
  readonly positional: readonly string[];
  readonly options: Options;
}
interface Target {
  readonly vault: string;
  readonly source: "explicit" | "vault" | "bridge" | "env" | "cwd";
}

const VALUE_FLAGS = new Set(["vault", "folder", "base-content-hash", "candidate-id"]);
const BOOLEAN_FLAGS = new Set(["yes", "json", "verbose", "no-convention-note"]);
const REPEATABLE_FLAGS = new Set(["folder", "candidate-id"]);

function fail(message: string): never {
  throw new Error(`LINK_ARGS_INVALID: ${message}`);
}

function parse(argv: readonly string[]): Parsed {
  if (argv.length === 0) fail("missing command");
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) fail(`unknown flag --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (Object.hasOwn(options, name)) fail(`duplicate flag --${name}`);
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    if (REPEATABLE_FLAGS.has(name)) {
      const current = options[name];
      options[name] = [...(Array.isArray(current) ? current : []), value];
    } else {
      if (Object.hasOwn(options, name)) fail(`duplicate flag --${name}`);
      options[name] = value;
    }
  }
  return { verb: argv[0]!, positional, options };
}

function text(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function values(options: Options, name: string): readonly string[] {
  const value = options[name];
  return Array.isArray(value) ? value : [];
}

function flag(options: Options, name: string): boolean {
  return options[name] === true;
}

function only(parsed: Parsed, allowed: readonly string[], positional: number): void {
  const unexpected = Object.keys(parsed.options).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`--${unexpected[0]} is not valid for ${parsed.verb}`);
  if (parsed.positional.length !== positional) fail(`${parsed.verb} expects ${String(positional)} positional argument(s)`);
}

async function target(options: Options): Promise<Target> {
  const explicit = text(options, "vault");
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

function folder(options: Options): string | undefined {
  const folders = values(options, "folder");
  if (folders.length > 1) fail("link operations accept at most one --folder");
  const value = folders[0];
  if (value !== undefined && (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\"))) {
    fail("--folder must be one top-level vault folder");
  }
  return value;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

export function formatLinkResult(
  result: CreateVaultLinkResult,
  conventionNotePath?: string,
): string {
  const lines: string[] = ["Oh My Second Brain vault bridge ready."];
  lines.push(`  Vault:     ${result.record.vault}`);
  lines.push(`  Scope:     ${result.record.scope.join(", ") || "(none)"}`);
  if (result.linked.length > 0) lines.push(`  Linked:    ${result.linked.join(", ")}`);
  if (result.unchanged.length > 0) lines.push(`  Unchanged: ${result.unchanged.join(", ")}`);
  lines.push(`  Record:    ${result.recordPath}`);
  lines.push(
    result.gitignoreUpdated
      ? `  Gitignore: added ${LINKED_GITIGNORE_PATTERN}`
      : `  Gitignore: ${LINKED_GITIGNORE_PATTERN} already present`,
  );
  if (conventionNotePath !== undefined) {
    lines.push(`  Convention: wrote ${conventionNotePath}`);
  }
  return lines.join("\n");
}

export async function runLink(options: {
  readonly cwd: string;
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly folders: readonly string[];
  readonly conventionNote?: boolean;
}): Promise<number> {
  if (!options.vaultExplicit) {
    console.error("[oms] link requires --vault <path> (the Obsidian vault to bridge to).");
    return 1;
  }
  if (options.folders.length === 0) {
    console.error("[oms] link requires at least one --folder <name>.");
    return 1;
  }

  try {
    const result = await createVaultLink({
      cwd: options.cwd,
      vault: options.vault,
      folders: [...options.folders],
    });
    let conventionNotePath: string | undefined;
    if (options.conventionNote !== false) {
      conventionNotePath = (await writeConventionUsageSection(options.cwd, result.record.vault)).agentsPath;
    }
    console.log(formatLinkResult(result, conventionNotePath));
    return 0;
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function formatSuggestion(result: Awaited<ReturnType<typeof suggestLinksForNote>>): string {
  const lines = [
    `Link suggestions for ${result.notePath}`,
    `  Base content hash: ${result.baseContentHash}`,
    `  Candidate notes: ${String(result.candidateNotes)}`,
  ];
  for (const candidate of result.candidates) {
    lines.push(`  ${candidate.id}: ${candidate.matchedText} → ${candidate.renderedReplacement} [${candidate.targetPath}]`);
  }
  if (result.candidates.length === 0) lines.push("  No candidates.");
  return lines.join("\n");
}

function formatApply(result: Awaited<ReturnType<typeof applyLinksForNote>>): string {
  if (result.result.applied) {
    return `Applied ${String(result.resolvedIds.length)} approved link(s) to ${result.notePath}.\n  Content hash: ${result.result.contentHash}`;
  }
  return `No links applied to ${result.notePath}: ${result.result.reason}.`;
}

export async function runLinkFamilyCommand(argv: readonly string[]): Promise<void> {
  try {
    const parsed = parse(argv);
    if (parsed.verb === "check") {
      only(parsed, ["vault", "json", "verbose"], 0);
      const resolved = await target(parsed.options);
      process.exitCode = await runLinkCheck({
        vault: resolved.vault,
        json: flag(parsed.options, "json"),
        verbose: flag(parsed.options, "verbose"),
      });
      return;
    }
    if (parsed.verb === "suggest") {
      only(parsed, ["vault", "folder", "json"], 1);
      const resolved = await target(parsed.options);
      const convention = await loadResolvedTemplates(resolved.vault);
      const result = await suggestLinksForNote(
        { ...resolved, convention, notePath: parsed.positional[0]! },
        { folder: folder(parsed.options) },
      );
      print(flag(parsed.options, "json") ? result : formatSuggestion(result), flag(parsed.options, "json"));
      process.exitCode = 0;
      return;
    }
    if (parsed.verb === "apply") {
      only(parsed, ["vault", "folder", "base-content-hash", "candidate-id", "yes", "json"], 1);
      if (!flag(parsed.options, "yes")) fail("apply requires --yes");
      const baseContentHash = text(parsed.options, "base-content-hash");
      if (baseContentHash === undefined || !/^[0-9a-f]{64}$/.test(baseContentHash)) {
        fail("apply requires --base-content-hash with 64 lowercase hexadecimal characters");
      }
      const candidateIds = values(parsed.options, "candidate-id");
      if (candidateIds.length === 0) fail("apply requires at least one --candidate-id");
      if (new Set(candidateIds).size !== candidateIds.length) fail("--candidate-id values must be unique");
      const resolved = await target(parsed.options);
      const rejection = await admitWriteTarget(resolved);
      if (rejection !== undefined) throw new Error(`${rejection.code}: ${rejection.remediation}`);
      const convention = await loadResolvedTemplates(resolved.vault);
      const linkScope = { folder: folder(parsed.options) };
      const current = await suggestLinksForNote(
        { ...resolved, convention, notePath: parsed.positional[0]! },
        linkScope,
      );
      const availableIds = new Set(current.candidates.map((candidate) => candidate.id));
      if (current.baseContentHash === baseContentHash) {
        const unknownId = candidateIds.find((id) => !availableIds.has(id));
        if (unknownId !== undefined) fail(`candidate id is not present in the current proposal: ${unknownId}`);
      }
      const result = await applyLinksForNote(
        { ...resolved, convention, notePath: parsed.positional[0]! },
        { baseContentHash, candidateIds },
        linkScope,
      );
      print(flag(parsed.options, "json") ? result : formatApply(result), flag(parsed.options, "json"));
      process.exitCode = result.result.applied ? 0 : 1;
      return;
    }
    fail(`unknown link command ${parsed.verb}`);
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function bridgeStatus(cwd: string): Promise<{
  readonly state: "linked" | "not-linked";
  readonly recordPath: string;
  readonly vault?: string;
  readonly scope?: readonly string[];
  readonly links?: readonly { folder: string; path: string; state: "linked" | "missing" | "drift" }[];
}> {
  const omsDir = path.join(cwd, ".oms");
  const recordPath = path.join(omsDir, "links.yaml");
  const record = await readLinkRecord(omsDir);
  if (record === null) return { state: "not-linked", recordPath };
  const links = await Promise.all(record.scope.map(async (scope) => {
    const linkPath = path.join(cwd, LINKED_DIR_RELATIVE, path.basename(scope));
    try {
      const info = await lstat(linkPath);
      if (!info.isSymbolicLink()) return { folder: scope, path: linkPath, state: "drift" as const };
      const actual = path.resolve(path.dirname(linkPath), await readlink(linkPath));
      const expected = path.resolve(record.vault, scope);
      return { folder: scope, path: linkPath, state: actual === expected ? "linked" as const : "drift" as const };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { folder: scope, path: linkPath, state: "missing" as const };
      }
      throw error;
    }
  }));
  return { state: "linked", recordPath, vault: record.vault, scope: record.scope, links };
}

function formatBridgeStatus(status: Awaited<ReturnType<typeof bridgeStatus>>): string {
  if (status.state === "not-linked") return `No vault bridge is configured.\n  Record: ${status.recordPath}`;
  const lines = [
    "Oh My Second Brain vault bridge.",
    `  Vault:  ${status.vault}`,
    `  Scope:  ${status.scope?.join(", ") || "(none)"}`,
    `  Record: ${status.recordPath}`,
  ];
  for (const link of status.links ?? []) lines.push(`  ${link.folder}: ${link.state} (${link.path})`);
  return lines.join("\n");
}

export async function runBridgeCommand(argv: readonly string[]): Promise<void> {
  try {
    const parsed = parse(argv);
    const cwd = process.cwd();
    if (parsed.verb === "add") {
      only(parsed, ["vault", "folder", "no-convention-note"], 0);
      const vault = text(parsed.options, "vault");
      if (vault === undefined) fail("bridge add requires --vault");
      const folders = values(parsed.options, "folder");
      process.exitCode = await runLink({
        cwd,
        vault,
        vaultExplicit: true,
        folders,
        conventionNote: !flag(parsed.options, "no-convention-note"),
      });
      return;
    }
    if (parsed.verb === "status") {
      only(parsed, ["json"], 0);
      const status = await bridgeStatus(cwd);
      print(flag(parsed.options, "json") ? status : formatBridgeStatus(status), flag(parsed.options, "json"));
      process.exitCode = 0;
      return;
    }
    if (parsed.verb === "remove") {
      only(parsed, ["json", "yes"], 0);
      if (!flag(parsed.options, "yes")) fail("bridge remove requires --yes");
      const status = await bridgeStatus(cwd);
      if (status.state === "not-linked") fail("no bridge is configured in this repository");
      await rm(path.join(cwd, LINKED_DIR_RELATIVE), { recursive: true, force: true });
      await unlink(status.recordPath);
      const receipt = { removed: true, recordPath: status.recordPath, linkedDirectory: path.join(cwd, LINKED_DIR_RELATIVE) };
      print(flag(parsed.options, "json") ? receipt : `Removed vault bridge registration.\n  Record: ${receipt.recordPath}\n  Linked directory: ${receipt.linkedDirectory}`, flag(parsed.options, "json"));
      process.exitCode = 0;
      return;
    }
    fail(`unknown bridge command ${parsed.verb}`);
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
