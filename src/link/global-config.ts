import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { expandHome } from "./link.js";

export interface GlobalConfig {
  version: number;
  vault: string;
}

/**
 * Read the global Obsidian vault target config from `<homeDir>/.oms/config.yaml`.
 * Returns `null` only when the file is missing (ENOENT).
 * A present-but-invalid file throws a loud actionable error naming the config file path:
 *   - bad YAML syntax
 *   - not a mapping
 *   - missing or empty `vault` string
 *   - bare relative `vault` value (would resolve against process cwd)
 * The `vault` value is expanded if it starts with `~`, using the existing `expandHome`.
 * `version` defaults to 1 when absent or non-number.
 */
export async function readGlobalConfig(homeDir?: string): Promise<GlobalConfig | null> {
  const home = homeDir ?? os.homedir();
  const configPath = path.join(home, ".oms", "config.yaml");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: Record<string, unknown> | null;
  try {
    parsed = yamlParse(raw) as Record<string, unknown> | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[oms] Invalid global config at ${configPath}: config.yaml is not valid YAML (${message}). Run oms setup to repair it.`,
    );
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[oms] Invalid global config at ${configPath}: expected a YAML mapping with vault and version.`,
    );
  }

  const vault = parsed["vault"];
  if (typeof vault !== "string" || vault.trim().length === 0) {
    throw new Error(
      `[oms] Invalid global config at ${configPath}: missing required string field "vault". Run oms setup to register a vault.`,
    );
  }

  const vaultTrimmed = vault.trim();
  // Reject bare relative paths (e.g. ../notes). Must be absolute or ~/...
  if (!path.isAbsolute(vaultTrimmed) && !vaultTrimmed.startsWith("~")) {
    throw new Error(
      `[oms] Invalid global config at ${configPath}: vault must be an absolute path or ~/..., not a relative path like "${vaultTrimmed}". Run oms setup to register an absolute vault path.`,
    );
  }

  const expandedVault = expandHome(vaultTrimmed);

  return {
    version: typeof parsed["version"] === "number" ? parsed["version"] : 1,
    vault: expandedVault,
  };
}

/**
 * Write the global Obsidian vault target config to `<homeDir>/.oms/config.yaml`.
 * Creates the `.oms` directory recursively if needed.
 * Returns the absolute path to the written config file.
 */
export async function writeGlobalConfig(config: GlobalConfig, homeDir?: string): Promise<string> {
  const home = homeDir ?? os.homedir();
  const omsDir = path.join(home, ".oms");
  const configPath = path.join(omsDir, "config.yaml");

  await mkdir(omsDir, { recursive: true });
  await writeFile(configPath, yamlStringify(config), "utf-8");

  return configPath;
}
