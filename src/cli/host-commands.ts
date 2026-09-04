/**
 * Host-lifecycle CLI commands: `install`, `uninstall`, `update`, and
 * `reconcile`.
 *
 * These four are the only commands that mutate host adapter state and its
 * stamp-only vault pointer, so they live together and away from the router,
 * which owns dispatch alone.
 */

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
import { formatUpdateResult, runUpdate } from "../kernel/update/update.js";
import { installClaude, isOmsHookEntry, uninstallClaude } from "../vendors/claude/claude.js";
import { installCodex, isCodexOmsRegistration, uninstallCodex } from "../vendors/codex/codex.js";
import { installHermes, isHermesOmsRegistration, uninstallHermes } from "../vendors/hermes/hermes.js";
import { readCurrentPackageVersion } from "./update-notice.js";

export { isCodexOmsRegistration, isHermesOmsRegistration, isOmsHookEntry };

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
  readonly checkUpdate: boolean;
  readonly timeoutMs: number | undefined;
  readonly unknownFlags: readonly string[];
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
          ? `Repair: oms install --runtime ${result.runtime} --vault ${vault} --yes`
          : `Repair: oms uninstall --runtime ${result.runtime} --yes`,
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

/** `oms install` / `oms uninstall`. Returns the process exit code. */
export async function runInstallOrUninstall(
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

/** `oms update`. Returns the process exit code. */
export async function runUpdateCommand(context: HostCommandContext): Promise<number> {
  if (context.unknownFlags.length > 0) {
    console.error(`[oms] Unsupported update option: ${context.unknownFlags.join(", ")}`);
    return 1;
  }

  let pointer: HostVaultPointerReceipt;
  let stampedVault: string;
  try {
    pointer = await (context.vaultExplicit
      ? readHostVaultPointerForRepair({ dryRun: context.dryRun })
      : readHostVaultPointer({ dryRun: context.dryRun }));
    if (context.vaultExplicit) {
      stampedVault = await canonicalHostVault(context.vault);
      pointer = await writeHostVaultPointer(stampedVault, pointer.pointer?.signature, { dryRun: context.dryRun });
    } else if (pointer.pointer !== undefined) {
      stampedVault = pointer.pointer.vault;
    } else {
      console.error("[oms] No OMS host vault pointer exists; run `oms install --vault <absolute-vault>` first.");
      return 1;
    }
  } catch (error) {
    console.error(`[oms] ${error instanceof HostVaultPointerError ? error.message : String(error)}`);
    return 1;
  }

  const result = await runUpdate({
    currentVersion: await readCurrentPackageVersion(),
    latestVersion: process.env["OMS_UPDATE_LATEST_VERSION"],
    runtime: context.runtime ?? "all",
    vault: stampedVault,
    check: context.checkUpdate,
    dryRun: context.dryRun,
    yes: context.yes,
    interactive: process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1",
    executeExternal: context.executeExternal,
    timeoutMs: context.timeoutMs,
  });
  console.log(formatUpdateResult(result));
  return result.success ? 0 : 1;
}

/** `oms reconcile` — re-stamps every selected host from the current pointer. */
export async function runReconcile(context: HostCommandContext): Promise<number> {
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
    console.error("[oms] No OMS host vault pointer exists; run `oms install --vault <absolute-vault>` first.");
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
