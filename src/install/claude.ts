import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { resolveHostAdapterSource } from "./adapter-source.js";
import { commandExists, hostHome, isRecord, mcpArgs, mcpServerEntry, readJsonObject, runExternal, writeJsonObject } from "./common.js";
import { removeClaudeHooks, upsertClaudeHooks } from "./claude-hooks.js";
import type { HostOperationOptions, HostOperationResult } from "./types.js";

async function upsertClaudeMcp(options: HostOperationOptions, claudeDir: string): Promise<boolean> {
  const mcpPath = path.join(claudeDir, "mcp.json");
  const data = await readJsonObject(mcpPath);
  const existingServers = data["mcpServers"];
  const mcpServers = isRecord(existingServers) ? existingServers : {};
  mcpServers["oms"] = mcpServerEntry(options);
  data["mcpServers"] = mcpServers;
  return writeJsonObject(mcpPath, data, Boolean(options.dryRun));
}

async function removeClaudeMcp(options: HostOperationOptions, claudeDir: string): Promise<boolean> {
  const mcpPath = path.join(claudeDir, "mcp.json");
  const data = await readJsonObject(mcpPath);
  const existingServers = data["mcpServers"];
  if (!isRecord(existingServers) || !("oms" in existingServers)) {
    return false;
  }
  delete existingServers["oms"];
  data["mcpServers"] = existingServers;
  return writeJsonObject(mcpPath, data, Boolean(options.dryRun));
}

export async function installClaude(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const pluginPath = resolveHostAdapterSource(options.adapterRoot, host);
  const commands = [
    `claude plugin install ${pluginPath}`,
    `claude mcp add oms -- oms ${mcpArgs(options).join(" ")}`,
  ];
  const messages = ["Claude Code adapter is installed through Claude's plugin/MCP surfaces."];
  let changed = false;

  if (options.executeExternal) {
    if (!commandExists("claude")) {
      messages.push("claude CLI was not found; wrote MCP config only and left plugin command for manual execution.");
    } else if (!options.dryRun) {
      const externalCommands: [string, ...string[]][] = [
        ["claude", "plugin", "install", pluginPath],
        ["claude", "mcp", "add", "oms", "--", "oms", ...mcpArgs(options)],
      ];
      for (const [command, ...args] of externalCommands) {
        const result = runExternal(command, args);
        messages.push(result.ok ? `Executed: ${result.message}` : `External command failed: ${result.message}`);
        changed = changed || result.ok;
      }
    }
  }

  changed = (await upsertClaudeMcp(options, claudeDir)) || changed;
  const hookResult = await upsertClaudeHooks(options, claudeDir);
  changed = hookResult.changed || changed;
  messages.push(...hookResult.messages);

  return {
    runtime: "claude",
    action: "install",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [path.join(claudeDir, "mcp.json"), pluginPath],
    commands,
    messages,
  };
}

export async function uninstallClaude(options: HostOperationOptions): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const commands = ["claude mcp remove oms", "claude plugin uninstall oms"];
  const messages = ["Claude Code uninstall removes the Oh My Second Brain MCP entry and, when requested, asks Claude CLI to uninstall the plugin."];
  let changed = await removeClaudeMcp(options, claudeDir);

  const hookResult = await removeClaudeHooks(options, claudeDir);
  changed = hookResult.changed || changed;
  messages.push(...hookResult.messages);

  if (options.executeExternal && commandExists("claude") && !options.dryRun) {
    const externalCommands: [string, ...string[]][] = [
      ["claude", "mcp", "remove", "oms"],
      ["claude", "plugin", "uninstall", "oms"],
    ];
    for (const [command, ...args] of externalCommands) {
      const result = runExternal(command, args);
      messages.push(result.ok ? `Executed: ${result.message}` : `External command failed: ${result.message}`);
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
  };
}
