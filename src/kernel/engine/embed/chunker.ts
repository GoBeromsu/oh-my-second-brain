/**
 * Heading-aware, overlapping Markdown chunker.
 *
 * Algorithm idea absorbed from nashsu/llm_wiki (GPL-3.0) — sliding-window
 * overlap and heading-boundary split detection implemented from concept;
 * zero verbatim code. See ACKNOWLEDGMENTS.md for attribution.
 */

import { createHash } from "node:crypto";
import { parseNote, type ParsedNote } from "../../conventions/frontmatter.js";
import { UNTITLED_DOCUMENT_TITLE } from "../types.js";
import type { Chunk, ChunkerOptions } from "../types.js";

export const DEFAULT_MAX_TOKENS = 900;
export const DEFAULT_OVERLAP_RATIO = 0.15;
/** Bumped when chunk text identity changes (body-only, hard splits, overlap caps). */
export const CHUNKER_VERSION = 2;

/** Stable identity string stored with each indexed document source. */
export function chunkerIdentity(opts: Partial<ChunkerOptions> = {}): string {
  return JSON.stringify({
    version: CHUNKER_VERSION,
    maxTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
    overlapRatio: opts?.overlapRatio ?? DEFAULT_OVERLAP_RATIO,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Quarter-token weight for the approximate token count, script-aware.
 *
 * The naive `length / 4` heuristic holds for English/Latin text but drastically
 * UNDER-counts CJK (Korean, Chinese, Japanese): EmbeddingGemma tokenises those
 * scripts at roughly one token per character, so a 900-"token" chunk estimated
 * at 4 chars/token is really ~3600 tokens of Hangul — enough to overflow the
 * embedding context. We weight CJK/Hangul/Kana codepoints at ~1 token each and
 * all other characters at ~0.25 (the 4-chars/token Latin rate). This keeps
 * mixed Korean/English chunks safely under the embedding context window.
 */
function tokenWeight(text: string): number {
  let weighted = 0;
  for (const ch of text) {
    weighted += isCjk(ch.codePointAt(0)!) ? 4 : 1;
  }
  // Integer quarter-token units preserve the old ceil(weighted / 4) budget.
  return weighted;
}

/** Approximate token count used by the chunker budget (matches flush checks). */
export function approximateTokenCount(text: string): number {
  return Math.ceil(tokenWeight(text) / 4);
}

/** True for CJK / Hangul / Kana / fullwidth codepoints (~1 token per char). */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xd7b0 && cp <= 0xd7ff) || // Hangul Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth & Fullwidth forms
    (cp >= 0x20000 && cp <= 0x2fa1f)  // CJK Ext B–F + compatibility supplement
  );
}

/**
 * Split one over-budget string into pieces that each fit `maxWeight`
 * quarter-tokens. Walks Unicode code points so CJK weighting stays consistent
 * with `tokenWeight`.
 */
function hardSplitByWeight(text: string, maxWeight: number): string[] {
  if (tokenWeight(text) <= maxWeight) return [text];
  const chars = [...text];
  const parts: string[] = [];
  let start = 0;
  let weight = 0;
  for (let index = 0; index < chars.length; index++) {
    const w = isCjk(chars[index]!.codePointAt(0)!) ? 4 : 1;
    if (weight + w > maxWeight && weight > 0) {
      parts.push(chars.slice(start, index).join(""));
      start = index;
      weight = 0;
    }
    weight += w;
  }
  if (start < chars.length) parts.push(chars.slice(start).join(""));
  return parts.filter((part) => part.length > 0);
}

/**
 * SHA-256 change-detection digest over everything that reaches the embedding
 * input: the document title AND the chunk text.
 *
 * The title must be inside the digest. It is prepended to every chunk's
 * embedding input, so a digest over `text` alone would report "unchanged" for
 * each chunk that does not itself contain the title line — leaving vectors that
 * still encode the OLD title after a retitle.
 *
 * The title is length-prefixed rather than merely separated. A bare separator is
 * only unambiguous while the inputs cannot contain it, and nothing forbids a NUL
 * in note text: with a plain separator, `("a", "\0b")` and `("a\0", "b")` hash
 * identically, so a crafted retitle could impersonate a body edit and suppress
 * re-embedding. The length prefix makes the encoding injective for every input.
 */
function chunkDigest(title: string, text: string): string {
  return createHash("sha256")
    .update(`${title.length}\u0000${title}\u0000${text}`)
    .digest("hex");
}

/**
 * Find the first ATX H1 in a markdown body, ignoring fenced code blocks.
 *
 * A `# ...` line inside a fence is sample content, not the document's heading.
 * Scanning without fence tracking would let a README-style note that shows a
 * markdown example be titled by that example. Both backtick and tilde fences
 * count, and a fence closes only on a run of the same character at least as
 * long as the one that opened it, so a fence containing a shorter run stays
 * open as CommonMark specifies.
 */
function firstHeadingTitle(body: string): string | undefined {
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const run = fenceMatch[1]!;
      const char = run[0]!;
      if (fence === null) {
        fence = { char, length: run.length };
      } else if (char === fence.char && run.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#\s+(.+)$/.exec(line);
    const title = heading?.[1]?.trim();
    if (title !== undefined && title !== "") return title;
  }
  return undefined;
}

/**
 * The document title carried into every chunk's embedding input.
 *
 * Frontmatter `title` wins, then the first ATX H1 in the body, else the
 * untitled literal. Reuses the shared convention parser rather than
 * re-deriving frontmatter here.
 *
 * The H1 scan is deliberately confined to `parsed.body`. Scanning the raw
 * document would read frontmatter too, where a YAML comment (`# note to self`)
 * is syntactically indistinguishable from an H1 — which would embed private
 * metadata as though it were the note's title. A document whose frontmatter
 * fence never closes therefore has an empty body and is untitled: `none` is the
 * honest answer for a malformed document, and preferable to guessing from a
 * region that is not body text.
 */
