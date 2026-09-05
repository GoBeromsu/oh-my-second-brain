/**
 * Host-lifecycle CLI commands: `host install`, `host remove`, `host sync`, and
 * `host status`.
 *
 * Mutating host commands own adapter state and the stamp-only vault pointer.
 * Package lifecycle remains separate in the package command family.
 */

import path from "node:path";

import {
  formatHostOperationResults,
  formatHostOperationResultsJson,
  runHostOperation,
  hostSurfaceForRuntime,
  type HostOperationResult,
  type HostRuntime,
  type RuntimeSelection,
} from "../kernel/install/hosts.js";
import {
  HostVaultPointerError,
  canonicalHostVault,
  deleteHostVaultPointer,
  readHostVaultPointer,
  readHostVaultPointerForRepair,
  writeHostVaultPointer,
  type HostVaultPointerReceipt,
} from "../kernel/install/pointer.js";
import { inspectInstalledAssets } from "../kernel/install/asset-health.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { resolveBundledAssetPaths } from "../kernel/runtime/assets.js";
import { installClaude, isOmsHookEntry, uninstallClaude } from "../vendors/claude/claude.js";
import { installCodex, isCodexOmsRegistration, uninstallCodex } from "../vendors/codex/codex.js";
import { installHermes, isHermesOmsRegistration, uninstallHermes } from "../vendors/hermes/hermes.js";

export { isCodexOmsRegistration, isHermesOmsRegistration, isOmsHookEntry };
export { runModelCommand } from "./model-command.js";

/** Everything the host commands need from the parsed argv, plus the adapter root. */
export interface HostCommandContext {
  readonly vault: string;
  readonly vaultExplicit: boolean;
  readonly runtime: RuntimeSelection | undefined;
  readonly agentVault: string | undefined;
  readonly dryRun: boolean;
  readonly executeExternal: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly adapterRoot: string;
}

async function runVendorHostOperation(
  options: Parameters<typeof runHostOperation>[0],
  runtime: HostRuntime,
): Promise<HostOperationResult> {
  const host = hostSurfaceForRuntime(runtime);
  if (options.action === "install") {
    if (runtime === "claude") return installClaude(options, host);
    if (runtime === "codex") return installCodex(options, host);
    return installHermes(options, host);
  }
  if (runtime === "claude") return uninstallClaude(options);
  if (runtime === "codex") return uninstallCodex(options);
  return uninstallHermes(options);
}

function hasFailedHostOperation(results: readonly HostOperationResult[]): boolean {
  return results.some((result) => result.messages.some((message) => message.startsWith("FAILED:")));
}

function appendRepairCommands(
  results: HostOperationResult[],
  action: "install" | "uninstall",
  vault?: string,
): void {
  for (const result of results) {
    if (result.messages.some((message) => message.startsWith("FAILED:"))) {
      result.messages.push(
        action === "install" && vault !== undefined
          ? `Repair: oms host install --runtime ${result.runtime} --vault ${vault} --yes`
          : `Repair: oms host remove --runtime ${result.runtime} --yes`,
      );
    }
  }
}

async function runStampedInstallOrUninstall(
  action: "install" | "uninstall",
  context: HostCommandContext,
): Promise<{ readonly results: HostOperationResult[]; readonly failed: boolean; readonly pointer: HostVaultPointerReceipt }> {
  const pointer = await readHostVaultPointerForRepair({ dryRun: context.dryRun });
  const requestedVault = action === "install"
    ? await canonicalHostVault(context.vault)
    : pointer.pointer?.vault ?? context.vault;

  const results = await runHostOperation(
    {
      action,
      runtime: context.runtime ?? (action === "install" ? "auto" : "all"),
      vault: requestedVault,
      agentVault: context.agentVault,
      dryRun: context.dryRun,
      executeExternal: context.executeExternal,
      yes: context.yes,
      adapterRoot: context.adapterRoot,
    },
    runVendorHostOperation,
  );
  const failed = hasFailedHostOperation(results);
  appendRepairCommands(results, action, requestedVault);
  if (failed) {
    return { results, failed, pointer };
  }
  const receipt = action === "install"
    ? await writeHostVaultPointer(requestedVault, pointer.pointer?.signature, { dryRun: context.dryRun })
    : await deleteHostVaultPointer(pointer.pointer?.signature, { dryRun: context.dryRun });
  return { results, failed, pointer: receipt };
}

