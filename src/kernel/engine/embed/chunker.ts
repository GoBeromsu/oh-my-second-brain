/**
 * Heading-aware, overlapping Markdown chunker.
 *
 * Algorithm idea absorbed from nashsu/llm_wiki (GPL-3.0) — sliding-window
 * overlap and heading-boundary split detection implemented from concept;
 * zero verbatim code. See ACKNOWLEDGMENTS.md for attribution.
 */

import { createHash } from "node:crypto";
import type { Chunk, ChunkerOptions } from "../types.js";

const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_OVERLAP_RATIO = 0.15;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Approximate token count, script-aware.
 *
 * The naive `length / 4` heuristic holds for English/Latin text but drastically
 * UNDER-counts CJK (Korean, Chinese, Japanese): EmbeddingGemma tokenises those
 * scripts at roughly one token per character, so a 900-"token" chunk estimated
 * at 4 chars/token is really ~3600 tokens of Hangul — enough to overflow the
 * embedding context. We weight CJK/Hangul/Kana codepoints at ~1 token each and
 * all other characters at ~0.25 (the 4-chars/token Latin rate). This keeps
 * mixed Korean/English chunks safely under the embedding context window.
 */
function approxTokens(text: string): number {
  let weighted = 0;
  for (const ch of text) {
    weighted += isCjk(ch.codePointAt(0)!) ? 1 : 0.25;
  }
  return Math.ceil(weighted);
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

/** SHA-256 hex digest of text for change-detection. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
 * Each chunk carries:
 *   - vault-relative `docPath`
 *   - zero-based `ordinal` within the document
 *   - raw `text`
 *   - `headingPath` — breadcrumb from doc root to the chunk's section
 *   - `sha` — SHA-256 hex digest of `text` for change-detection
 *
 * When a section exceeds `maxTokens`, it is further split line by line until
 * each emitted chunk fits the budget. Overlap lines from the previous flush
 * are prepended to maintain context continuity.
 */
export function chunkDocument(
  docPath: string,
  rawText: string,
  opts: Partial<ChunkerOptions> = {},
): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapRatio = opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  // Number of overlap lines to carry into the next chunk
  const overlapLineCount = Math.max(1, Math.round(10 * overlapRatio));

  const lines = rawText.split("\n");
  const chunks: Chunk[] = [];
  let ordinal = 0;
  let buffer: string[] = [];
  let headingPath: string[] = [];

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (!text) {
      buffer = [];
      return;
    }
    chunks.push({
      docPath,
      ordinal: ordinal++,
      text,
      headingPath: headingPath.slice(),
      sha: sha256(text),
    });
    // Carry the last N lines as overlap into the next chunk
    buffer = buffer.slice(-overlapLineCount);
  };

  for (const line of lines) {
    // Detect ATX headings (# through ######)
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1]!.length;
      const title = hm[2]!.trim();
      headingPath = applyHeading(headingPath, level, title);
    }

    buffer.push(line);

    if (approxTokens(buffer.join("\n")) >= maxTokens) {
      flush();
    }
  }

  // Flush any remaining lines
  const remaining = buffer.join("\n").trim();
  if (remaining) {
    chunks.push({
      docPath,
      ordinal: ordinal++,
      text: remaining,
      headingPath: headingPath.slice(),
      sha: sha256(remaining),
    });
  }

  return chunks;
}
