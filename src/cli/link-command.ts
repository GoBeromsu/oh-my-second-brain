import { randomUUID } from "node:crypto";
import {
  LINKED_GITIGNORE_PATTERN,
  LINKED_DIR_RELATIVE,
  prepareVaultLink,
  commitVaultLink,
  removeVaultLink,
  resolveEffectiveVault,
  type VaultLinkResult,
  type VaultSource,
} from "../kernel/link/link.js";
import { checkLinksForNote, suggestLinksForNote } from "../kernel/link/workflow.js";
import { writeConventionUsageSection } from "../kernel/link/convention-note.js";
import path from "node:path";
import { lstat, readlink } from "node:fs/promises";
import { readConnectionRegistry } from "../kernel/install/connection-registry.js";
import { readProjectConnection } from "../kernel/install/project-connection.js";
import { runLinkCheck } from "./link-check.js";

type Options = Record<string, string | boolean | string[]>;
interface Parsed {
  readonly verb: string;
  readonly positional: readonly string[];
  readonly options: Options;
}
interface Target {
  readonly vault: string;
  readonly source: VaultSource;
}

const VALUE_FLAGS = new Set(["vault", "folder"]);
const BOOLEAN_FLAGS = new Set(["yes", "json", "verbose", "no-convention-note"]);
const REPEATABLE_FLAGS = new Set(["folder"]);

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
  const resolved = await resolveEffectiveVault(process.cwd(), process.env, explicit === undefined ? {} : { explicitVault: explicit });
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

function stageFailure(label: string, stage: { readonly state: string; readonly code?: string; readonly reason?: string }): string | undefined {
  if (stage.code === undefined && stage.reason === undefined) return undefined;
  if (stage.state !== "blocked" && stage.state !== "pending") return undefined;
  const detail = [stage.code, stage.reason].filter(value => value !== undefined).join(": ");
  return `  ${label}: ${detail}`;
}

