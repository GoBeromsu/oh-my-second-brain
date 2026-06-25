import path from "node:path";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import type { RuntimeSelection } from "../install/hosts.js";

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export interface ParsedCliArgs {
  readonly command: string | undefined;
  readonly vault: string;
  readonly yes: boolean;
  readonly installClaude: boolean;
  readonly suggestFields: boolean;
  readonly runtime: RuntimeSelection | undefined;
  readonly dryRun: boolean;
  readonly executeExternal: boolean;
  readonly checkUpdate: boolean;
  readonly timeoutMs: number | undefined;
  readonly agentVault: string | undefined;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly maxPerConcept: number | undefined;
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
  let yes = false;
  let installClaude = false;
  let suggestFields = false;
  let runtime: RuntimeSelection | undefined;
  let dryRun = false;
  let executeExternal = false;
  let checkUpdate = false;
  let timeoutMs: number | undefined;
  let agentVault: string | undefined;
  let verbose = false;
  let json = false;
  let maxPerConcept: number | undefined;
  const unknownFlags: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--vault" && next) {
      vault = path.resolve(cwd, next);
      i++;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--install-claude") {
      installClaude = true;
    } else if (arg === "--suggest-fields") {
      suggestFields = true;
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
    } else if (arg === "--max" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return parsedArgsWithError(`[oms] Unsupported --max value: ${next}`);
      }
      maxPerConcept = parsed;
      i++;
    } else if (arg !== undefined) {
      unknownFlags.push(arg);
    }
  }

  return {
    command,
    vault,
    yes,
    installClaude,
    suggestFields,
    runtime,
    dryRun,
    executeExternal,
    checkUpdate,
    timeoutMs,
    agentVault,
    verbose,
    json,
    maxPerConcept,
    unknownFlags,
    error: undefined,
  };

  function parsedArgsWithError(message: string): ParsedCliArgs {
    return {
      command,
      vault,
      yes,
      installClaude,
      suggestFields,
      runtime,
      dryRun,
      executeExternal,
      checkUpdate,
      timeoutMs,
      agentVault,
      verbose,
      json,
      maxPerConcept,
      unknownFlags,
      error: new CliArgumentError(message),
    };
  }
}