function formatResultsWithPointer(
  results: readonly HostOperationResult[],
  pointer: HostVaultPointerReceipt,
  json: boolean,
  dryRun: boolean,
): string {
  if (json) {
    const formatted = JSON.parse(formatHostOperationResultsJson(results, dryRun)) as Record<string, unknown>;
    return JSON.stringify({ ...formatted, pointer }, null, 2);
  }
  return `${formatHostOperationResults(results, dryRun)}\n\npointer: ${pointer.operation} ${pointer.changed ? "changed" : "unchanged"}${pointer.dryRun ? " (dry-run)" : ""} ${pointer.path}`;
}

/** Runs `oms host install` or `oms host remove`. */
async function runHostInstallOrRemove(
  action: "install" | "uninstall",
  context: HostCommandContext,
): Promise<number> {
  if (action === "uninstall" && !context.yes && !context.dryRun && process.env["OMS_NON_INTERACTIVE"] !== "1") {
    console.error("[oms] Refusing uninstall without --yes or --dry-run.");
    return 1;
  }

  let operation: { readonly results: HostOperationResult[]; readonly failed: boolean; readonly pointer: HostVaultPointerReceipt };
  try {
    operation = await runStampedInstallOrUninstall(action, context);
  } catch (error) {
    const message = error instanceof HostVaultPointerError ? error.message : String(error);
    console.error(`[oms] ${message}`);
    return 1;
  }
  console.log(
    formatResultsWithPointer(operation.results, operation.pointer, context.json, context.dryRun),
  );

  return operation.failed ? 1 : 0;
}

/** `oms host sync` re-stamps every selected host from the current pointer. */
async function runHostSync(context: HostCommandContext): Promise<number> {
  let pointer: HostVaultPointerReceipt;
  try {
    pointer = await (context.vaultExplicit
      ? readHostVaultPointerForRepair({ dryRun: context.dryRun })
      : readHostVaultPointer({ dryRun: context.dryRun }));
    if (context.vaultExplicit) {
      const explicitVault = await canonicalHostVault(context.vault);
      pointer = await writeHostVaultPointer(explicitVault, pointer.pointer?.signature, { dryRun: context.dryRun });
    }
  } catch (error) {
    console.error(`[oms] ${error instanceof HostVaultPointerError ? error.message : String(error)}`);
    return 1;
  }
  if (pointer.pointer === undefined) {
    console.error("[oms] No OMS host vault pointer exists; run `oms host install --vault <absolute-vault>` first.");
    return 1;
  }

  const results = await runHostOperation(
    {
      action: "install",
      runtime: context.runtime ?? "all",
      vault: pointer.pointer.vault,
      dryRun: context.dryRun,
      executeExternal: context.executeExternal,
      yes: true,
      adapterRoot: context.adapterRoot,
    },
    runVendorHostOperation,
  );
  appendRepairCommands(results, "install", pointer.pointer.vault);
  console.log(formatResultsWithPointer(results, pointer, context.json, context.dryRun));
  return hasFailedHostOperation(results) ? 1 : 0;
}

type RawHostOptions = Record<string, string | boolean>;
const HOST_VALUE_FLAGS = new Set(["vault", "runtime", "agent-vault"]);
const HOST_BOOLEAN_FLAGS = new Set(["dry-run", "execute", "yes", "json", "help"]);

function hostArgumentError(message: string): never {
  throw new Error(`HOST_ARGS_INVALID: ${message}`);
}

function parseHostArgs(argv: readonly string[]): { readonly verb: string; readonly options: RawHostOptions } {
  const verb = argv[0];
  if (verb === undefined || verb.startsWith("-")) hostArgumentError("missing host verb");
  const options: RawHostOptions = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) hostArgumentError(`unexpected positional argument ${token}`);
    const name = token.slice(2);
    if (!HOST_VALUE_FLAGS.has(name) && !HOST_BOOLEAN_FLAGS.has(name)) hostArgumentError(`unknown flag --${name}`);
    if (Object.hasOwn(options, name)) hostArgumentError(`duplicate flag --${name}`);
    if (HOST_BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) hostArgumentError(`--${name} requires a value`);
    options[name] = value;
  }
  return { verb, options };
}

