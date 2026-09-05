#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostToolUse } from "../vendors/claude/hook/post-tool-use.js";
import { runPreToolUse } from "../vendors/claude/hook/pre-tool-use.js";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { runMcpServer } from "../mcp/server.js";
import {
  PINNED_DEFAULT_EMBEDDING_MODEL,
  type ModelSetAcquisitionManifest,
} from "../kernel/engine/embed/model.js";
import { parseCliArgs } from "./args.js";
import { runGraphCommand } from "./graph-command.js";
import { runHostCommand, runModelCommand } from "./host-commands.js";
import { runBridgeCommand, runLinkFamilyCommand } from "./link-command.js";
import { runNoteCommand } from "./note-command.js";
import { runPackageCommand } from "./package-command.js";
import { runSearchCommand, runIndexFamilyCommand } from "./search.js";
import { runServeHttp } from "./serve-http.js";
import { runSetup } from "./setup-command.js";
import { runStatusCommand } from "./status-command.js";
import { runTemplateCommand, templateUsage } from "./template-command.js";
import { maybePrintUpdateNotice } from "./update-notice.js";
import { mainUsageCommandNames, printUsage } from "./usage.js";

export { buildClaudeInstallPlan } from "./claude-install-plan.js";
export type { ClaudeInstallPlan } from "./claude-install-plan.js";
export {
  runSetup,
  type SetupPrompt,
} from "./setup-command.js";
export { maybePrintUpdateNotice } from "./update-notice.js";

function isKnownCommand(command: string | undefined): boolean {
  return command === undefined || mainUsageCommandNames().includes(command);
}

const RETIRED_COMMAND_GUIDANCE: Readonly<Record<string, string>> = {
  doctor: "Use `oms template check`, `oms note audit`, or `oms index repair`.",
  audit: "Use `oms note audit`.",
  reconcile: "Use `oms host sync`.",
  linkify: "Use `oms link suggest` or `oms link apply`.",
  embed: "Use `oms index embed`.",
  doc: "Use `oms note get`.",
  mcp: "Use `oms serve mcp`.",
  lint: "Use `oms link check`.",
  install: "Use `oms host install`.",
  uninstall: "Use `oms host remove`.",
  update: "Use `oms package update`.",
};

function parseVaultFlag(argv: readonly string[]): string | undefined {
  let vault: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--vault") throw new Error(`Unknown option: ${token}`);
    if (vault !== undefined) throw new Error("Duplicate option: --vault");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("Missing value for --vault");
    vault = path.resolve(value);
  }
  return vault;
}

async function effectiveTarget(explicitVault: string | undefined): Promise<{
  readonly vault: string;
  readonly source: WriteTargetSource;
}> {
  if (explicitVault !== undefined) return { vault: explicitVault, source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

async function runServeCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  const [leaf, ...leafArgs] = argv;
  if (leaf === "--help" || leaf === "-h") {
    console.log("Usage: oms serve <mcp|http> [options]");
    return;
  }
  if (
    (leaf === "mcp" || leaf === "http")
    && leafArgs.length === 1
    && (leafArgs[0] === "--help" || leafArgs[0] === "-h")
  ) {
    console.log(
      leaf === "mcp"
        ? "Usage: oms serve mcp [--vault <path>]"
        : "Usage: oms serve http [--vault <path>] [--index <path>] [--host <host>] [--port <port>]",
    );
    return;
  }
  if (leaf === "mcp") {
    const target = await effectiveTarget(parseVaultFlag(leafArgs));
    await runMcpServer(target);
    return;
  }
  if (leaf === "http") {
    let explicitVault: string | undefined;
    let indexPath: string | undefined;
    let host: string | undefined;
    let port: number | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < leafArgs.length; index += 1) {
      const token = leafArgs[index];
      const value = leafArgs[index + 1];
      if (!["--vault", "--index", "--host", "--port"].includes(token ?? "")) {
        throw new Error(`Unknown serve http option: ${token}`);
      }
      if (seen.has(token!)) throw new Error(`Duplicate serve http option: ${token}`);
      seen.add(token!);
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      index += 1;
      if (token === "--vault") explicitVault = path.resolve(value);
      else if (token === "--index") indexPath = path.resolve(value);
      else if (token === "--host") host = value;
      else {
        const parsedPort = Number.parseInt(value, 10);
        if (`${parsedPort}` !== value || parsedPort < 0 || parsedPort > 65_535) {
          throw new Error(`Invalid port: ${value}`);
        }
        port = parsedPort;
      }
    }
    const target = await effectiveTarget(explicitVault);
    const server = await runServeHttp({ vault: target.vault, index: indexPath, host, port });
    console.log(JSON.stringify({ status: "listening", url: server.url, vault: target.vault, source: target.source }));
    return;
  }
  throw new Error("Usage: oms serve <mcp|http> [options]");
}

