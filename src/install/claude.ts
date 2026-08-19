import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { resolveHostAdapterSource } from "./adapter-source.js";
import { commandExists, hostHome, isRecord, runExternal } from "./common.js";
import { removeClaudeHooks, replaceRootJsonPropertyPreservingBytes, upsertClaudeHooks } from "./claude-hooks.js";
import {
  MARKETPLACE_AUTO_UPDATE_MESSAGE,
  resolveClaudeMarketplaceSource,
  runClaudePluginInstall,
} from "./claude-marketplace.js";
import type {
  ClaudeMcpScope,
  HostOperationOptions,
  HostOperationResult,
  LegacyCleanupResult,
} from "./types.js";

const CLAUDE_MCP_SCOPES: readonly ClaudeMcpScope[] = ["local", "project", "user"];

function claudeMcpRemoveCommand(scope: ClaudeMcpScope): string {
  return `claude mcp remove oms --scope ${scope}`;
}

function classifyCleanupResult(
  scope: ClaudeMcpScope,
  result: ReturnType<typeof runExternal>,
): LegacyCleanupResult {
  const manualCommand = claudeMcpRemoveCommand(scope);
  if (result.ok) {
    return { scope, status: "removed", reasonCode: "legacy_removed", manualCommand };
  }

  const stderr = result.stderr;
  const localNotFound =
    scope === "local" && /No local mcp server found with name:\s*oms/i.test(stderr);
  const projectNotFound =
    scope === "project" &&
    /No MCP server found with name:\s*oms/i.test(stderr) &&
    /\.mcp\.json|project/i.test(stderr);
  if (localNotFound || projectNotFound) {
    return { scope, status: "not_found", reasonCode: "legacy_not_found", manualCommand };
  }

  return { scope, status: "failed", reasonCode: "legacy_cleanup_failed", manualCommand };
}

function cleanupMessage(result: LegacyCleanupResult): string {
  if (result.status === "removed") {
    return `Claude MCP cleanup (${result.scope}): removed stale oms registration.`;
  }
  if (result.status === "not_found") {
    return `Claude MCP cleanup (${result.scope}): no stale oms registration found.`;
  }
  return `WARNING: Claude MCP cleanup (${result.scope}) failed [${result.reasonCode}]. Install continued. Manual step: ${result.manualCommand}`;
}

function plannedCleanupMessages(dryRun: boolean): string[] {
  const prefix = dryRun ? "dry-run: would execute" : "planned external cleanup";
  return CLAUDE_MCP_SCOPES.map((scope) => `Claude MCP cleanup (${scope}): ${prefix} ${claudeMcpRemoveCommand(scope)}.`);
}

function externalLifecycleFailure(action: "install" | "uninstall", result: ReturnType<typeof runExternal>): string {
  const reasonCode = result.exitCode === null ? "claude_cli_spawn_failed" : `claude_plugin_${action}_failed`;
  return `WARNING: Claude plugin ${action} failed [${reasonCode}]. Plugin-owned MCP activation remains a manual step.`;
}

function runClaudeMcpCleanup(
  options: HostOperationOptions,
): { results: LegacyCleanupResult[]; messages: string[]; changed: boolean } {
  if (options.dryRun) {
    return { results: [], messages: plannedCleanupMessages(true), changed: false };
  }
  if (!options.executeExternal) {
    return {
      results: [],
      messages: [
        "Claude MCP cleanup was not executed; pass --execute to remove stale registrations through the Claude CLI.",
        ...plannedCleanupMessages(false),
      ],
      changed: false,
    };
  }
  if (!commandExists("claude")) {
    const results = CLAUDE_MCP_SCOPES.map((scope) => ({
      scope,
      status: "failed" as const,
      reasonCode: "claude_cli_unavailable",
      manualCommand: claudeMcpRemoveCommand(scope),
    }));
    return {
      results,
      messages: results.map(cleanupMessage),
      changed: false,
    };
  }

  const results = CLAUDE_MCP_SCOPES.map((scope) => {
    const result = runExternal("claude", ["mcp", "remove", "oms", "--scope", scope]);
    return classifyCleanupResult(scope, result);
  });
  return {
    results,
    messages: results.map(cleanupMessage),
    changed: results.some((result) => result.status === "removed"),
  };
}