function hostText(options: RawHostOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function hostFlag(options: RawHostOptions, name: string): boolean {
  return options[name] === true;
}

function hostOnly(verb: string, options: RawHostOptions, allowed: readonly string[]): void {
  const unsupported = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unsupported.length > 0) hostArgumentError(`--${unsupported[0]} is not valid for ${verb}`);
}

async function rawHostContext(options: RawHostOptions, mutation: boolean): Promise<HostCommandContext> {
  const runtimeRaw = hostText(options, "runtime");
  const runtime = runtimeRaw === undefined
    ? undefined
    : runtimeRaw === "auto" || runtimeRaw === "all" || runtimeRaw === "claude" || runtimeRaw === "codex" || runtimeRaw === "hermes"
      ? runtimeRaw
      : hostArgumentError(`unsupported runtime ${runtimeRaw}`);
  const explicitVault = hostText(options, "vault");
  const target = explicitVault === undefined
    ? await resolveEffectiveVault(process.cwd(), process.env)
    : { vault: path.resolve(explicitVault), source: "explicit" as const };
  if (mutation && target.source === "cwd") {
    hostArgumentError("host mutations require --vault or an existing verified vault/bridge/env target");
  }
  return {
    vault: target.vault,
    vaultExplicit: explicitVault !== undefined,
    runtime,
    agentVault: hostText(options, "agent-vault"),
    dryRun: hostFlag(options, "dry-run"),
    executeExternal: hostFlag(options, "execute"),
    yes: hostFlag(options, "yes"),
    json: hostFlag(options, "json"),
    adapterRoot: resolveBundledAssetPaths().packageRoot,
  };
}

export function hostUsage(): string {
  return "Usage: oms host install|remove|sync|status [--runtime claude|codex|hermes|auto|all] [--vault <path>]";
}

/** Strict raw handler for the public `oms host` family. */
export async function runHostCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      console.log(hostUsage());
      return;
    }
    const parsed = parseHostArgs(argv);
    if (hostFlag(parsed.options, "help")) {
      hostOnly(parsed.verb, parsed.options, ["help"]);
      console.log(hostUsage());
      return;
    }
    let exitCode: number;
    if (parsed.verb === "install") {
      hostOnly(parsed.verb, parsed.options, ["vault", "runtime", "agent-vault", "dry-run", "execute", "yes", "json"]);
      exitCode = await runHostInstallOrRemove("install", await rawHostContext(parsed.options, true));
    } else if (parsed.verb === "remove") {
      hostOnly(parsed.verb, parsed.options, ["runtime", "dry-run", "execute", "yes", "json"]);
      exitCode = await runHostInstallOrRemove("uninstall", await rawHostContext(parsed.options, false));
    } else if (parsed.verb === "sync") {
      hostOnly(parsed.verb, parsed.options, ["vault", "runtime", "dry-run", "execute", "yes", "json"]);
      exitCode = await runHostSync(await rawHostContext(parsed.options, hostText(parsed.options, "vault") !== undefined));
    } else if (parsed.verb === "status") {
      hostOnly(parsed.verb, parsed.options, ["vault", "json"]);
      const context = await rawHostContext(parsed.options, false);
      const pointer = await readHostVaultPointer();
      const discovered = await import("./host-probe.js").then(module => module.discoverHostInstallAssets());
      const inspection = await inspectInstalledAssets({ ...discovered, vault: context.vault });
      console.log(JSON.stringify({ ...inspection, pointer }, null, 2));
      exitCode = inspection.status === "ok" ? 0 : 1;
    } else {
      hostArgumentError(`unknown or retired host verb ${parsed.verb}`);
    }
    process.exitCode = exitCode;
  } catch (error: unknown) {
    process.exitCode = 1;
    console.log(JSON.stringify({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "HOST_COMMAND_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    }, null, 2));
  }
}
