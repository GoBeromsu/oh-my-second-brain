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
  /** Lowercase frontmatter alias → list of vault-relative paths declaring it. */
  readonly byAlias: ReadonlyMap<string, readonly string[]>;
}

/** A vault document paired with its already-parsed frontmatter. */
export interface IndexedDoc {
  /** Vault-relative path (original case, with .md). */
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
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
  const byAlias = new Map<string, string[]>();

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

  return { byBasename, byPath, byAlias };
}

/**
 * Build a wikilink index that also resolves frontmatter `aliases` declarations.
 *
 * Same path/basename behaviour as {@link buildWikilinkIndex}, plus a `byAlias`
 * map so `[[Ataraxia]]` reaches a note whose frontmatter declares that alias.
 * Non-string, blank, and non-array `aliases` values are ignored.
 */
export function buildWikilinkIndexWithFrontmatter(docs: readonly IndexedDoc[]): WikilinkIndex {
  const { byBasename, byPath } = buildWikilinkIndex(docs.map((d) => d.path));
  const byAlias = new Map<string, string[]>();

  for (const doc of docs) {
    for (const alias of aliasStrings(doc.frontmatter["aliases"])) {
      const key = alias.toLowerCase();
      const bucket = byAlias.get(key) ?? [];
      bucket.push(doc.path);
      byAlias.set(key, bucket);
    }
  }

  return { byBasename, byPath, byAlias };
}

/** Flatten an unknown frontmatter `aliases` value to trimmed non-empty strings. */
function aliasStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

/** Shortest path wins; ties broken alphabetically. */
function bestCandidate(candidates: readonly string[] | undefined): string | null {
  if (candidates === undefined || candidates.length === 0) return null;
  const sorted = candidates
    .slice()
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return sorted[0] ?? null;
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
 *  3. Frontmatter `aliases` match (case-insensitive), same tie-break
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
  const byBasenameHit = bestCandidate(index.byBasename.get(path.basename(lc, ".md")));
  if (byBasenameHit !== null) return { target, docPath: byBasenameHit };

  // 3. Frontmatter alias match — same tie-break
  return { target, docPath: bestCandidate(index.byAlias.get(lc)) };
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
