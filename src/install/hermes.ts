import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { resolveHostAdapterSource } from "./adapter-source.js";
import { editYamlEntryPreservingComments, hostHome, mcpServerEntry, replaceDirectory } from "./common.js";
import type { HostOperationOptions, HostOperationResult } from "./types.js";

const HERMES_SKILL_CATEGORY = "knowledge-management";
const HERMES_SKILL_NAME = "oms";

const HERMES_MCP_ENTRY_PATH = ["mcp_servers", "oms"] as const;

async function upsertHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  if (options.dryRun) return false;
  return editYamlEntryPreservingComments(hermesConfig, HERMES_MCP_ENTRY_PATH, {
    kind: "set",
    value: { ...mcpServerEntry(options), enabled: true },
  });
}

async function removeHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  if (options.dryRun) return false;
  return editYamlEntryPreservingComments(hermesConfig, HERMES_MCP_ENTRY_PATH, { kind: "delete" });
}

export async function installHermes(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const pluginSource = resolveHostAdapterSource(options.adapterRoot, host);
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const skillSource = path.join(pluginSource, "skills");
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const configPath = path.join(hermesDir, "config.yaml");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  const messages = ["Installed Hermes-native Oh My Second Brain skill bundle and registered mcp_servers.oms in ~/.hermes/config.yaml."];
  if (!options.dryRun) {
    await rm(legacyPluginTarget, { recursive: true, force: true });
    await rm(legacyMcpPath, { force: true });
    await replaceDirectory(pluginSource, adapterTarget, false);
    await replaceDirectory(skillSource, skillTarget, false);
    if (!(await upsertHermesMcp(options, configPath))) {
      messages.push(`WARNING: ${configPath} is not a supported YAML mapping; mcp_servers.oms was not registered. Add it manually.`);
    }
  }
  return {
    runtime: "hermes",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [`Hermes MCP config: ${configPath}`],
    messages,
  };
}

export async function uninstallHermes(options: HostOperationOptions): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const configPath = path.join(hermesDir, "config.yaml");
  let changed = false;
  if (existsSync(configPath)) changed = (await removeHermesMcp(options, configPath)) || changed;
  for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath]) {
    if (existsSync(target)) {
      changed = true;
      if (!options.dryRun) await rm(target, { recursive: true, force: true });
    }
  }
  return {
    runtime: "hermes",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [],
    messages: ["Removed Hermes Oh My Second Brain skill bundle, adapter copy, legacy descriptor files, and mcp_servers.oms."],
  };
}
