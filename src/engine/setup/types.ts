/**
 * Local setup types for M5 Socratic setup interview.
 *
 * PARALLEL-SAFETY: These types are LOCAL to src/engine/setup/.
 * Do NOT import from src/engine/types.ts (read-only per plan).
 * Do NOT import from src/engine/{embed,graph,retrieval,index,compile,distill,wiki}/ (read-only per R18).
 */

/**
 * The four Socratic scoring sub-dimensions.
 * Self-reimplemented from the omc deep-interview methodology — method only, no code copied.
 */
export type ScoringSubDimension = "goal" | "constraint" | "criteria" | "context";

/**
 * Score map across all four scoring sub-dimensions.
 * Each value is in [0, 1] — 1 means fully resolved, 0 means completely ambiguous.
 */
export type DimensionScore = Record<ScoringSubDimension, number>;

/** The exactly 6 binding dimensions resolved by the setup interview. */
export type BindingDimension =
  | "tier_folder_mapping"
  | "provenance_grade_mapping"
  | "lint_schema_ssot"
  | "embedder_selection"
  | "ignore_for_external_apis"
  | "agent_writable_zone";

/** All 6 binding dimensions in canonical order (D1–D6). */
export const BINDING_DIMENSIONS: readonly BindingDimension[] = [
  "tier_folder_mapping",
  "provenance_grade_mapping",
  "lint_schema_ssot",
  "embedder_selection",
  "ignore_for_external_apis",
  "agent_writable_zone",
] as const;

/** Configuration for the Socratic interview loop. */
export interface InterviewConfig {
  /**
   * Ambiguity threshold below which a dimension is considered resolved.
   * Default: 0.20 (5% below this = confidently resolved).
   */
  ambiguityThreshold: number;
  /** Maximum Socratic exchange rounds per binding dimension. Default: 5. */
  maxRoundsPerDimension: number;
}

/** Default interview configuration. Threshold and max rounds are configurable. */
export const DEFAULT_INTERVIEW_CONFIG: InterviewConfig = {
  ambiguityThreshold: 0.2,
  maxRoundsPerDimension: 5,
} as const;

/** Canonical tier for a vault folder (D1). */
export type Tier = "raw" | "processed" | "wiki";

/** Provenance grade for a vault folder (D2). */
export type ProvenanceGrade = "authored" | "curated" | "external-raw";

/** Resolved folder entry combining D1 (tier) and D2 (provenance). */
export interface FolderMapping {
  intent: string;
  tier: Tier;
  provenance: ProvenanceGrade;
  concept: string | null;
}

/** Lint schema SSOT location (D3). */
export type LintSchemaSSOT = "engine_default" | "vault_override";

/** Embedder provider options (D4). */
export type EmbedderProvider = "local" | "openai" | "stub";

/** Write routing law for agent-writable zone (D6). */
export type WriteRoutingLaw = "append_only" | "overwrite_allowed" | "create_only";

/**
 * The fully-resolved taxonomy output of the setup interview.
 *
 * Non-Sticky Guard (HARD): this value is written ONLY to vault/.oms/taxonomy.yaml.
 * NEVER written to core/ontology/taxonomy.yaml or any engine path.
 * See src/engine/setup/writer.ts for enforcement.
 */
export interface TaxonomyOutput {
  version: 1;
  folders: Record<string, FolderMapping>;
  lint: { schema_ssot: LintSchemaSSOT };
  embedder: { provider: EmbedderProvider; model: string };
  ignore_for_external_apis: string[];
  agent_writable_zone: string[];
  write_routing_law: WriteRoutingLaw;
}
