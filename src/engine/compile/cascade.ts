/**
 * Lucasastorian cascade return.
 *
 * Terminology absorbed from lucasastorian/llmwiki (concept-only, see
 * ACKNOWLEDGMENTS.partial.md).
 *
 * Every compile write returns { affected_backlinks: string[] } — the list of
 * wiki pages that link TO the compiled concept page.  The M3 caller uses this
 * to schedule staleness updates: affected pages are marked DIRTY in the
 * staleness ledger and queued for the next compile run.
 */

import type { CascadeResult, CompileGraph, CompileResult } from "./types.js";

// ---------------------------------------------------------------------------
// Cascade enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a CompileResult with the set of wiki pages linking to `conceptId`.
 *
 * The backlink list is resolved via `graph.getBacklinks(conceptId)`.  If the
 * graph is unavailable, use `createNullGraph()` which returns [].
 *
 * @param result    - Raw compile result (body, sha, provenance).
 * @param conceptId - Vault-relative path of the concept page just compiled.
 * @param graph     - CompileGraph implementation providing backlink lookup.
 */
export function withCascade(
  result: CompileResult,
  conceptId: string,
  graph: CompileGraph,
): CascadeResult {
  const affected_backlinks = graph.getBacklinks(conceptId);
  return {
    ...result,
    affected_backlinks,
  };
}

// ---------------------------------------------------------------------------
// Graph stubs (for tests / contexts without a live engine graph)
// ---------------------------------------------------------------------------

/**
 * A no-op CompileGraph that always returns an empty backlink list.
 * Use in tests or when the engine graph is not available.
 */
export function createNullGraph(): CompileGraph {
  return {
    getBacklinks(_docPath: string): string[] {
      return [];
    },
  };
}

/**
 * An in-memory CompileGraph stub for testing cascade behavior.
 * Seed it with known backlink relationships.
 *
 * @param backlinks - Map of concept path → list of paths that link to it.
 */
export function createStubGraph(
  backlinks: Readonly<Record<string, string[]>>,
): CompileGraph {
  return {
    getBacklinks(docPath: string): string[] {
      return backlinks[docPath] ?? [];
    },
  };
}
