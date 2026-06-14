import path from "node:path";
import type { GraphEdge } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An index built once from the vault file list for fast wikilink resolution.
 * Construct with {@link buildWikilinkIndex} and pass to {@link resolveWikilink}.
 */
export interface WikilinkIndex {
  /** Lowercase basename (no .md) → list of vault-relative paths (original case). */
  readonly byBasename: ReadonlyMap<string, readonly string[]>;
  /** Lowercase vault-relative path (with .md) → original-case vault-relative path. */
  readonly byPath: ReadonlyMap<string, string>;
}

/** Result of resolving a single raw wikilink against the vault file set. */
export interface WikilinkResolution {
  /** Cleaned target after stripping `[[`, `]]`, alias (`|`), and heading (`#`). */
  target: string;
  /**
   * Vault-relative path of the matched document, or `null` when unresolvable.
   * Callers must emit an `unknown-ref` GraphEdge instead of throwing on `null`.
   */
  docPath: string | null;
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Build a lookup index from the vault file list for fast wikilink resolution.
 * O(n) construction; call once per graph build pass.
 */
export function buildWikilinkIndex(vaultFiles: readonly string[]): WikilinkIndex {
  const byBasename = new Map<string, string[]>();
  const byPath = new Map<string, string>();

  for (const f of vaultFiles) {
    // exact-path lookup (normalised to lowercase with .md)
    const normalised = f.toLowerCase();
    const withMd = normalised.endsWith(".md") ? normalised : `${normalised}.md`;
    byPath.set(withMd, f);

    // basename lookup
    const base = path.basename(f, ".md").toLowerCase();
    const bucket = byBasename.get(base) ?? [];
    bucket.push(f);
    byBasename.set(base, bucket);
  }

  return { byBasename, byPath };
}

// ---------------------------------------------------------------------------
// Link parsing helpers
// ---------------------------------------------------------------------------

/**
 * Strip `[[ ]]` brackets, alias (`|…`), and heading (`#…`) from a wikilink
 * inner string, returning the cleaned target.
 *
 * Handles all Obsidian wikilink forms:
 *   [[Target]]  [[Target|Alias]]  [[Target#Heading]]  [[Target#H|Alias]]
 */
function cleanLinkTarget(raw: string): string {
  let s = raw.trim();
  // strip surrounding brackets if present
  if (s.startsWith("[[") && s.endsWith("]]")) s = s.slice(2, -2);
  // strip alias
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) s = s.slice(0, pipeIdx);
  // strip heading
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) s = s.slice(0, hashIdx);
  return s.trim();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw `[[wikilink]]` string to a vault-relative document path.
 *
 * Resolution order:
 *  1. Exact vault-relative path (case-insensitive, `.md` optional)
 *  2. Basename match (case-insensitive) — when ambiguous, shortest path wins;
 *     ties broken alphabetically
 *
 * Returns `{ docPath: null }` when unresolvable.  Callers must **not** throw;
 * instead they should emit a `kind: "unknown-ref"` GraphEdge with weight 0.
 */
export function resolveWikilink(rawLink: string, index: WikilinkIndex): WikilinkResolution {
  const target = cleanLinkTarget(rawLink);
  if (!target) return { target, docPath: null };

  // 1. Exact path match (normalise to lowercase + .md)
  const lc = target.toLowerCase();
  const lcWithMd = lc.endsWith(".md") ? lc : `${lc}.md`;
  const exactHit = index.byPath.get(lcWithMd);
  if (exactHit !== undefined) return { target, docPath: exactHit };

  // 2. Basename match — shortest path wins, ties broken alphabetically
  const base = path.basename(lc, ".md");
  const candidates = index.byBasename.get(base);
  if (candidates !== undefined && candidates.length > 0) {
    const sorted = candidates
      .slice()
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    const best = sorted[0] ?? null;
    return { target, docPath: best };
  }

  return { target, docPath: null };
}

// ---------------------------------------------------------------------------
// Convenience: batch-convert wikilink strings to GraphEdge[]
// ---------------------------------------------------------------------------

/**
 * Convert raw wikilink inner strings extracted from `fromPath` into GraphEdge
 * objects.  Unresolvable links produce `kind: "unknown-ref"` edges (weight 0)
 * rather than errors.
 */
export function wikilinkEdges(
  fromPath: string,
  rawLinks: readonly string[],
  index: WikilinkIndex,
  weight = 3.0,
): GraphEdge[] {
  return rawLinks.map((rawLink): GraphEdge => {
    const { docPath } = resolveWikilink(rawLink, index);
    if (docPath !== null) {
      return { from: fromPath, to: docPath, weight, kind: "wikilink" };
    }
    return { from: fromPath, to: rawLink, weight: 0, kind: "unknown-ref" };
  });
}
