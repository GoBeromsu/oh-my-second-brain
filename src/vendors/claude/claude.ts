import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../../kernel/harness/surface-registry.js";
import { resolveHostAdapterSource } from "../../kernel/install/adapter-source.js";
import { commandExists, hostHome, isRecord, mcpServerEntry, runExternal } from "../../kernel/install/common.js";
import { HOOK_MATCHER, READ_MATCHER, isOmsHookEntry, removeClaudeHooks, replaceRootJsonPropertyPreservingBytes, upsertClaudeHooks } from "./claude-hooks.js";
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
} from "../../kernel/install/types.js";

const CLAUDE_MCP_SCOPES: readonly ClaudeMcpScope[] = ["local", "project", "user"];

export { HOOK_MATCHER, READ_MATCHER, isOmsHookEntry };

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

/**
 * `~/.claude.json`'s root `mcpServers` key is Claude Code's user scope, and it
 * is now the ONLY place Claude learns how to launch OMS: the plugin-owned
 * `.mcp.json` that used to sit beside it invoked a bare `oms` resolved from
 * `PATH`, which is exactly the cross-Node-ABI launch this pinning work exists
 * to remove, so that manifest no longer ships. This entry pins the installing
 * process's absolute interpreter and entrypoint and bakes in the resolved
 * vault.
 *
 * Because no fallback remains, a failure here is an install failure, not a
 * warning: continuing would leave Claude with no OMS registration at all while
 * reporting success.
 */
class ClaudeUserScopeRegistrationError extends Error {
  constructor(claudeJsonPath: string, reason: string) {
    super(
      `Refusing to finish the Claude install: ${reason} (${claudeJsonPath}). `
      + "The user-scope registration pins the Node interpreter OMS must launch under, and no plugin fallback exists. "
      + `Fix ${claudeJsonPath}, then rerun oms host install --runtime claude.`,
    );
    this.name = "ClaudeUserScopeRegistrationError";
  }
}

async function upsertClaudeUserScopeMcp(
  options: HostOperationOptions,
  claudeJsonPath: string,
): Promise<{ changed: boolean; message?: string }> {
  let raw = "{}";
  try {
    raw = await readFile(claudeJsonPath, "utf-8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "the Claude user config could not be read");
    }
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "the Claude user config is not a JSON object");
    }
    data = parsed;
  } catch (error) {
    if (error instanceof ClaudeUserScopeRegistrationError) throw error;
    throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "the Claude user config is malformed JSON");
  }
  const existingServers = data["mcpServers"];
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "the Claude user config has unsupported mcpServers metadata");
  }
  const nextServers = isRecord(existingServers) ? existingServers : {};
  const desired = mcpServerEntry(options);
  const alreadyCurrent = JSON.stringify(nextServers["oms"]) === JSON.stringify(desired);
  if (alreadyCurrent) {
    return { changed: false };
  }
  nextServers["oms"] = desired;
  const next = replaceRootJsonPropertyPreservingBytes(raw, "mcpServers", nextServers);
  if (next === null) {
    throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "unmanaged bytes in the Claude user config could not be preserved");
  }
  if (!options.dryRun) {
    try {
      await writeFile(claudeJsonPath, next, "utf-8");
    } catch {
      throw new ClaudeUserScopeRegistrationError(claudeJsonPath, "the Claude user config could not be written");
    }
  }
  return { changed: !options.dryRun };
}

async function removeClaudeUserScopeMcp(
  options: HostOperationOptions,
  claudeJsonPath: string,
): Promise<{ changed: boolean; message?: string }> {
  let raw: string;
  try {
    raw = await readFile(claudeJsonPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { changed: false };
    return { changed: false, message: `WARNING: Could not read ${claudeJsonPath}; user-scope MCP cleanup skipped.` };
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { changed: false, message: `WARNING: ${claudeJsonPath} is not a JSON object; user-scope MCP cleanup skipped.` };
    }
    data = parsed;
  } catch {
    return { changed: false, message: `WARNING: ${claudeJsonPath} is malformed JSON; user-scope MCP cleanup skipped.` };
  }
  const existingServers = data["mcpServers"];
  if (existingServers !== undefined && !isRecord(existingServers)) {
    return { changed: false, message: `WARNING: ${claudeJsonPath} has unsupported mcpServers metadata; user-scope MCP cleanup skipped.` };
  }
  if (!isRecord(existingServers) || !("oms" in existingServers)) {
    return { changed: false };
  }
  delete existingServers["oms"];
  const next = replaceRootJsonPropertyPreservingBytes(raw, "mcpServers", existingServers);
  if (next === null) {
    return { changed: false, message: `WARNING: Could not preserve unmanaged config bytes in ${claudeJsonPath}; user-scope MCP cleanup skipped.` };
  }
  if (!options.dryRun) {
    try {
      await writeFile(claudeJsonPath, next, "utf-8");
    } catch {
      return { changed: false, message: `WARNING: Could not write ${claudeJsonPath}; user-scope MCP cleanup skipped.` };
    }
  }
  return { changed: !options.dryRun };
}

export async function installClaude(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const claudeJsonPath = path.join(path.dirname(claudeDir), ".claude.json");
  const pluginPath = resolveHostAdapterSource(options.adapterRoot, host);
  const marketplace = await resolveClaudeMarketplaceSource(pluginPath);
  const commands = [
    ...CLAUDE_MCP_SCOPES.map(claudeMcpRemoveCommand),
    `claude plugin marketplace add ${marketplace.source}`,
    `claude plugin install oms@${marketplace.marketplaceName}`,
    `claude plugin install ${pluginPath}`,
  ];
  const messages = [
    "Claude Code adapter registers oms as a user-scope MCP server (in ~/.claude.json) with the installing interpreter, entrypoint, and resolved vault pinned as absolute paths. It is the only OMS registration: no plugin-owned .mcp.json ships, so nothing can relaunch OMS through a PATH-resolved `oms`.",
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

  // Runs after the CLI-driven `--scope user` cleanup above so a real
  // `--execute` install cannot immediately strip out the entry this writes.
  const userScopeUpsert = await upsertClaudeUserScopeMcp(options, claudeJsonPath);
  changed = userScopeUpsert.changed || changed;
  if (userScopeUpsert.changed) messages.push(`Registered oms as a user-scope MCP server in ${claudeJsonPath}.`);
  if (userScopeUpsert.message) messages.push(userScopeUpsert.message);

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

  if (!pluginInstalled) messages.push("Claude plugin was not installed; run the listed `claude plugin install` command to install it. The user-scope MCP registration above is already in place and does not depend on the plugin.");
  const hookResult = await upsertClaudeHooks(options, claudeDir);
  changed = hookResult.changed || changed;
  messages.push(...hookResult.messages);

  return {
    runtime: "claude",
    action: "install",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [pluginPath, path.join(claudeDir, "settings.json"), claudeJsonPath],
    commands,
    messages,
    cleanup: cleanup.results,
  };
}

export async function uninstallClaude(options: HostOperationOptions): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const claudeJsonPath = path.join(path.dirname(claudeDir), ".claude.json");
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

  const userScopeRemoval = await removeClaudeUserScopeMcp(options, claudeJsonPath);
  changed = userScopeRemoval.changed || changed;
  if (userScopeRemoval.changed) messages.push(`Removed the oms user-scope MCP registration from ${claudeJsonPath}.`);
  if (userScopeRemoval.message) messages.push(userScopeRemoval.message);

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
    paths: [path.join(claudeDir, "mcp.json"), claudeJsonPath],
    commands,
    messages,
    cleanup: cleanup.results,
  };
}
