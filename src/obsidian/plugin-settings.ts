import * as fs from "node:fs";
import * as path from "node:path";
import type { ManagedPluginConfig } from "../rules/types.js";
import { writeProposal } from "../proposals/writer.js";

export interface PluginSettingsChangePolicy {
  guidelineExplicit: boolean;
}

export interface ManagedPluginSettingsResult {
  mode: "auto-apply" | "approval-required" | "no-op";
  pluginId: string;
  dataPath: string;
  changedKeys: string[];
  proposalPath?: string;
}

export function resolveManagedPluginDataPath(
  vaultPath: string,
  plugin: ManagedPluginConfig,
): string {
  const configured = plugin.data_json_path;
  if (configured !== undefined && configured.length > 0) {
    const normalized = configured.replace(/\\/g, "/");
    const expected = `.obsidian/plugins/${plugin.id}/data.json`;
    if (path.isAbsolute(normalized) || normalized !== expected) {
      throw new Error(
        `omsb plugin-settings: managed plugin path must be ${expected}`,
      );
    }
    return path.join(vaultPath, normalized);
  }

  return path.join(vaultPath, ".obsidian", "plugins", plugin.id, "data.json");
}

export function readManagedPluginData(
  vaultPath: string,
  plugin: ManagedPluginConfig,
): Record<string, unknown> {
  const dataPath = resolveManagedPluginDataPath(vaultPath, plugin);
  try {
    const raw = fs.readFileSync(dataPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeManagedPluginData(
  vaultPath: string,
  plugin: ManagedPluginConfig,
  data: Record<string, unknown>,
): string {
  const dataPath = resolveManagedPluginDataPath(vaultPath, plugin);
  const expectedDir = path.join(vaultPath, ".obsidian", "plugins", plugin.id);
  const resolvedDir = path.dirname(dataPath);
  if (path.basename(dataPath) !== "data.json" || resolvedDir !== expectedDir) {
    throw new Error("omsb plugin-settings: only plugin-owned data.json is writable");
  }

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return dataPath;
}

export function classifyPluginSettingsChange(
  policy: PluginSettingsChangePolicy,
): "auto-apply" | "approval-required" {
  return policy.guidelineExplicit ? "auto-apply" : "approval-required";
}

export function diffManagedPluginData(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([
    ...Object.keys(current),
    ...Object.keys(desired),
  ]);

  return [...keys]
    .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(desired[key]))
    .sort();
}

function buildPluginSettingsProposal(
  plugin: ManagedPluginConfig,
  changedKeys: string[],
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): string {
  return [
    `# Plugin Settings Proposal: ${plugin.id}`,
    "",
    "These setting changes require approval before OMSB updates the plugin-owned `data.json`.",
    "",
    `Changed keys: ${changedKeys.join(", ") || "none"}`,
    "",
    "## Current",
    "```json",
    JSON.stringify(current, null, 2),
    "```",
    "",
    "## Desired",
    "```json",
    JSON.stringify(desired, null, 2),
    "```",
    "",
  ].join("\n");
}

export function syncManagedPluginData(
  vaultPath: string,
  plugin: ManagedPluginConfig,
  desired: Record<string, unknown>,
  policy: PluginSettingsChangePolicy,
  slug = plugin.id,
): ManagedPluginSettingsResult {
  const dataPath = resolveManagedPluginDataPath(vaultPath, plugin);
  const current = readManagedPluginData(vaultPath, plugin);
  const changedKeys = diffManagedPluginData(current, desired);

  if (changedKeys.length === 0) {
    return {
      mode: "no-op",
      pluginId: plugin.id,
      dataPath,
      changedKeys: [],
    };
  }

  const mode = classifyPluginSettingsChange(policy);
  if (mode === "auto-apply") {
    writeManagedPluginData(vaultPath, plugin, desired);
    return {
      mode,
      pluginId: plugin.id,
      dataPath,
      changedKeys,
    };
  }

  const proposalPath = writeProposal(
    vaultPath,
    `${slug}-plugin-settings`,
    buildPluginSettingsProposal(plugin, changedKeys, current, desired),
  );

  return {
    mode,
    pluginId: plugin.id,
    dataPath,
    changedKeys,
    proposalPath,
  };
}
