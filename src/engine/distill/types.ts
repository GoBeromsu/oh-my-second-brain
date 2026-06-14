/**
 * Local types for the distill module (M4 — C6 Distill).
 *
 * IMPORTANT: Do NOT touch src/engine/types.ts (shared contract).
 * This file owns all distill-specific types exclusively.
 * No imports from src/engine/compile/ or src/engine/wiki/.
 */

// ---------------------------------------------------------------------------
// Analyzer result schema
// ---------------------------------------------------------------------------

/** A single candidate pattern identified in the target. */
export interface DistillPattern {
  /**
   * Path to the file where the pattern appears.
   * Use vault-relative paths for repo targets; "document" for flat text targets.
   */
  file: string;
  /** Line number (1-based). 0 if the target is a flat document with no line structure. */
  line: number;
  /** Human-readable description of the pattern and why it is worth absorbing. */
  description: string;
  /** Confidence that this pattern should be absorbed (0.0–1.0). */
  absorb_confidence: number;
}

/** A risk or red-flag identified during adversarial analysis. */
export interface DistillRisk {
  /** Human-readable description of the risk. */
  description: string;
  /** Severity tier. */
  severity: "low" | "medium" | "high" | "critical";
}

/**
 * Attribution memo for ACKNOWLEDGMENTS.md.
 * This is a record-keeping entry — NOT a license gate.
 */
export interface DistillAttribution {
  /** Name or identifier of the source repo/document. */
  repo: string;
  /** URL to the canonical source. Empty string if unavailable. */
  url: string;
  /** License note (informational only; legal review is a human step). */
  license_note: string;
}

/**
 * Structured result from the red-team adversarial analyzer.
 *
 * Strict JSON schema:
 * { patterns: [{file, line, description, absorb_confidence}],
 *   risks: [{description, severity}],
 *   attribution: {repo, url, license_note} }
 */
export interface AnalyzerResult {
  patterns: DistillPattern[];
  risks: DistillRisk[];
  attribution: DistillAttribution;
}

// ---------------------------------------------------------------------------
// Target (input)
// ---------------------------------------------------------------------------

/**
 * An inert target loaded as read-only text for analysis.
 * Content is NEVER executed — treated as data only.
 */
export interface DistillTarget {
  /** Human-readable name for the target (used in the report and attribution). */
  name: string;
  /**
   * The content to analyze.
   * Must be provided as a plain string — no live execution, no tool calls.
   */
  content: string;
  /** Optional canonical URL or filesystem path for attribution. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Clean-room spec
// ---------------------------------------------------------------------------

/**
 * Invocation spec produced by prepareCleanRoom().
 *
 * This is a pure data structure — the actual subagent spawn is the caller's
 * responsibility.  The spec carries everything a throwaway subagent needs to
 * perform the analysis in a clean context.
 */
export interface CleanRoomSpec {
  /** System prompt establishing the clean-room context and output schema. */
  systemPrompt: string;
  /** User content block — target loaded as inert text. */
  userContent: string;
  /** Name of the target being analyzed (for attribution and logging). */
  targetName: string;
  /**
   * Raw target content preserved verbatim.
   * Kept separate from userContent so mutation-detection can SHA-compare
   * the original content before and after the distill run.
   */
  targetContent: string;
}
