import * as fs from "node:fs";
import * as path from "node:path";
import type { ManagedPluginConfig } from "../rules/types.js";

export interface PluginSettingsChangePolicy {
  guidelineExplicit: boolean;
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
