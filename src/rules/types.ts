export interface EnforcementRule {
  id: string;
  type: "path-boundary" | "path-boundary-exception" | "frontmatter-required" | "frontmatter-value" | "naming-convention";
  severity: "block" | "deny" | "advisory";
  config: Record<string, unknown>;
  source: {
    file: string;
    line?: number;
    tier: 1 | 2 | 3;
  };
}

export interface RuleManifest {
  version: 1;
  generated_at: string;
  source_mtimes: Record<string, number>;
  rules: EnforcementRule[];
}

export interface OmsbConfig {
  version: 1;
  vault_path: string;
  vault_name: string;
  guidelines: {
    root: string;
    files: string[];
  };
  rules: {
    raw_paths: string[];
    raw_path_exceptions?: {
      allowed_fields?: string[];
      allowed_ops?: string[];
    };
    frontmatter_required?: string[];
    frontmatter_values?: Record<string, { enum?: string[]; format?: string; case?: string; no_spaces?: boolean }>;
    naming_conventions?: Record<string, { pattern: string }>;
  };
  enforcement: {
    raw_boundary: "block" | "deny" | "advisory";
    frontmatter: "block" | "deny" | "advisory";
    naming: "block" | "deny" | "advisory";
  };
  authorship?: {
    enabled: boolean;
    agent_name: string;
    created_by_field: string;
    modified_by_field: string;
  };
  compile?: {
    sources: string[];
    terminology_dir?: string;
    outputs: {
      wiki?: string;
      article?: string;
    };
  };
}
