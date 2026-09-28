#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WriteTarget } from "../kernel/capture/safe.js";
import { parseCliArgs } from "./args.js";
import { maybePrintUpdateNotice, readCurrentPackageVersion } from "./update-notice.js";
import { mainUsageCommandNames, printUsage } from "./usage.js";

// Command modules load on dispatch, not at startup: each family pulls in only its own
// dependency graph, so `oms search --path` never loads the MCP server, HTTP server or engine.

export { maybePrintUpdateNotice } from "./update-notice.js";

function isKnownCommand(command: string | undefined): boolean {
  return command === undefined || mainUsageCommandNames().includes(command);
}

const RETIRED_COMMAND_GUIDANCE: Readonly<Record<string, string>> = {
  doctor: "Use `oms contract doctor`, `oms note audit`, or `oms index repair`.",
  template: "Use `oms contract setup|extract|status|doctor`; the sealed contract replaces template publication.",
  audit: "Use `oms note audit`.",
  reconcile: "Use `oms host sync`.",
  linkify: "Use `oms link suggest` or `oms link check`; OMS does not edit note bodies.",
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

async function effectiveTarget(explicitVault: string | undefined): Promise<WriteTarget> {
  if (explicitVault !== undefined) return { vault: explicitVault, source: "explicit" };
  const { resolveEffectiveVault } = await import("../kernel/link/link.js");
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

async function runHookCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  const [leaf, ...leafArgs] = argv;
  if (leaf === "--help" || leaf === "-h") {
    console.log("Usage: oms hook pre [--vault <path>]");
    return;
  }
  if (leaf === "pre" && leafArgs.length === 1 && (leafArgs[0] === "--help" || leafArgs[0] === "-h")) {
    console.log("Usage: oms hook pre [--vault <path>]");
    return;
  }
  if (leaf === "pre-tool-use") throw new Error("Hook leaf `pre-tool-use` is retired. Use `oms hook pre`.");
  if (leaf !== "pre") throw new Error("Usage: oms hook pre [--vault <path>]");
  const target = await effectiveTarget(parseVaultFlag(leafArgs));
  const { runPreToolUse } = await import("../vendors/claude/hook/pre-tool-use.js");
  await runPreToolUse({ vault: target.vault });
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
    const { runMcpServer } = await import("../mcp/server.js");
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
    const { runServeHttp } = await import("./serve-http.js");
    const server = await runServeHttp({ vault: target.vault, index: indexPath, host, port });
    console.log(JSON.stringify({ status: "listening", url: server.url, vault: target.vault, source: target.source }));
    return;
  }
  throw new Error("Usage: oms serve <mcp|http> [options]");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    const version = await readCurrentPackageVersion().catch(() => null);
    if (version === null) {
      console.error("[oms] Package version is unreadable.");
      process.exitCode = 1;
      return;
    }
    console.log(version);
    process.exitCode = 0;
    return;
  }
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.help) {
    if (!isKnownCommand(parsedArgs.command)) {
      console.error(`[oms] Unknown command: ${parsedArgs.command}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (parsedArgs.command === "contract") console.log((await import("./contract-command.js")).contractUsage());
    else if (parsedArgs.command === "setup") console.log((await import("./setup-command.js")).setupUsage());
    else printUsage();
    process.exitCode = 0;
    return;
  }
  const { command } = parsedArgs;

  if (command === "contract") {
    const { runContractCommand } = await import("./contract-command.js");
    await runContractCommand(argv.slice(1));
  } else if (command === "setup") {
    const { runSetup } = await import("./setup-command.js");
    await runSetup(argv.slice(1));
    if (process.exitCode === 0) await maybePrintUpdateNotice();
  } else if (command === "note") {
    const { runNoteCommand } = await import("./note-command.js");
    await runNoteCommand(argv.slice(1));
  } else if (command === "link") {
    if (argv[1]?.startsWith("-") && argv[1] !== "--help" && argv[1] !== "-h") {
      console.error("[oms] Repository linking moved to `oms bridge add|remove|status`.");
      process.exitCode = 1;
    } else {
      const { runLinkFamilyCommand } = await import("./link-command.js");
      await runLinkFamilyCommand(argv.slice(1));
    }
  } else if (command === "bridge") {
    const { runBridgeCommand } = await import("./link-command.js");
    await runBridgeCommand(argv.slice(1));
  } else if (command === "search") {
    const { runSearchCommand } = await import("./search.js");
    await runSearchCommand(argv.slice(1));
  } else if (command === "index") {
    const { runIndexFamilyCommand } = await import("./search.js");
    await runIndexFamilyCommand(argv.slice(1));
  } else if (command === "graph") {
    const { runGraphCommand } = await import("./graph-command.js");
    await runGraphCommand(argv.slice(1));
  } else if (command === "host") {
    const { runHostCommand } = await import("./host-commands.js");
    await runHostCommand(argv.slice(1));
  } else if (command === "package") {
    const { runPackageCommand } = await import("./package-command.js");
    await runPackageCommand(argv.slice(1));
  } else if (command === "model") {
    const { runModelCommand } = await import("./host-commands.js");
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
    const { runStatusCommand } = await import("./status-command.js");
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
