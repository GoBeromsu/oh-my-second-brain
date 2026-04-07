import * as fs from "node:fs";
import * as path from "node:path";
import type { OmsbConfig } from "../rules/types.js";
import { validateConfig } from "../config/schema.js";
import { compileRules, writeRuleManifest } from "../rules/compiler.js";

export interface InitOptions {
  vaultPath: string;
  vaultName: string;
  guidelineRoot: string;
  guidelineFiles: string[];
  rawPaths: string[];
  frontmatterRequired: string[];
}

/**
 * Generate omsb.config.json at the vault root.
 */
export async function generateConfig(opts: InitOptions): Promise<void> {
  const config: OmsbConfig = {
    version: 1,
    vault_path: opts.vaultPath,
    vault_name: opts.vaultName,
    guidelines: {
      root: opts.guidelineRoot,
      files: opts.guidelineFiles,
    },
    rules: {
      raw_paths: opts.rawPaths,
      frontmatter_required: opts.frontmatterRequired.length > 0
        ? opts.frontmatterRequired
        : undefined,
    },
    enforcement: {
      raw_boundary: "deny",
      frontmatter: "advisory",
      naming: "advisory",
    },
  };

  const configPath = path.join(opts.vaultPath, "omsb.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to write config to "${configPath}": ${msg}`);
  }
}

/**
 * Load existing omsb.config.json, run the rule compiler, and write .omsb/rules.json.
 */
export async function generateRules(vaultPath: string): Promise<void> {
  const configPath = path.join(vaultPath, "omsb.config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to read config at "${configPath}": ${msg}`);
  }

  let config: OmsbConfig;
  try {
    config = validateConfig(JSON.parse(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: invalid JSON in config at "${configPath}": ${msg}`);
  }

  const manifest = compileRules(config, vaultPath);
  writeRuleManifest(manifest, vaultPath);
}

/**
 * Generate .omsb/CLAUDE.md with guideline @file references.
 * Creates/updates .claude/CLAUDE.md to include an @file reference to .omsb/CLAUDE.md.
 *
 * Both operations are idempotent — safe to run multiple times.
 */
export async function generateClaudeMd(
  vaultPath: string,
  guidelineRoot: string,
  guidelineFiles: string[]
): Promise<void> {
  const omsbDir = path.join(vaultPath, ".omsb");
  const claudeDir = path.join(vaultPath, ".claude");

  // Ensure directories exist
  try {
    fs.mkdirSync(omsbDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to create directories: ${msg}`);
  }

  // Build .omsb/CLAUDE.md content using simple string template
  const rawPathsNote = "(see omsb.config.json for raw_paths)";
  const fieldsNote = "(see omsb.config.json for frontmatter_required)";

  const fileRefs = guidelineFiles
    .map((f) => `@${guidelineRoot}/${f}`)
    .join("\n");

  const omsbClaudeMd = [
    "# OMSB Vault Guidelines",
    "",
    "This vault is managed by oh-my-second-brain. AI operations are structurally enforced.",
    "",
    "## Enforcement Rules",
    `- Raw sources (${rawPathsNote}) are read-only`,
    `- Frontmatter fields ${fieldsNote} are required`,
    "- See guidelines below for full rules",
    "",
    "## Guidelines",
    fileRefs,
    "",
  ].join("\n");

  const omsbClaudeMdPath = path.join(omsbDir, "CLAUDE.md");
  try {
    fs.writeFileSync(omsbClaudeMdPath, omsbClaudeMd, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`omsb: failed to write ".omsb/CLAUDE.md": ${msg}`);
  }

  // Update .claude/CLAUDE.md with @file reference — never overwrite existing content
  const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  const omsbReference = "@file .omsb/CLAUDE.md";

  let existingContent: string | null = null;
  try {
    existingContent = fs.readFileSync(claudeMdPath, "utf-8");
  } catch {
    // File doesn't exist — will create it
  }

  if (existingContent === null) {
    // Create new file with just the reference
    try {
      fs.writeFileSync(claudeMdPath, omsbReference + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`omsb: failed to create ".claude/CLAUDE.md": ${msg}`);
    }
  } else if (!existingContent.includes(omsbReference)) {
    // Append reference without overwriting existing content
    const appended = existingContent.trimEnd() + "\n\n" + omsbReference + "\n";
    try {
      fs.writeFileSync(claudeMdPath, appended, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`omsb: failed to update ".claude/CLAUDE.md": ${msg}`);
    }
  }
  // If already contains reference: skip (idempotent)
}
