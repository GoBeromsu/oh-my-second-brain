/**
 * Host-lifecycle CLI commands: `install`, `uninstall`, `update`, and the
 * internal `update-reconcile`.
 *
 * These four are the only commands that mutate host adapter state (and, for
 * install, the global vault record), so they live together and away from the
 * router, which owns dispatch alone.
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
import { formatUpdateResult, runUpdate } from "../kernel/update/update.js";
import { installClaude, uninstallClaude } from "../vendors/claude/claude.js";
import { installCodex, uninstallCodex } from "../vendors/codex/codex.js";
import { installHermes, uninstallHermes } from "../vendors/hermes/hermes.js";
import { readCurrentPackageVersion } from "./update-notice.js";

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

/** `oms install` / `oms uninstall`. Returns the process exit code. */
export async function runInstallOrUninstall(
  action: "install" | "uninstall",
  context: HostCommandContext,
): Promise<number> {
  if (action === "uninstall" && !context.yes && !context.dryRun && process.env["OMS_NON_INTERACTIVE"] !== "1") {
    console.error("[oms] Refusing uninstall without --yes or --dry-run.");
    return 1;
  }

  const results = await runHostOperation(
    {
      action,
      runtime: context.runtime ?? (action === "install" ? "auto" : "all"),
      vault: context.vault,
      agentVault: context.agentVault,
      dryRun: context.dryRun,
      executeExternal: context.executeExternal,
      yes: context.yes,
      adapterRoot: context.adapterRoot,
    },
    runVendorHostOperation,
  );
  console.log(
    context.json
      ? formatHostOperationResultsJson(results, context.dryRun)
      : formatHostOperationResults(results, context.dryRun),
  );

  return 0;
}

/** `oms update`. Returns the process exit code. */
export async function runUpdateCommand(context: HostCommandContext): Promise<number> {
  if (context.unknownFlags.length > 0) {
    console.error(`[oms] Unsupported update option: ${context.unknownFlags.join(", ")}`);
    return 1;
  }

  const result = await runUpdate({
    currentVersion: await readCurrentPackageVersion(),
    latestVersion: process.env["OMS_UPDATE_LATEST_VERSION"],
    runtime: context.runtime ?? "all",
    vault: context.vault,
    check: context.checkUpdate,
    dryRun: context.dryRun,
    yes: context.yes,
    interactive: process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1",
    executeExternal: context.executeExternal,
    timeoutMs: context.timeoutMs,
    reconcileCommand: {
      command: process.execPath,
      argsPrefix: process.argv[1] === undefined ? [] : [process.argv[1]],
    },
  });
  console.log(formatUpdateResult(result));
  return result.success ? 0 : 1;
}

/** `oms update-reconcile` — internal; re-runs install after a package update. */
export async function runUpdateReconcile(context: HostCommandContext): Promise<number> {
  if (process.env["OMS_UPDATE_RECONCILE"] !== "1" && !context.dryRun) {
    console.error("[oms] update-reconcile is internal; run `oms update --yes` instead.");
    return 1;
  }

  const results = await runHostOperation(
    {
      action: "install",
      runtime: context.runtime ?? "all",
      vault: context.vault,
      dryRun: context.dryRun,
      executeExternal: context.executeExternal,
      yes: true,
      adapterRoot: context.adapterRoot,
    },
    runVendorHostOperation,
  );
  console.log(
    context.json
      ? formatHostOperationResultsJson(results, context.dryRun)
      : formatHostOperationResults(results, context.dryRun),
  );
  return results.some((result) => result.messages.some((message) => message.startsWith("FAILED:"))) ? 1 : 0;
}
