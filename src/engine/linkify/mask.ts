/**
 * Body masking: split a note body into regions the linkifier may rewrite and
 * regions it must leave byte-for-byte alone.
 *
 * Why this exists: inserting `[[…]]` into a code fence, a URL, an existing
 * wikilink, or a heading corrupts the note. The span detector therefore never
 * sees the raw body — it sees only the FREE spans this module returns.
 *
 * Design: one collector pass per construct family, then a sort-and-merge into
 * disjoint ascending ranges, then the complement. Merging (rather than
 * precedence rules) is what makes overlapping constructs — a URL inside a
 * markdown link target, a wikilink inside a heading — safe: the union is
 * protected and nothing is double-counted. Malformed input degrades toward MORE
 * protection (an unterminated fence protects to end of body), never less.
 *
 * Pure module: no I/O, no state. Offsets are UTF-16 indices into the input.
 */

import type { MaskResult, ProtectedKind, ProtectedSpan, Span } from "./types.js";

// ---------------------------------------------------------------------------
// Collectors — each returns raw (possibly overlapping) protected ranges
// ---------------------------------------------------------------------------

/** Leading `---\n … \n---` YAML block only; a mid-body `---` is a thematic break. */
function frontmatterSpan(body: string): ProtectedSpan[] {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return [];
  const close = /^---[ \t]*\r?$/m.exec(body.slice(3));
  if (!close || close.index === undefined) return [];
  return [{ start: 0, end: 3 + close.index + close[0].length, kind: "frontmatter" }];
}

/**
 * Fenced code blocks (``` or ~~~), including the fence lines themselves.
 * An unterminated fence protects everything to the end of the body.
 */
function fencedCodeSpans(body: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(body)) !== null) {
    const marker = match[1];
    if (marker === undefined) continue;
    const opening = match.index;
    const closer = new RegExp(`^[ \\t]*${marker[0] === "\`" ? "`" : "~"}{${String(marker.length)},}[ \\t]*$`, "m");
    const rest = body.slice(fence.lastIndex);
    const closeMatch = closer.exec(rest);
    const end =
      closeMatch && closeMatch.index !== undefined
        ? fence.lastIndex + closeMatch.index + closeMatch[0].length
        : body.length;
    spans.push({ start: opening, end, kind: "fenced-code" });
    fence.lastIndex = end;
  }
  return spans;
}

/**
 * Inline code spans: a run of N backticks closed by another run of exactly N
 * on the same logical block. An unclosed run protects nothing extra — the
 * fenced-code pass already covers the block-level case.
 */
function inlineCodeSpans(body: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const run = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = run.exec(body)) !== null) {
    const ticks = match[0];
    const closeIndex = body.indexOf(ticks, match.index + ticks.length);
    if (closeIndex < 0) continue;
    const inner = body.slice(match.index + ticks.length, closeIndex);
    if (inner.includes("\n\n")) continue;
    const end = closeIndex + ticks.length;
    spans.push({ start: match.index, end, kind: "inline-code" });
    run.lastIndex = end;
  }
  return spans;
}

/** Regex-driven collectors that need no cursor bookkeeping. */
const SIMPLE_PATTERNS: readonly { readonly kind: ProtectedKind; readonly pattern: RegExp }[] = [
  // image embeds first so their `!` prefix is inside the span, not left free
  { kind: "image-embed", pattern: /!\[\[[^\]\n]*\]\]/g },
  { kind: "image-embed", pattern: /!\[[^\]\n]*\]\([^)\n]*\)/g },
  { kind: "wikilink", pattern: /\[\[[^\]\n]*\]\]/g },
  { kind: "markdown-link", pattern: /\[[^\]\n]*\]\([^)\n]*\)/g },
  { kind: "html", pattern: /<\/?[A-Za-z][^<>\n]*>/g },
  { kind: "heading", pattern: /^[ \t]{0,3}#{1,6}[ \t][^\n]*$/gm },
  { kind: "heading", pattern: /^[^\n]+\r?\n[ \t]{0,3}(?:=+|-{2,})[ \t]*$/gm },
  { kind: "url", pattern: /\b(?:https?|ftp|obsidian|mailto):[^\s<>()[\]]+/g },
  { kind: "block-id", pattern: /(?<=\s)\^[A-Za-z0-9-]+[ \t]*$/gm },
  { kind: "tag", pattern: /(?<=^|\s)#[\p{L}\p{N}][\p{L}\p{N}/_-]*/gu },
];

function simpleSpans(body: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const { kind, pattern } of SIMPLE_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(body)) !== null) {
      if (match[0].length < 1) {
        scanner.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Merge + complement
// ---------------------------------------------------------------------------

/**
 * Sort by start (earlier wins, longer wins on tie) and fuse overlaps into one
 * span carrying the first contributor's kind — the union is what matters to the
 * detector; the kind is reviewer-facing provenance.
 */
function mergeSpans(raw: readonly ProtectedSpan[]): ProtectedSpan[] {
  const sorted = raw
    .filter((s) => s.end > s.start)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: ProtectedSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: span.end, kind: last.kind };
      }
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** The complement of `protectedSpans` within `[0, length)`. */
function complement(protectedSpans: readonly ProtectedSpan[], length: number): Span[] {
  const free: Span[] = [];
  let cursor = 0;
  for (const span of protectedSpans) {
    if (span.start > cursor) free.push({ start: cursor, end: span.start });
    cursor = span.end;
  }
  if (cursor < length) free.push({ start: cursor, end: length });
  return free;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Partition `body` into protected and free spans.
 *
 * Together the two lists tile `[0, body.length)` exactly once, ascending, with
 * no zero-length entries. Callers scan `freeSpans` and never touch the rest.
 */
export function maskBody(body: string): MaskResult {
  if (body.length < 1) return { protectedSpans: [], freeSpans: [] };

  const protectedSpans = mergeSpans([
    ...frontmatterSpan(body),
    ...fencedCodeSpans(body),
    ...inlineCodeSpans(body),
    ...simpleSpans(body),
  ]);

  return { protectedSpans, freeSpans: complement(protectedSpans, body.length) };
}

/** True when `offset` falls inside any protected span. */
export function isProtected(mask: MaskResult, offset: number): boolean {
  return mask.protectedSpans.some((span) => span.start <= offset && offset < span.end);
}

/** The body slices the span detector is allowed to scan, in document order. */
export function freeText(body: string, mask: MaskResult): string[] {
  return mask.freeSpans.map((span) => body.slice(span.start, span.end));
}
