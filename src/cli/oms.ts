#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostToolUse } from "../hook/post-tool-use.js";
import { runPreToolUse } from "../hook/pre-tool-use.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { resolveEffectiveVault } from "../link/link.js";
import { runMcpServer } from "../mcp/server.js";
import { resolveBundledAssetPaths } from "../core/runtime/assets.js";
import { parseCliArgs } from "./args.js";
import { runAudit } from "./audit.js";
import { runDoctor, runLint } from "./doctor-lint.js";
import {
  runInstallOrUninstall,
  runUpdateCommand,
  runUpdateReconcile,
  type HostCommandContext,
} from "./host-commands.js";
import { nonFatalGlobalWriteback, registerGlobalVault } from "./global-writeback.js";
import { runLink } from "./link-command.js";
import { runLinkify } from "./linkify.js";
import { isSemanticCliCommand, runSemanticCli } from "./semantic.js";
import { runSetup } from "./setup-command.js";
import { maybePrintUpdateNotice } from "./update-notice.js";
import { printUsage } from "./usage.js";

export { buildClaudeInstallPlan } from "./claude-install-plan.js";
export type { ClaudeInstallPlan } from "./claude-install-plan.js";
export { runDoctor, runLint } from "./doctor-lint.js";
export { runAudit } from "./audit.js";
export {
  formatLinkResult,
  runLink,
} from "./link-command.js";
export { runLinkify } from "./linkify.js";
export {
  runSetup,
  type SetupPrompt,
} from "./setup-command.js";
export { maybePrintUpdateNotice } from "./update-notice.js";

const bundledAssets = resolveBundledAssetPaths();

function shouldResolveBridgeVault(command: string | undefined, vaultExplicit: boolean): boolean {
  return (
    !vaultExplicit &&
    (command === "audit" ||
      command === "linkify" ||
      command === "doctor" ||
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
    apply,
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
    conventionNote,
    unknownFlags,
  } = parsedArgs;

  // `mcp` keeps the FULL resolution result: the write surface trusts every
  // source except `cwd`, so the server needs the source, not just the path.
  let mcpTarget: { vault: string; scope: string[] | null; source: WriteTargetSource } | undefined;
  if (command === "mcp") {
    mcpTarget = vaultExplicit
      ? { vault, scope: null, source: "explicit" }
      : await resolveEffectiveVault(process.cwd(), process.env);
    vault = mcpTarget.vault;
  } else if (shouldResolveBridgeVault(command, vaultExplicit)) {
    vault = (await resolveEffectiveVault(process.cwd(), process.env)).vault;
  }

  if (command === "setup") {
    await runSetup({ vault, yes, installClaude, suggestFields });
    await nonFatalGlobalWriteback(() =>
      registerGlobalVault({ vault: path.resolve(vault), homeDir: undefined, overwrite: true }),
    );
    await maybePrintUpdateNotice();
  } else if (command === "link") {
    process.exitCode = await runLink({
      cwd: process.cwd(),
      vault,
      vaultExplicit,
      folders,
      conventionNote,
    });
    await maybePrintUpdateNotice();
  } else if (command === "install" || command === "uninstall") {
    process.exitCode = await runInstallOrUninstall(command, hostContext());
    if (process.exitCode === 0) await maybePrintUpdateNotice();
  } else if (command === "update") {
    process.exitCode = await runUpdateCommand(hostContext());
  } else if (command === "update-reconcile") {
    process.exitCode = await runUpdateReconcile(hostContext());
  } else if (command === "doctor") {
    process.exitCode = await runDoctor({ vault, verbose, json, maxPerConcept });
    await maybePrintUpdateNotice();
  } else if (command === "audit") {
    process.exitCode = await runAudit({
      vault,
      json,
      folder: folders[0],
      suggestFields,
    });
    await maybePrintUpdateNotice();
  } else if (command === "linkify") {
    process.exitCode = await runLinkify({
      vault,
      folder: folders[0],
      apply,
      yes,
    });
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
    await runMcpServer({
      vault,
      source: mcpTarget?.source ?? "explicit",
    });
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

  function hostContext(): HostCommandContext {
    return {
      vault,
      vaultExplicit,
      runtime,
      agentVault,
      dryRun,
      executeExternal,
      yes,
      json,
      checkUpdate,
      timeoutMs,
      unknownFlags,
      adapterRoot: bundledAssets.packageRoot,
    };
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
