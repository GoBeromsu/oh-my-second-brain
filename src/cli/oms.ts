#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostToolUse } from "../hook/post-tool-use.js";
import { runPreToolUse } from "../hook/pre-tool-use.js";
import {
  formatHostOperationResults,
  runHostOperation,
} from "../install/hosts.js";
import { resolveEffectiveVault } from "../link/link.js";
import { runMcpServer } from "../mcp/server.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";
import {
  formatUpdateResult,
  runUpdate,
} from "../update/update.js";
import { parseCliArgs } from "./args.js";
import { runDoctor, runLint } from "./doctor-lint.js";
import { runLink } from "./link-command.js";
import { isSemanticCliCommand, runSemanticCli } from "./semantic.js";
import { runSetup } from "./setup-command.js";
import { maybePrintUpdateNotice, readCurrentPackageVersion } from "./update-notice.js";
import { printUsage } from "./usage.js";

export { buildClaudeInstallPlan } from "./claude-install-plan.js";
export type { ClaudeInstallPlan } from "./claude-install-plan.js";
export { runDoctor, runLint } from "./doctor-lint.js";
export {
  formatLinkResult,
  runLink,
} from "./link-command.js";
export {
  runSetup,
  type SetupPrompt,
} from "./setup-command.js";
export { maybePrintUpdateNotice } from "./update-notice.js";

const bundledAssets = resolveBundledAssetPaths();

function bundledAdapterRoot(): string {
  return bundledAssets.adapterRoot;
}

function shouldResolveBridgeVault(command: string | undefined, vaultExplicit: boolean): boolean {
  return (
    !vaultExplicit &&
    (command === "doctor" ||
      command === "lint" ||
      command === "mcp" ||
      isSemanticCliCommand(command))
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.error !== undefined) {
    console.error(parsedArgs.error.message);
    process.exitCode = 1;
    return;
  }
  let {
    command,
    vault,
    vaultExplicit,
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
    folders,
    unknownFlags,
  } = parsedArgs;

  if (shouldResolveBridgeVault(command, vaultExplicit)) {
    vault = (await resolveEffectiveVault(process.cwd(), process.env)).vault;
  }

  if (command === "setup") {
    await runSetup({ vault, yes, installClaude, suggestFields });
    await maybePrintUpdateNotice();
  } else if (command === "link") {
    process.exitCode = await runLink({
      cwd: process.cwd(),
      vault,
      vaultExplicit,
      folders,
    });
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
    process.exitCode = await runDoctor({ vault, verbose, json, maxPerConcept });
    await maybePrintUpdateNotice();
  } else if (command === "lint") {
    process.exitCode = await runLint({ vault, verbose, json });
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
