import path from "node:path";
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
  readonly approvalToken?: string;
  readonly approvedDigest?: string;
  readonly installClaude: boolean;
  readonly runtime: RuntimeSelection | undefined;
  readonly agentVault: string | undefined;
  readonly dryRun: boolean;
  readonly executeExternal: boolean;
  readonly modelsDescriptorPath: string | undefined;
  readonly modelsNoDefault: boolean;
  readonly modelsDefault: boolean;
  readonly unknownFlags: readonly string[];
  readonly error: CliArgumentError | undefined;
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCliArgs {
  const firstArg = argv[0];
  const command = firstArg === "--help" || firstArg === "-h" ? undefined : firstArg;
  let help =
    firstArg === "--help"
    || firstArg === "-h"
    || argv.slice(1).some((arg) => arg === "--help" || arg === "-h");
  let vault = cwd;
  let vaultExplicit = false;
  let yes = false;
  let approvalToken: string | undefined;
  let approvedDigest: string | undefined;
  let installClaude = false;
  let runtime: RuntimeSelection | undefined;
  let agentVault: string | undefined;
  let dryRun = false;
  let executeExternal = false;
  let modelsDescriptorPath: string | undefined;
  let modelsNoDefault = false;
  let modelsDefault = false;
  const unknownFlags: string[] = [];

  // Every public family except setup owns its argv contract. The top-level
  // parser only recognizes the common help route and otherwise
  // leaves those arguments untouched for the family handler.
  if (command !== "setup") return result();

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--vault") {
      if (vaultExplicit) return failure("[oms] Duplicate option: --vault.");
      if (next === undefined || next === "" || next.startsWith("--")) return failure("[oms] Missing value for --vault.");
      vault = path.resolve(cwd, next);
      vaultExplicit = true;
      index += 1;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--approval-token") {
      if (approvalToken !== undefined) return failure("[oms] Duplicate option: --approval-token.");
      if (next === undefined || next === "" || next.startsWith("--")) {
        return failure("[oms] Missing value for --approval-token.");
      }
      approvalToken = next;
      index += 1;
    } else if (arg === "--approved-digest") {
      if (approvedDigest !== undefined) return failure("[oms] Duplicate option: --approved-digest.");
      if (next === undefined || next === "" || next.startsWith("--")) {
        return failure("[oms] Missing value for --approved-digest.");
      }
      approvedDigest = next;
      index += 1;
    } else if (arg === "--template-folder") {
      // Setup publishes no contract and registers no template, so selecting a
      // folder here would silently do nothing. Refuse instead of ignoring it.
      return failure("[oms] --template-folder was removed: setup publishes no contract, and templates are registered by publishing one with `oms template publish`.");
    } else if (arg === "--install-claude") {
      installClaude = true;
    } else if (arg === "--runtime") {
      if (next === undefined || next.startsWith("--")) return failure("[oms] Missing value for --runtime.");
      if (!["auto", "all", "claude", "codex", "hermes"].includes(next)) {
        return failure(`[oms] Unsupported runtime: ${next}`);
      }
      runtime = next as RuntimeSelection;
      index += 1;
    } else if (arg === "--agent-vault") {
      if (next === undefined || next.startsWith("--")) return failure("[oms] Missing value for --agent-vault.");
      agentVault = path.resolve(cwd, next);
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--execute") {
      executeExternal = true;
    } else if (arg === "--models-descriptor") {
      if (next === undefined || next === "" || next.startsWith("-")) {
        return failure(
          "[oms] Missing value for --models-descriptor. Choose one of --models-default, --models-descriptor <path>, or --models-no-default.",
        );
      }
      modelsDescriptorPath = path.resolve(cwd, next);
      index += 1;
    } else if (arg === "--models-no-default") {
      modelsNoDefault = true;
    } else if (arg === "--models-default") {
      modelsDefault = true;
    } else if (arg === "--embedding-descriptor") {
      unknownFlags.push(arg);
      if (next !== undefined && !next.startsWith("--")) index += 1;
    } else if (arg !== undefined) {
      unknownFlags.push(arg);
    }
  }

  const modelChoices = [
    modelsDescriptorPath !== undefined ? "--models-descriptor" : undefined,
    modelsDefault ? "--models-default" : undefined,
    modelsNoDefault ? "--models-no-default" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (modelChoices.length > 1) {
    return failure(
      `[oms] Mutually exclusive setup model options: ${modelChoices.join(" and ")}. Choose one of --models-default, --models-descriptor <path>, or --models-no-default.`,
    );
  }

  return result();

  function result(error?: CliArgumentError): ParsedCliArgs {
    return {
      command,
      help,
      vault,
      vaultExplicit,
      yes,
      approvalToken,
      approvedDigest,
      installClaude,
      runtime,
      agentVault,
      dryRun,
      executeExternal,
      modelsDescriptorPath,
      modelsNoDefault,
      modelsDefault,
      unknownFlags: command === "setup"
        ? unknownFlags
        : argv.slice(1).filter((arg) => arg !== "--help" && arg !== "-h"),
      error,
    };
  }

  function failure(message: string): ParsedCliArgs {
    return result(new CliArgumentError(message));
  }
}
