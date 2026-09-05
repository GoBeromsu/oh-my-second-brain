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
  readonly help: boolean;
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly yes: boolean;
  readonly approvedDigest?: string;
  readonly templateFolders: readonly string[];
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
  readonly modelsDescriptorPath: string | undefined;
  readonly modelsNoDefault: boolean;
  readonly modelsDefault: boolean;
  readonly unknownFlags: readonly string[];
  readonly error: CliArgumentError | undefined;
}

export function isRuntimeSelection(value: string): value is RuntimeSelection {
  if (value === "auto" || value === "all") return true;
  return harnessSurfaceRegistry.hosts.some((host) => host.runtime === value);
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCliArgs {
  const firstArg = argv[0];
  const command = firstArg === "--help" || firstArg === "-h" ? undefined : firstArg;
  let help = firstArg === "--help" || firstArg === "-h";
  let vault = cwd;
  let vaultExplicit = false;
  let yes = false;
  let approvedDigest: string | undefined;
  const templateFolders: string[] = [];
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
  let modelsDescriptorPath: string | undefined;
  let modelsNoDefault = false;
  let modelsDefault = false;
  const unknownFlags: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (command === "template") {
      if (arg === "--help" || arg === "-h") help = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--vault" && next) {
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
      if (!templateFolders.includes(next)) templateFolders.push(next);
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
    } else if (arg === "--models-descriptor") {
      if (next === undefined || next === "" || next.startsWith("-")) {
        return parsedArgsWithError(
          "[oms] Missing value for --models-descriptor. Choose one of --models-default, --models-descriptor <path>, or --models-no-default.",
        );
      }
      modelsDescriptorPath = path.resolve(cwd, next);
      i++;
    } else if (arg === "--models-no-default") {
      modelsNoDefault = true;
    } else if (arg === "--models-default") {
      modelsDefault = true;
    } else if (arg === "--embedding-descriptor") {
      unknownFlags.push(arg);
      if (next !== undefined && !next.startsWith("--")) i++;
    } else if (arg === "--embedding-default" || arg === "--embedding-no-default") {
      unknownFlags.push(arg);
    } else if (arg !== undefined) {
      unknownFlags.push(arg);
    }
  }

  if (command === "setup") {
    const modelChoices = [
      modelsDescriptorPath !== undefined ? "--models-descriptor" : undefined,
      modelsDefault ? "--models-default" : undefined,
      modelsNoDefault ? "--models-no-default" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (modelChoices.length > 1) {
      return parsedArgsWithError(
        `[oms] Mutually exclusive setup model options: ${modelChoices.join(" and ")}. Choose one of --models-default, --models-descriptor <path>, or --models-no-default.`,
      );
    }
  }

  return {
    command,
    help,
    vault,
    vaultExplicit,
    yes,
    approvedDigest,
    templateFolders,
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
    modelsDescriptorPath,
    modelsNoDefault,
    modelsDefault,
    unknownFlags,
    error: undefined,
  };

  function parsedArgsWithError(message: string): ParsedCliArgs {
    return {
      command,
      help,
      vault,
      vaultExplicit,
      yes,
      approvedDigest,
      templateFolders,
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
      modelsDescriptorPath,
      modelsNoDefault,
      modelsDefault,
      unknownFlags,
      error: new CliArgumentError(message),
    };
  }
}
