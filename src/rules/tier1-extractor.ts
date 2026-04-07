import type { EnforcementRule, OmsbConfig } from "./types.js";

/**
 * Slugify a string for use in rule IDs.
 * Lowercases, replaces spaces/slashes/dots with hyphens, strips non-alphanumeric.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[/\\.]/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract Tier 1 EnforcementRules from the validated OmsbConfig.
 * All rules carry source: { file: "omsb.config.json", tier: 1 }.
 */
export function extractTier1Rules(config: OmsbConfig): EnforcementRule[] {
  const rules: EnforcementRule[] = [];
  const sourceFile = "omsb.config.json";

  // path-boundary rules from raw_paths
  for (const rawPath of config.rules.raw_paths) {
    const id = `raw-boundary-${slugify(rawPath)}`;
    rules.push({
      id,
      type: "path-boundary",
      severity: config.enforcement.raw_boundary,
      config: { path: rawPath },
      source: { file: sourceFile, tier: 1 },
    });
  }

  // path-boundary-exception rule from raw_path_exceptions
  if (config.rules.raw_path_exceptions) {
    const exc = config.rules.raw_path_exceptions;
    rules.push({
      id: "raw-boundary-exception",
      type: "path-boundary-exception",
      severity: config.enforcement.raw_boundary,
      config: {
        allowed_fields: exc.allowed_fields ?? [],
        allowed_ops: exc.allowed_ops ?? [],
      },
      source: { file: sourceFile, tier: 1 },
    });
  }

  // frontmatter-required rules
  for (const field of config.rules.frontmatter_required ?? []) {
    const id = `fm-required-${slugify(field)}`;
    rules.push({
      id,
      type: "frontmatter-required",
      severity: config.enforcement.frontmatter,
      config: { field },
      source: { file: sourceFile, tier: 1 },
    });
  }

  // frontmatter-value rules
  for (const [field, spec] of Object.entries(config.rules.frontmatter_values ?? {})) {
    const id = `fm-value-${slugify(field)}`;
    rules.push({
      id,
      type: "frontmatter-value",
      severity: config.enforcement.frontmatter,
      config: { field, ...spec },
      source: { file: sourceFile, tier: 1 },
    });
  }

  // naming-convention rules
  for (const [key, spec] of Object.entries(config.rules.naming_conventions ?? {})) {
    const id = `naming-${slugify(key)}`;
    rules.push({
      id,
      type: "naming-convention",
      severity: config.enforcement.naming,
      config: { key, pattern: spec.pattern },
      source: { file: sourceFile, tier: 1 },
    });
  }

  return rules;
}
