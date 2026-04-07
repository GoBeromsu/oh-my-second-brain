import * as fs from "node:fs";
import * as path from "node:path";
import { validateConfig } from "./schema.js";
import type { OmsbConfig } from "../rules/types.js";

const CONFIG_FILENAME = "omsb.config.json";

/**
 * Walk up the directory tree from startDir looking for omsb.config.json.
 * Returns the absolute path to the config file, or null if not found.
 */
export function findConfig(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root — config not found
      return null;
    }
    current = parent;
  }
}

/**
 * Read, parse, and validate the config at configPath.
 * Throws on missing file, JSON parse errors, or validation failures.
 */
export function loadConfig(configPath: string): OmsbConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to read config at "${configPath}": ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: invalid JSON in config at "${configPath}": ${msg}`);
  }

  try {
    return validateConfig(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: config validation failed at "${configPath}": ${msg}`);
  }
}
