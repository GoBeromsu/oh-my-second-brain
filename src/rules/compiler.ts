import * as fs from "node:fs";
import * as path from "node:path";
import type { OmsbConfig, RuleManifest } from "./types.js";
import { extractTier1Rules } from "./tier1-extractor.js";
import { extractTier2Rules } from "./tier2-extractor.js";

const OMSB_DIR = ".omsb";
const RULES_FILENAME = "rules.json";

/**
 * Collect modification times (ms since epoch) for a set of file paths.
 * Missing files are recorded as 0.
 */
function collectMtimes(filePaths: string[]): Record<string, number> {
  const mtimes: Record<string, number> = {};
  for (const fp of filePaths) {
    try {
      const stat = fs.statSync(fp);
      mtimes[fp] = stat.mtimeMs;
    } catch {
      mtimes[fp] = 0;
    }
  }
  return mtimes;
}

/**
 * Compile all rules from Tier 1 (omsb.config.json) and Tier 2 (guideline files)
 * into a single RuleManifest.
 *
 * @param config   - Validated OmsbConfig
 * @param vaultPath - Absolute path to the vault root (used to resolve guideline paths)
 */
export function compileRules(config: OmsbConfig, vaultPath: string): RuleManifest {
  const tier1Rules = extractTier1Rules(config);

  const guidelinesRoot = config.guidelines.root
    ? path.resolve(vaultPath, config.guidelines.root)
    : vaultPath;

  const tier2Rules = extractTier2Rules(guidelinesRoot, config.guidelines.files);

  // Collect source files for staleness detection
  const configPath = path.join(vaultPath, "omsb.config.json");
  const guidelineAbsPaths = config.guidelines.files.map((f) =>
    path.resolve(guidelinesRoot, f)
  );

  const source_mtimes = collectMtimes([configPath, ...guidelineAbsPaths]);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source_mtimes,
    rules: [...tier1Rules, ...tier2Rules],
  };
}

/**
 * Write a RuleManifest to <vaultPath>/.omsb/rules.json.
 * Creates the .omsb directory if it does not exist.
 */
export function writeRuleManifest(manifest: RuleManifest, vaultPath: string): void {
  const omsbDir = path.join(vaultPath, OMSB_DIR);
  try {
    fs.mkdirSync(omsbDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to create directory "${omsbDir}": ${msg}`);
  }

  const rulesPath = path.join(omsbDir, RULES_FILENAME);
  try {
    fs.writeFileSync(rulesPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to write rules manifest to "${rulesPath}": ${msg}`);
  }
}

/**
 * Read an existing RuleManifest from <vaultPath>/.omsb/rules.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readRuleManifest(vaultPath: string): RuleManifest | null {
  const rulesPath = path.join(vaultPath, OMSB_DIR, RULES_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(rulesPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as RuleManifest;
    // Basic sanity check
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
