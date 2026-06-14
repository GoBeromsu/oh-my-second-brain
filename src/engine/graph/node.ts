/**
 * EngineGraphNode — per-note metadata model for axis-filtered retrieval.
 *
 * The engine's C2 graph (builder.ts) emits a GraphEdge[] only — it has no
 * per-note concept / folder / axes / wikilinks record. This file adds that
 * node model plus the two pure query primitives the retrieve ops need:
 *
 *   - filterNodesByAxis() — AND-intersection axis filter (mirrors the idea of
 *     src/graph/cache.ts::matchesAxis, reimplemented from scratch — R18).
 *   - searchScore()       — lexical overlap of a free-text query against a
 *     node's pre-tokenised searchTerms set.
 *
 * R18: NO runtime import from src/search. Concept is read directly from
 * frontmatter["concept"] — no Ontology resolution (accepted semantic delta,
 * see swap blueprint RISK-5).
 */

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/** Per-note metadata used for axis filtering and local-graph exploration. */
export interface EngineGraphNode {
  /** Vault-relative path, e.g. "50. AI/Self-Attention.md". */
  path: string;
  /** frontmatter["concept"] when it is a plain string; null otherwise. */
  concept: string | null;
  /** First path segment (folder group) — mirrors builder.ts noteType(). */
  folder: string;
  /** Every frontmatter field coerced to a flat string array. */
  axes: Record<string, string[]>;
  /** Resolved vault-relative docPaths this note links out to via [[…]]. */
  wikilinks: string[];
  /** First 240 chars of the note body (after the frontmatter fence). */
  bodyPreview: string;
  /** Tokenised union of all frontmatter string values + body, for searchScore. */
  searchTerms: Set<string>;
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Unicode-aware word tokeniser: runs of ≥2 letter/number chars (plus `_`/`-`
 * internally). Lowercased. Matches the search-term grain used by searchScore
 * and buildNodeIndex so query terms and stored terms are directly comparable.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu;
  for (const m of text.toLowerCase().matchAll(re)) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Case-insensitive basename comparison for wikilink axis filtering.
 *
 * `link` is a resolved vault-relative docPath (e.g. "50. AI/Foo.md");
 * `target` is the user-supplied filter (a bare title or a path). Comparing by
 * basename (extension stripped) avoids folder-prefix and slug/real-path
 * mismatches.
 */
export function wikilinkStemMatch(link: string, target: string): boolean {
  const stem = (s: string): string => {
    const lower = s.toLowerCase().replace(/\.md$/, "").trim();
    const slash = lower.lastIndexOf("/");
    return slash >= 0 ? lower.slice(slash + 1) : lower;
  };
  return stem(link) === stem(target);
}

// ---------------------------------------------------------------------------
// Axis filter
// ---------------------------------------------------------------------------

/** Axis filter inputs accepted by filterNodesByAxis (subset of McpAxisFilters). */
export interface NodeAxisFilters {
  concept?: string;
  folder?: string;
  property?: string;
  value?: string;
  wikilink?: string;
}

/**
 * Return the nodes that satisfy every supplied axis filter (AND-intersection).
 *
 * Undefined filters are ignored. A `property` filter without `value` matches
 * any node that defines that frontmatter field; with `value` it matches only
 * nodes whose field array contains that exact value.
 */
export function filterNodesByAxis(
  nodes: readonly EngineGraphNode[],
  filters: NodeAxisFilters,
): EngineGraphNode[] {
  return nodes.filter((node) => {
    if (filters.concept !== undefined && node.concept !== filters.concept) {
      return false;
    }
    if (filters.folder !== undefined && node.folder !== filters.folder) {
      return false;
    }
    if (filters.wikilink !== undefined) {
      const target = filters.wikilink;
      if (!node.wikilinks.some((link) => wikilinkStemMatch(link, target))) {
        return false;
      }
    }
    if (filters.property !== undefined) {
      const values = node.axes[filters.property];
      if (filters.value !== undefined) {
        if (values === undefined || !values.includes(filters.value)) return false;
      } else if (values === undefined || values.length < 1) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Lexical score
// ---------------------------------------------------------------------------

/**
 * Count how many distinct query tokens appear in the node's searchTerms set.
 * Returns 0 for an empty/whitespace query. This is a cheap lexical proxy used
 * to rank axis-filtered candidates (no embeddings involved).
 */
export function searchScore(node: EngineGraphNode, query: string): number {
  if (!query) return 0;
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    if (node.searchTerms.has(term)) score++;
  }
  return score;
}
