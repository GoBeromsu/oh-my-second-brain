#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostToolUse } from "../vendors/claude/hook/post-tool-use.js";
import { runPreToolUse } from "../vendors/claude/hook/pre-tool-use.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { runMcpServer } from "../mcp/server.js";
import { resolveBundledAssetPaths } from "../kernel/runtime/assets.js";
import {
  PINNED_DEFAULT_EMBEDDING_MODEL,
  type ModelSetAcquisitionManifest,
} from "../kernel/engine/embed/model.js";
import { parseCliArgs } from "./args.js";
import { runAudit } from "./audit.js";
import { runDoctor, runLint } from "./doctor-lint.js";
import {
  runInstallOrUninstall,
  runUpdateCommand,
  runReconcile,
  type HostCommandContext,
} from "./host-commands.js";
import { runLink } from "./link-command.js";
import { runLinkify } from "./linkify.js";
import { isSearchCliCommand, runSearchCli } from "./search.js";
import { runSetup } from "./setup-command.js";
import { searchUsage } from "./search-usage.js";
import { maybePrintUpdateNotice } from "./update-notice.js";
import { mainUsageCommandNames, printUsage } from "./usage.js";

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
      isSearchCliCommand(command))
  );
}

function isKnownCommand(command: string | undefined): boolean {
  return command === undefined || mainUsageCommandNames().includes(command);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.help) {
    if (!isKnownCommand(parsedArgs.command)) {
      console.error(`[oms] Unknown command: ${parsedArgs.command}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (isSearchCliCommand(parsedArgs.command)) {
      console.log(searchUsage());
    } else {
      printUsage();
    }
    process.exitCode = 0;
    return;
  }
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
    modelsDescriptorPath,
    modelsNoDefault,
    modelsDefault,
    unknownFlags,
  } = parsedArgs;

  // `mcp` keeps the FULL resolution result: the write surface trusts every
  // source except `cwd`, so the server needs the source, not just the path.
  let mcpTarget: { vault: string; scope: string[] | null; source: WriteTargetSource } | undefined;
  if ((command === "update" || command === "reconcile") && unknownFlags.length > 0) {
    console.error(`[oms] Unsupported update option: ${unknownFlags.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (command === "mcp") {
    mcpTarget = vaultExplicit
      ? { vault, scope: null, source: "explicit" }
      : await resolveEffectiveVault(process.cwd(), process.env);
    vault = mcpTarget.vault;
  } else if (shouldResolveBridgeVault(command, vaultExplicit)) {
    vault = (await resolveEffectiveVault(process.cwd(), process.env)).vault;
  }

  if (command === "setup") {
    const canonicalModelFlags =
      "--models-default, --models-descriptor <path>, or --models-no-default";
    if (unknownFlags.length > 0) {
      console.error(
        `[oms] Unsupported setup option: ${unknownFlags.join(", ")}. Canonical model options are ${canonicalModelFlags}.`,
      );
      process.exitCode = 1;
      return;
    }
    const modelChoices = [
      modelsDescriptorPath !== undefined ? "--models-descriptor" : undefined,
      modelsDefault ? "--models-default" : undefined,
      modelsNoDefault ? "--models-no-default" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (modelChoices.length > 1) {
      console.error(
        `[oms] Mutually exclusive setup model options: ${modelChoices.join(" and ")}. Choose one of ${canonicalModelFlags}.`,
      );
      process.exitCode = 1;
      return;
    }
    let modelSetManifest: ModelSetAcquisitionManifest | unknown;
    if (modelsDescriptorPath !== undefined) {
      modelSetManifest = JSON.parse(readFileSync(modelsDescriptorPath, "utf8")) as unknown;
    } else if (modelsDefault) {
      modelSetManifest = {
        schemaVersion: 1,
        embed: {
          provider: PINNED_DEFAULT_EMBEDDING_MODEL.provider,
          model: PINNED_DEFAULT_EMBEDDING_MODEL.model,
          revision: PINNED_DEFAULT_EMBEDDING_MODEL.revision,
          sha256: PINNED_DEFAULT_EMBEDDING_MODEL.sha256,
          promptScheme: PINNED_DEFAULT_EMBEDDING_MODEL.prefixScheme,
          filename: PINNED_DEFAULT_EMBEDDING_MODEL.filename,
          url: PINNED_DEFAULT_EMBEDDING_MODEL.url,
          dimensions: PINNED_DEFAULT_EMBEDDING_MODEL.dimensions,
          contextLength: PINNED_DEFAULT_EMBEDDING_MODEL.context,
          mrlDim: PINNED_DEFAULT_EMBEDDING_MODEL.mrlDim,
          normalization: PINNED_DEFAULT_EMBEDDING_MODEL.normalization,
        },
      };
    }
    const outcome = await runSetup({
      vault,
      yes,
      approvedDigest: approvedDigest as `sha256:${string}` | undefined,
      templateFolder,
      installClaude,
      dryRun,
      modelSetManifest,
      modelsNoDefault,
    });
    if (!dryRun && outcome === "completed") await maybePrintUpdateNotice();
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
  } else if (command === "reconcile") {
    process.exitCode = await runReconcile(hostContext());
  } else if (command === "doctor") {
    process.exitCode = await runDoctor({ vault, verbose, json, maxPerTemplate });
    await maybePrintUpdateNotice();
  } else if (command === "audit") {
    process.exitCode = await runAudit({
      vault,
      json,
      folder: folders[0],
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
  } else if (isSearchCliCommand(command)) {
    process.exitCode = await runSearchCli({
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
  } else if (command === undefined) {
    // No command at all is a request for help, not an error.
    printUsage();
    process.exitCode = 0;
  } else {
    // An unrecognised command must fail. Printing usage and exiting 0 makes a
    // typo look like success, and makes a removed command indistinguishable
    // from a working one - which is how the retired qmd aliases went unnoticed.
    console.error(`[oms] Unknown command: ${command}`);
    printUsage();
    process.exitCode = 1;
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