export function formatLinkResult(result: VaultLinkResult, conventionNotePath?: string): string {
  if (result.partial || result.projection === null) {
    const lines = [
      "Oh My Second Brain vault bridge is partial.",
      `  Vault publication: ${result.connection.vault.state}`,
      `  Global registration: ${result.connection.global.state}`,
      `  Project reference: ${result.connection.project.state}`,
      `  Reservation: ${result.connection.reservation?.connectionId ?? "(not reserved)"}`,
    ];
    for (const line of [
      stageFailure("Vault publication", result.connection.vault),
      stageFailure("Global registration", result.connection.global),
      stageFailure("Project reference", result.connection.project),
    ]) {
      if (line !== undefined) lines.push(line);
    }
    if (result.connection.reservationDiagnostic !== null) {
      lines.push(`  Reservation diagnostic: ${result.connection.reservationDiagnostic.code}: ${result.connection.reservationDiagnostic.message}`);
    }
    if (result.projectionDiagnostic !== null) lines.push(`  Projection: ${result.projectionDiagnostic.code}: ${result.projectionDiagnostic.message}`);
    return lines.join("\n");
  }
  const lines = [
    "Oh My Second Brain vault bridge ready.",
    `  Connection: ${result.connection.reservation?.connectionId ?? "(unreserved)"}`,
    `  Record:     ${result.projection.recordPath}`,
  ];
  if (result.projection.linked.length > 0) lines.push(`  Linked:     ${result.projection.linked.join(", ")}`);
  if (result.projection.unchanged.length > 0) lines.push(`  Unchanged:  ${result.projection.unchanged.join(", ")}`);
  lines.push(result.projection.gitignoreUpdated ? `  Gitignore:  added ${LINKED_GITIGNORE_PATTERN}` : `  Gitignore:  ${LINKED_GITIGNORE_PATTERN} already present`);
  if (conventionNotePath !== undefined) lines.push(`  Convention: wrote ${conventionNotePath}`);
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
    const prepared = await prepareVaultLink({
      cwd: options.cwd,
      vault: options.vault,
      folders: options.folders,
      operationId: randomUUID(),
      publicationTransactionId: randomUUID(),
      select: false,
    });
    const result = await commitVaultLink(prepared);
    if (result.partial || result.projection === null) {
      console.error(formatLinkResult(result));
      return 1;
    }
    const conventionNotePath = options.conventionNote === false ? undefined : (await writeConventionUsageSection(options.cwd, options.vault)).agentsPath;
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

function formatLinkCheck(report: Awaited<ReturnType<typeof checkLinksForNote>>): string {
  const lines = [`Checked ${String(report.links.length)} wikilink(s) in ${report.notePath}.`];
  for (const link of report.links) {
    lines.push(`  ${link.state}: ${link.target}${link.matches.length === 0 ? "" : ` → ${link.matches.join(", ")}`}`);
  }
  if (report.links.length === 0) lines.push("  No wikilinks.");
  return lines.join("\n");
}

export async function runLinkFamilyCommand(argv: readonly string[]): Promise<void> {
  try {
    const parsed = parse(argv);
    if (parsed.verb === "check") {
      // Zero positionals keeps the existing vault-wide link report; one note path
      // checks exactly that saved note's wikilinks.
      if (parsed.positional.length === 0) {
        only(parsed, ["vault", "json", "verbose"], 0);
        const resolved = await target(parsed.options);
        process.exitCode = await runLinkCheck({
          vault: resolved.vault,
          json: flag(parsed.options, "json"),
          verbose: flag(parsed.options, "verbose"),
        });
        return;
      }
      only(parsed, ["vault", "folder", "json"], 1);
      const resolved = await target(parsed.options);
      const report = await checkLinksForNote(
        { ...resolved, notePath: parsed.positional[0]! },
        { folder: folder(parsed.options) },
      );
      print(flag(parsed.options, "json") ? report : formatLinkCheck(report), flag(parsed.options, "json"));
      process.exitCode = report.unresolved.length === 0 && report.ambiguous.length === 0 ? 0 : 1;
      return;
    }
    if (parsed.verb === "suggest") {
      only(parsed, ["vault", "folder", "json"], 1);
      const resolved = await target(parsed.options);
      const result = await suggestLinksForNote(
        { ...resolved, notePath: parsed.positional[0]! },
        { folder: folder(parsed.options) },
      );
      print(flag(parsed.options, "json") ? result : formatSuggestion(result), flag(parsed.options, "json"));
      process.exitCode = 0;
      return;
    }
    fail(`unknown link command ${parsed.verb}`);
  } catch (error) {
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function bridgeStatus(cwd: string): Promise<{
  readonly state: "linked" | "not-linked" | "legacy-readonly";
  readonly recordPath: string;
  readonly connectionId?: string;
  readonly portableVaultId?: string;
  readonly vault?: string;
  readonly scope?: readonly string[];
  readonly links?: readonly { folder: string; path: string; state: "linked" | "missing" | "drift" }[];
}> {
  const recordPath = path.join(cwd, ".oms", "links.yaml");
  const record = await readProjectConnection(cwd);
  if (record.state === "missing") return { state: "not-linked", recordPath };
  const scope = record.reference?.scope ?? record.pointer?.scope ?? [];
  const vault = record.state === "v1" ? record.pointer?.vault : undefined;
  const registered = record.reference === undefined ? undefined : (await readConnectionRegistry()).registry?.connections.find(entry => entry.connectionId === record.reference?.connectionId && entry.portableVaultId === record.reference.portableVaultId);
  const expectedVault = vault ?? registered?.localVaultPath;
  const links = await Promise.all(scope.map(async (entry) => {
    const linkPath = path.join(cwd, LINKED_DIR_RELATIVE, path.basename(entry));
    try {
      const info = await lstat(linkPath);
      if (!info.isSymbolicLink()) return { folder: entry, path: linkPath, state: "drift" as const };
      const actual = path.resolve(path.dirname(linkPath), await readlink(linkPath));
      const expected = expectedVault === undefined ? undefined : path.resolve(expectedVault, entry);
      return { folder: entry, path: linkPath, state: expected !== undefined && actual === expected ? "linked" as const : "drift" as const };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { folder: entry, path: linkPath, state: "missing" as const };
      }
      throw error;
    }
  }));
  return {
    state: record.state === "v1" ? "legacy-readonly" : "linked",
    recordPath,
    ...(record.reference === undefined ? {} : { connectionId: record.reference.connectionId, portableVaultId: record.reference.portableVaultId }),
    ...(expectedVault === undefined ? {} : { vault: expectedVault }),
    scope,
    links,
  };
}

function formatBridgeStatus(status: Awaited<ReturnType<typeof bridgeStatus>>): string {
  if (status.state === "not-linked") return `No vault bridge is configured.\n  Record: ${status.recordPath}`;
  const lines = [
    "Oh My Second Brain vault bridge.",
    ...(status.connectionId === undefined ? [] : [`  Connection: ${status.connectionId}`]),
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
      const receipt = await removeVaultLink(cwd);
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