async function runHookCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  const [leaf, ...leafArgs] = argv;
  if (leaf === "--help" || leaf === "-h") {
    console.log("Usage: oms hook <pre|post> [--vault <path>]");
    return;
  }
  if (
    (leaf === "pre" || leaf === "post")
    && leafArgs.length === 1
    && (leafArgs[0] === "--help" || leafArgs[0] === "-h")
  ) {
    console.log(`Usage: oms hook ${leaf} [--vault <path>]`);
    return;
  }
  if (leaf === "pre-tool-use" || leaf === "post-tool-use") {
    throw new Error(`Hook leaf \`${leaf}\` is retired. Use \`oms hook ${leaf === "pre-tool-use" ? "pre" : "post"}\`.`);
  }
  if (leaf !== "pre" && leaf !== "post") throw new Error("Usage: oms hook <pre|post> [--vault <path>]");
  const target = await effectiveTarget(parseVaultFlag(leafArgs));
  if (leaf === "pre") await runPreToolUse({ vault: target.vault });
  else await runPostToolUse({ vault: target.vault });
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
    if (parsedArgs.command === "template") console.log(templateUsage());
    else printUsage();
    process.exitCode = 0;
    return;
  }
  if (parsedArgs.error !== undefined) {
    console.error(parsedArgs.error.message);
    process.exitCode = 1;
    return;
  }
  const {
    command,
    vault,
    yes,
    approvedDigest,
    templateFolders,
    installClaude,
    dryRun,
    modelsDescriptorPath,
    modelsNoDefault,
    modelsDefault,
    unknownFlags,
  } = parsedArgs;

  if (command === "template") {
    await runTemplateCommand(argv.slice(1));
  } else if (command === "setup") {
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
      templateFolders,
      installClaude,
      dryRun,
      modelSetManifest,
      modelsNoDefault,
    });
    if (!dryRun && outcome === "completed") await maybePrintUpdateNotice();
  } else if (command === "note") {
    await runNoteCommand(argv.slice(1));
  } else if (command === "link") {
    if (argv[1]?.startsWith("-") && argv[1] !== "--help" && argv[1] !== "-h") {
      console.error("[oms] Repository linking moved to `oms bridge add|remove|status`.");
      process.exitCode = 1;
    } else {
      await runLinkFamilyCommand(argv.slice(1));
    }
  } else if (command === "bridge") {
    await runBridgeCommand(argv.slice(1));
  } else if (command === "search") {
    await runSearchCommand(argv.slice(1));
  } else if (command === "index") {
    await runIndexFamilyCommand(argv.slice(1));
  } else if (command === "graph") {
    await runGraphCommand(argv.slice(1));
  } else if (command === "host") {
    await runHostCommand(argv.slice(1));
  } else if (command === "package") {
    await runPackageCommand(argv.slice(1));
  } else if (command === "model") {
    await runModelCommand(argv.slice(1));
  } else if (command === "serve") {
    try {
      await runServeCommand(argv.slice(1));
    } catch (error: unknown) {
      console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  } else if (command === "hook") {
    try {
      await runHookCommand(argv.slice(1));
    } catch (error: unknown) {
      console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  } else if (command === "status") {
    await runStatusCommand(argv.slice(1));
  } else if (command === undefined) {
    // No command at all is a request for help, not an error.
    printUsage();
    process.exitCode = 0;
  } else {
    const retiredGuidance = RETIRED_COMMAND_GUIDANCE[command];
    console.error(
      retiredGuidance === undefined
        ? `[oms] Unknown command: ${command}`
        : `[oms] Command \`${command}\` is retired. ${retiredGuidance}`,
    );
    printUsage();
    process.exitCode = 1;
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
