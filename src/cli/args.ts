import path from "node:path";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import type { RuntimeSelection } from "../kernel/install/hosts.js";

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export interface ParsedCliArgs {
  readonly command: string | undefined;
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly yes: boolean;
  readonly approvedDigest?: string;
  readonly templateFolder?: string;
  readonly maxPerTemplate?: number;
  /** linkify: opt into rewriting notes in place (still requires `--yes`). */
  readonly apply: boolean;
  readonly installClaude: boolean;
  readonly runtime: RuntimeSelection | undefined;
  readonly dryRun: boolean;
  readonly executeExternal: boolean;
  readonly checkUpdate: boolean;
  readonly timeoutMs: number | undefined;
  readonly agentVault: string | undefined;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly folders: readonly string[];
  readonly conventionNote: boolean;
  readonly embeddingDescriptorPath: string | undefined;
  readonly embeddingNoDefault: boolean;
  /** setup: install the pinned default embedding model. */
  readonly embeddingDefault: boolean;
  readonly unknownFlags: readonly string[];
  readonly error: CliArgumentError | undefined;
}

export function isRuntimeSelection(value: string): value is RuntimeSelection {
  if (value === "auto" || value === "all") return true;
  return harnessSurfaceRegistry.hosts.some((host) => host.runtime === value);
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCliArgs {
  const command = argv[0];
  let vault = cwd;
  let vaultExplicit = false;
  let yes = false;
  let approvedDigest: string | undefined;
  let templateFolder: string | undefined;
  let maxPerTemplate: number | undefined;
  let apply = false;
  let installClaude = false;
  let runtime: RuntimeSelection | undefined;
  let dryRun = false;
  let executeExternal = false;
  let checkUpdate = false;
  let timeoutMs: number | undefined;
  let agentVault: string | undefined;
  let verbose = false;
  let json = false;
  const folders: string[] = [];
  let conventionNote = true;
  let embeddingDescriptorPath: string | undefined;
  let embeddingNoDefault = false;
  let embeddingDefault = false;
  const unknownFlags: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--vault" && next) {
      vault = path.resolve(cwd, next);
      vaultExplicit = true;
      i++;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--approved-digest") {
      if (next === undefined || next.startsWith("--")) {
        return parsedArgsWithError("[oms] Missing value for --approved-digest.");
      }
      approvedDigest = next;
      i++;
    } else if (arg === "--template-folder") {
      if (next === undefined || next.startsWith("--")) {
        return parsedArgsWithError("[oms] Missing value for --template-folder.");
      }
      templateFolder = next;
      i++;
    } else if (arg === "--max-per-template") {
      const parsed = Number.parseInt(next ?? "", 10);
      if (next === undefined || !Number.isFinite(parsed) || parsed <= 0 || `${parsed}` !== next) {
        return parsedArgsWithError(`[oms] --max-per-template must be a positive integer.`);
      }
      maxPerTemplate = parsed;
      i++;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--install-claude") {
      installClaude = true;
    } else if (arg === "--check") {
      checkUpdate = true;
    } else if (arg === "--timeout-ms" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return parsedArgsWithError(`[oms] Unsupported timeout: ${next}`);
      }
      timeoutMs = parsed;
      i++;
    } else if (arg === "--runtime" && next) {
      if (isRuntimeSelection(next)) {
        runtime = next;
      } else {
        return parsedArgsWithError(`[oms] Unsupported runtime: ${next}`);
      }
      i++;
    } else if (arg === "--agent-vault" && next) {
      agentVault = path.resolve(cwd, next);
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--execute") {
      executeExternal = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--folder" && next) {
      folders.push(next);
      i++;
    } else if (arg === "--no-convention-note") {
      conventionNote = false;
    } else if (arg === "--embedding-descriptor" && next) {
      embeddingDescriptorPath = path.resolve(cwd, next);
      i++;
    } else if (arg === "--embedding-no-default") {
      embeddingNoDefault = true;
    } else if (arg === "--embedding-default") {
      embeddingDefault = true;
    } else if (arg !== undefined) {
      unknownFlags.push(arg);
    }
  }

  return {
    command,
    vault,
    vaultExplicit,
    yes,
    approvedDigest,
    templateFolder,
    maxPerTemplate,
    apply,
    installClaude,
    runtime,
    dryRun,
    executeExternal,
    checkUpdate,
    timeoutMs,
    agentVault,
    verbose,
    json,
    folders,
    conventionNote,
    embeddingDescriptorPath,
    embeddingNoDefault,
    embeddingDefault,
    unknownFlags,
    error: undefined,
  };

  function parsedArgsWithError(message: string): ParsedCliArgs {
    return {
      command,
      vault,
      vaultExplicit,
      yes,
      approvedDigest,
      templateFolder,
      maxPerTemplate,
      apply,
      installClaude,
        runtime,
      dryRun,
      executeExternal,
      checkUpdate,
      timeoutMs,
      agentVault,
      verbose,
      json,
        folders,
      conventionNote,
      embeddingDescriptorPath,
      embeddingNoDefault,
      embeddingDefault,
      unknownFlags,
      error: new CliArgumentError(message),
    };
  }
}
