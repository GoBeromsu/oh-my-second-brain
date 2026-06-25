import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { resolveHostAdapterSource } from "./adapter-source.js";
import { hostHome, isRecord, mcpServerEntry, readYamlObject, replaceDirectory, writeYamlObject } from "./common.js";
import type { HostOperationOptions, HostOperationResult } from "./types.js";

const HERMES_SKILL_CATEGORY = "knowledge-management";
const HERMES_SKILL_NAME = "oms";

async function upsertHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  const data = await readYamlObject(hermesConfig);
  const rawServers = data["mcp_servers"];
  const servers = isRecord(rawServers) ? rawServers : {};
  servers["oms"] = { ...mcpServerEntry(options), enabled: true };
  data["mcp_servers"] = servers;
  return writeYamlObject(hermesConfig, data, Boolean(options.dryRun));
}

async function removeHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  const data = await readYamlObject(hermesConfig);
  const rawServers = data["mcp_servers"];
  if (!isRecord(rawServers) || !("oms" in rawServers)) return false;
  delete rawServers["oms"];
  data["mcp_servers"] = rawServers;
  return writeYamlObject(hermesConfig, data, Boolean(options.dryRun));
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
  if (!options.dryRun) {
    await rm(legacyPluginTarget, { recursive: true, force: true });
    await rm(legacyMcpPath, { force: true });
    await replaceDirectory(pluginSource, adapterTarget, false);
    await replaceDirectory(skillSource, skillTarget, false);
    await upsertHermesMcp(options, configPath);
  }
  return {
    runtime: "hermes",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [`Hermes MCP config: ${configPath}`],
    messages: ["Installed Hermes-native Oh My Second Brain skill bundle and registered mcp_servers.oms in ~/.hermes/config.yaml."],
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
