/**
 * Shared value types for the linkify core (mask → suggest → apply).
 *
 * Kept in one place because all three stages speak the same coordinate system:
 * half-open UTF-16 offset ranges into the ORIGINAL note body string. Every
 * offset any linkify module emits or consumes indexes that same string, so a
 * caller can splice with `body.slice(start, end)` without a second pass.
 *
 * Pure types only: no I/O, no runtime dependencies.
 */

/** Why a body region is off-limits to the span detector. */
export type ProtectedKind =
  | "frontmatter"
  | "fenced-code"
  | "inline-code"
  | "wikilink"
  | "markdown-link"
  | "image-embed"
  | "html"
  | "heading"
  | "url"
  | "block-id"
  | "tag";

/** A half-open `[start, end)` range of UTF-16 offsets into the note body. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A protected range plus the syntax that claimed it. */
export interface ProtectedSpan extends Span {
  readonly kind: ProtectedKind;
}

/**
 * The body partitioned into regions the span detector must not touch
 * (`protectedSpans`) and the complement it may scan (`freeSpans`).
 *
 * Both lists are sorted by `start`, contain no zero-length entries, and never
 * overlap each other; together they tile the whole body exactly once.
 */
export interface MaskResult {
  readonly protectedSpans: readonly ProtectedSpan[];
  readonly freeSpans: readonly Span[];
}

/** Which surface form of a note a candidate span matched. */
export type MatchSource = "basename" | "alias";

/**
 * One proposed link: the body range to replace and the text to replace it with.
 *
 * `renderedReplacement` is the finished wikilink for the STEM only. A trailing
 * Korean particle is left OUTSIDE both the span and the link — `아타락시아를`
 * yields the range covering `아타락시아` and the replacement
 * `[[Ataraxia|아타락시아]]`, so splicing keeps `를` in the prose. Apply never
 * re-derives the text.
 */
export interface LinkCandidate {
  readonly startOffset: number;
  readonly endOffset: number;
  /** Exact body slice `[startOffset, endOffset)` this candidate replaces. */
  readonly matchedText: string;
  /** Vault-relative path of the note the link points at. */
  readonly targetPath: string;
  readonly renderedReplacement: string;
  readonly source: MatchSource;
  /** Higher is better; ranking is total and deterministic. */
  readonly confidence: number;
  /** True when 2+ distinct notes claim this span — the caller must disambiguate. */
  readonly ambiguous: boolean;
  /** Every note path that claimed the span (length ≥ 2 exactly when ambiguous). */
  readonly rivalPaths: readonly string[];
}

/** A template-bound link target and its surface forms. */
export interface TermNote {
  /** Vault-relative path (with .md). */
  readonly path: string;
  /** Frontmatter `aliases`, already flattened to trimmed strings. */
  readonly aliases: readonly string[];
}
