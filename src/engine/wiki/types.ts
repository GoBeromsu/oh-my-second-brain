/**
 * Wiki-local types for M3.
 *
 * LOCAL to src/engine/wiki/. Do NOT add to any shared types file.
 */

// ---------------------------------------------------------------------------
// Staleness FSM
// ---------------------------------------------------------------------------

/**
 * 5-state staleness FSM for wiki pages.
 *
 * Transitions:
 *   source SHA change  → DIRTY
 *   compile produces page → CLEAN
 *   referenced page has no compile output → STUB
 *   page with no incoming links → ORPHAN
 *   two compile sources produce conflicting content → CONFLICT
 *
 * Full-rebuild escape hatch: delete .llmwiki/staleness.json → every page resets to DIRTY.
 */
export type StalenessState =
  | "CLEAN"    // compile output matches current sources; page is up-to-date
  | "DIRTY"    // source SHA changed; page needs recompile
  | "STUB"     // referenced page has no compile output yet
  | "ORPHAN"   // page has no incoming links (zero backlinks)
  | "CONFLICT"; // two compile sources produced conflicting content for the same concept

/** Per-concept ledger entry. */
export interface LedgerEntry {
  state: StalenessState;
  /** ISO-8601 timestamp of the last state transition. */
  updatedAt: string;
  /** Conflict description — set only for CONFLICT state. */
  conflictNote?: string;
}

/** The full staleness ledger, persisted as JSON. */
export type StalenessLedger = Record<string, LedgerEntry>;

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/** Result of processing a cascade's affected backlinks. */
export interface CascadeFlipResult {
  /** Concept IDs that were flipped from CLEAN to DIRTY. */
  flipped: string[];
}

// ---------------------------------------------------------------------------
// Link closure
// ---------------------------------------------------------------------------

/** Result of a link-graph closure check. */
export interface LinkClosureResult {
  /** Wikilinks that point to pages without compile output in wiki/. */
  dangling: string[];
  /** True if all wikilinks resolve to existing pages. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export type LintTier = "auto-fix" | "report-only";

export type LintKind =
  | "index-inconsistency"
  | "broken-link"
  | "missing-see-also"
  | "factual-contradiction"
  | "outdated-ref"
  | "orphan-page";

export interface LintFinding {
  tier: LintTier;
  kind: LintKind;
  pageId: string;
  message: string;
}

export interface LintResult {
  autoFixed: LintFinding[];
  reported: LintFinding[];
}

// ---------------------------------------------------------------------------
// Clock injection
// ---------------------------------------------------------------------------

/** Injected clock function — returns ISO-8601 string. Never call Date.now() directly. */
export type NowFn = () => string;