function documentTitle(parsed: Readonly<ParsedNote>): string {
  const declared = parsed.frontmatter["title"];
  if (typeof declared === "string" && declared.trim() !== "") return declared.trim();
  return firstHeadingTitle(parsed.body) ?? UNTITLED_DOCUMENT_TITLE;
}

/**
 * Update a mutable heading-path array given a newly encountered ATX heading.
 * Level 1 (#) → index 0, level 2 (##) → index 1, etc.
 */
function applyHeading(current: string[], level: number, title: string): string[] {
  const next = current.slice(0, level - 1);
  next.push(title);
  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a Markdown document into overlapping text chunks, respecting ATX
 * heading boundaries as natural split points.
 *
 * Chunking uses `parsed.body` so YAML frontmatter never reaches the embedding
 * input. When a single line exceeds `maxTokens`, it is hard-split by the same
 * script-aware token weight. Overlap from the previous flush is capped by a
 * token budget (`maxTokens * overlapRatio`) so an overlong retained line cannot
 * force duplicate flushes of the same giant text.
 *
 * Each chunk carries:
 *   - vault-relative `docPath`
 *   - zero-based `ordinal` within the document
 *   - raw `text`
 *   - `title` — the document title, prepended to this chunk's embedding input
 *   - `headingPath` — breadcrumb from doc root to the chunk's section
 *   - `sha` — SHA-256 digest of `title` + `text` for change-detection
 */
export function chunkDocument(
  docPath: string,
  rawText: string,
  opts: Partial<ChunkerOptions> = {},
  // Internal captured-source reuse: this must be the parsing of rawText itself.
  parsed: Readonly<ParsedNote> = parseNote(rawText),
): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapRatio = opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const maxWeight = maxTokens * 4;
  // Token budget for retained overlap. Ratio 0 retains nothing.
  const overlapTokenBudget = overlapRatio <= 0 ? 0 : Math.max(1, Math.floor(maxTokens * overlapRatio));
  // Soft line-count cap kept for short-line notes (matches historical sizing).
  const overlapLineCount = overlapRatio <= 0 ? 0 : Math.max(1, Math.round(10 * overlapRatio));

  const lines = parsed.body.split("\n");
  const chunks: Chunk[] = [];
  const title = documentTitle(parsed);
  let ordinal = 0;
  let buffer: string[] = [];
  let lineWeights: number[] = [];
  let bufferWeight = 0;
  let headingPath: string[] = [];

  const clearBuffer = (): void => {
    buffer = [];
    lineWeights = [];
    bufferWeight = 0;
  };

  const emit = (text: string): void => {
    chunks.push({
      docPath,
      ordinal: ordinal++,
      text,
      title,
      headingPath: headingPath.slice(),
      sha: chunkDigest(title, text),
    });
  };

  const retainOverlap = (): void => {
    if (overlapTokenBudget <= 0 || overlapLineCount <= 0 || buffer.length === 0) {
      clearBuffer();
      return;
    }
    let retainedWeight = 0;
    let retainedCount = 0;
    for (let index = buffer.length - 1; index >= 0; index--) {
      const separator = retainedCount > 0 ? 1 : 0;
      const nextWeight = retainedWeight + separator + lineWeights[index]!;
      if (Math.ceil(nextWeight / 4) > overlapTokenBudget) break;
      retainedWeight = nextWeight;
      retainedCount += 1;
      if (retainedCount >= overlapLineCount) break;
    }
    if (retainedCount === 0) {
      clearBuffer();
      return;
    }
    buffer = buffer.slice(-retainedCount);
    lineWeights = lineWeights.slice(-retainedCount);
    bufferWeight = retainedWeight;
  };

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (!text) {
      clearBuffer();
      return;
    }
    emit(text);
    retainOverlap();
  };

  const fits = (lineWeight: number): boolean => {
    const separator = buffer.length > 0 ? 1 : 0;
    return Math.ceil((bufferWeight + separator + lineWeight) / 4) <= maxTokens;
  };

  const appendFittingLine = (line: string, weight: number): void => {
    if (buffer.length > 0 && !fits(weight)) {
      flush();
    }
    // Overlap alone can still refuse a new line after flush; drop it rather
    // than emit a chunk that exceeds the budget.
    if (buffer.length > 0 && !fits(weight)) {
      clearBuffer();
    }
    if (buffer.length > 0) bufferWeight += 1;
    buffer.push(line);
    lineWeights.push(weight);
    bufferWeight += weight;
  };

  for (const line of lines) {
    // Detect ATX headings (# through ######) on body lines only.
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1]!.length;
      const headingTitle = hm[2]!.trim();
      headingPath = applyHeading(headingPath, level, headingTitle);
    }

    const weight = tokenWeight(line);
    if (weight > maxWeight) {
      // Finish any pending buffer, then emit hard-split pieces without
      // overlap between them. Retaining an over-budget line as overlap is
      // what previously re-emitted the same giant text on every flush.
      if (buffer.length > 0) flush();
      const parts = hardSplitByWeight(line, maxWeight);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        emit(part);
        if (index === parts.length - 1) {
          clearBuffer();
          const partWeight = tokenWeight(part);
          buffer = [part];
          lineWeights = [partWeight];
          bufferWeight = partWeight;
          retainOverlap();
        }
      }
      continue;
    }

    appendFittingLine(line, weight);
    if (Math.ceil(bufferWeight / 4) >= maxTokens) {
      flush();
    }
  }

  const remaining = buffer.join("\n").trim();
  if (remaining) emit(remaining);

  return chunks;
}
