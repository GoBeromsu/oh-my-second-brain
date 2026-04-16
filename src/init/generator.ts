import * as fs from "node:fs";
import * as path from "node:path";
import type { OmsbConfig, EnforcementRule, RuleManifest } from "../rules/types.js";
import { defaultRuntimeEnforcementConfigGovernance } from "../rules/types.js";
import { validateConfig } from "../config/schema.js";
import { compileRules, writeRuleManifest, readRuleManifest } from "../rules/compiler.js";

export interface InitOptions {
  vaultPath: string;
  vaultName: string;
  guidelineRoot: string;
  guidelineFiles: string[];
  guidelineRequirements?: Array<"folder" | "frontmatter">;
  guidelineDomains?: Partial<Record<"folder" | "frontmatter", string>>;
  rawPaths: string[];
  frontmatterRequired: string[];
  inboxFallback?: string;
  managedPlugins?: Array<{ id: string; data_json_path?: string }>;
}

function inferGuidelineDomains(
  guidelineFiles: string[],
): Partial<Record<"folder" | "frontmatter", string>> {
  const domains: Partial<Record<"folder" | "frontmatter", string>> = {};

  for (const file of guidelineFiles) {
    const lower = path.basename(file).toLowerCase();
    if (domains.folder === undefined && lower.includes("folder")) {
      domains.folder = file;
    }
    if (domains.frontmatter === undefined && lower.includes("frontmatter")) {
      domains.frontmatter = file;
    }
  }

  return domains;
}

/**
 * Generate omsb.config.json at the vault root.
 */
export async function generateConfig(opts: InitOptions): Promise<void> {
  const config: OmsbConfig = {
    version: 1,
    vault_path: opts.vaultPath,
    vault_name: opts.vaultName,
    governance: {
      runtime_enforcement: defaultRuntimeEnforcementConfigGovernance(),
    },
    guidelines: {
      root: opts.guidelineRoot,
      files: opts.guidelineFiles,
      required: opts.guidelineRequirements ?? ["folder", "frontmatter"],
      domains: opts.guidelineDomains ?? inferGuidelineDomains(opts.guidelineFiles),
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
    routing: {
      inbox_fallback: opts.inboxFallback ?? "Inbox",
    },
    managed_plugins: opts.managedPlugins,
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
 * Format a single enforcement rule into a human-readable summary line.
 */
export function formatRuleSummary(rule: EnforcementRule): string {
  const severity = rule.severity.toUpperCase();
  const cfg = rule.config;

  switch (rule.type) {
    case "path-boundary":
      return `- [${severity}] ${rule.id}: ${String(cfg.path ?? "")} is read-only`;
    case "path-boundary-exception":
      return `- [${severity}] ${rule.id}: Exception — allowed fields: ${
        Array.isArray(cfg.allowed_fields) ? cfg.allowed_fields.join(", ") : "none"
      }, allowed ops: ${
        Array.isArray(cfg.allowed_ops) ? cfg.allowed_ops.join(", ") : "none"
      }`;
    case "frontmatter-required":
      return `- [${severity}] ${rule.id}: Field "${String(cfg.field ?? "")}" required in frontmatter`;
    case "frontmatter-value":
      return `- [${severity}] ${rule.id}: Field "${String(cfg.field ?? "")}" must match constraint${
        cfg.enum ? ` (enum: ${String(cfg.enum)})` : ""
      }${cfg.format ? ` (format: ${String(cfg.format)})` : ""}`;
    case "naming-convention":
      return `- [${severity}] ${rule.id}: Files matching "${String(cfg.glob ?? "")}" must follow pattern "${String(cfg.pattern ?? "")}"`;
    default:
      return `- [${severity}] ${rule.id}: ${rule.type}`;
  }
}

/**
 * Generate .omsb/CLAUDE.md with dynamic rule summaries and guideline @file references.
 * Creates/updates .claude/CLAUDE.md to include an @file reference to .omsb/CLAUDE.md.
 *
 * Both operations are idempotent — safe to run multiple times.
 */
export async function generateClaudeMd(
  vaultPath: string,
  guidelineRoot: string,
  guidelineFiles: string[],
  manifest?: RuleManifest | null
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

  // Read config for vault context
  let config: OmsbConfig | null = null;
  try {
    const raw = fs.readFileSync(path.join(vaultPath, "omsb.config.json"), "utf-8");
    config = JSON.parse(raw) as OmsbConfig;
  } catch {
    // Config not available yet — use fallback
  }

  // Read rules.json if not provided
  const rules = manifest ?? readRuleManifest(vaultPath);

  // Build vault context section
  const vaultName = config?.vault_name ?? path.basename(vaultPath);
  const rawPaths = config?.rules?.raw_paths ?? [];

  const vaultContext = [
    `**Vault:** ${vaultName}`,
    rawPaths.length > 0
      ? `**Read-only paths:** ${rawPaths.join(", ")}`
      : null,
  ].filter(Boolean);

  const hierarchySummary = [
    "- Human guideline docs in the configured guideline folder are authoritative for runtime enforcement.",
    "- `omsb.config.json` stores vault-scoped mappings and Tier 1 operational inputs.",
    "- `.omsb/rules.json` is a generated runtime artifact and does not outrank the guidelines.",
  ].join("\n");

  // Build rule summaries sorted by severity (block → deny → advisory)
  let ruleSummaries: string;
  if (rules && rules.rules.length > 0) {
    const order: Record<string, number> = { block: 0, deny: 1, advisory: 2 };
    const sorted = [...rules.rules].sort(
      (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
    );
    ruleSummaries = sorted.map(formatRuleSummary).join("\n");
  } else {
    // Fallback to config-based summaries
    const lines: string[] = [];
    if (rawPaths.length > 0) {
      lines.push(`- [${(config?.enforcement?.raw_boundary ?? "deny").toUpperCase()}] Raw sources (${rawPaths.join(", ")}) are read-only`);
    }
    const reqFields = config?.rules?.frontmatter_required ?? [];
    if (reqFields.length > 0) {
      lines.push(`- [${(config?.enforcement?.frontmatter ?? "advisory").toUpperCase()}] Frontmatter fields ${reqFields.join(", ")} are required`);
    }
    ruleSummaries = lines.length > 0 ? lines.join("\n") : "- No rules compiled yet. Run /omsb init to generate rules.";
  }

  // Build guideline references
  const fileRefs = guidelineFiles
    .map((f) => `@${guidelineRoot}/${f}`)
    .join("\n");

  const omsbClaudeMd = [
    "# OMSB Vault Guidelines",
    "",
    "This vault is managed by oh-my-second-brain. AI operations are structurally enforced.",
    "",
    ...vaultContext,
    "",
    "## Runtime Source Hierarchy",
    hierarchySummary,
    "",
    "## Enforcement Rules",
    ruleSummaries,
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