async function removeClaudeMcp(
  options: HostOperationOptions,
  claudeDir: string,
): Promise<{ changed: boolean; message?: string }> {
  const mcpPath = path.join(claudeDir, "mcp.json");
  let raw: string;
  try {
    raw = await readFile(mcpPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { changed: false };
    return { changed: false, message: `WARNING: Could not read ${mcpPath}; direct MCP cleanup skipped. Remove stale oms manually.` };
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { changed: false, message: `WARNING: ${mcpPath} is not a JSON object; direct MCP cleanup skipped.` };
    }
    data = parsed;
  } catch {
    return { changed: false, message: `WARNING: ${mcpPath} is malformed JSON; direct MCP cleanup skipped.` };
  }
  const existingServers = data["mcpServers"];
  if (existingServers !== undefined && !isRecord(existingServers)) {
    return { changed: false, message: `WARNING: ${mcpPath} has unsupported mcpServers metadata; direct MCP cleanup skipped.` };
  }
  if (!isRecord(existingServers) || !("oms" in existingServers)) {
    return { changed: false };
  }
  delete existingServers["oms"];
  const next = replaceRootJsonPropertyPreservingBytes(raw, "mcpServers", existingServers);
  if (next === null) {
    return { changed: false, message: `WARNING: Could not preserve unmanaged MCP config bytes in ${mcpPath}; direct cleanup skipped.` };
  }
  if (!options.dryRun) {
    try {
      await writeFile(mcpPath, next, "utf-8");
    } catch {
      return { changed: false, message: `WARNING: Could not write ${mcpPath}; direct MCP cleanup skipped. Remove stale oms manually.` };
    }
  }
  return { changed: !options.dryRun };
}

export async function installClaude(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const pluginPath = resolveHostAdapterSource(options.adapterRoot, host);
  const marketplace = await resolveClaudeMarketplaceSource(pluginPath);
  const commands = [
    ...CLAUDE_MCP_SCOPES.map(claudeMcpRemoveCommand),
    `claude plugin marketplace add ${marketplace.source}`,
    `claude plugin install oms@${marketplace.marketplaceName}`,
    `claude plugin install ${pluginPath}`,
  ];
  const messages = [
    "Claude Code adapter is installed through the plugin-owned MCP surface declared in .mcp.json.",
    `Claude marketplace source: ${marketplace.source} (${marketplace.kind}); the local plugin path stays available as an offline fallback.`,
    MARKETPLACE_AUTO_UPDATE_MESSAGE,
  ];
  const directCleanup = await removeClaudeMcp(options, claudeDir);
  let changed = directCleanup.changed;
  if (directCleanup.changed) messages.push("Removed stale direct oms MCP registration from Claude local config.");
  if (directCleanup.message) messages.push(directCleanup.message);
  let pluginInstalled = false;

  const cleanup = runClaudeMcpCleanup(options);
  messages.push(...cleanup.messages);
  changed = cleanup.changed || changed;

  if (options.executeExternal) {
    if (!commandExists("claude")) {
      messages.push("Claude CLI was not found; no plugin or MCP activation was performed. Run the listed plugin command manually.");
    } else if (!options.dryRun) {
      const install = runClaudePluginInstall({
        marketplace,
        pluginPath,
        describeFailure: (result) => externalLifecycleFailure("install", result),
      });
      messages.push(...install.messages);
      changed = changed || install.installed;
      pluginInstalled = install.installed;
    }
  }

  if (!pluginInstalled) messages.push("Claude plugin was not installed; plugin-owned MCP activation remains a manual step.");
  const hookResult = await upsertClaudeHooks(options, claudeDir);
  changed = hookResult.changed || changed;
  messages.push(...hookResult.messages);

  return {
    runtime: "claude",
    action: "install",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [pluginPath, path.join(claudeDir, "settings.json")],
    commands,
    messages,
    cleanup: cleanup.results,
  };
}

export async function uninstallClaude(options: HostOperationOptions): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const commands = [
    ...CLAUDE_MCP_SCOPES.map(claudeMcpRemoveCommand),
    "claude plugin uninstall oms",
  ];
  const messages = ["Claude Code uninstall removes the Oh My Second Brain MCP entry and, when requested, asks Claude CLI to uninstall the plugin."];
  const directCleanup = await removeClaudeMcp(options, claudeDir);
  let changed = directCleanup.changed;
  if (directCleanup.message) messages.push(directCleanup.message);

  const cleanup = runClaudeMcpCleanup(options);
  messages.push(...cleanup.messages);
  changed = cleanup.changed || changed;

  const hookResult = await removeClaudeHooks(options, claudeDir);
  changed = hookResult.changed || changed;
  messages.push(...hookResult.messages);

  if (options.executeExternal && commandExists("claude") && !options.dryRun) {
    const externalCommands: [string, ...string[]][] = [["claude", "plugin", "uninstall", "oms"]];
    for (const [command, ...args] of externalCommands) {
      const result = runExternal(command, args);
      messages.push(result.ok ? `Executed: ${result.message}` : externalLifecycleFailure("uninstall", result));
      changed = changed || result.ok;
    }
  }

  return {
    runtime: "claude",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [path.join(claudeDir, "mcp.json")],
    commands,
    messages,
    cleanup: cleanup.results,
  };
}
