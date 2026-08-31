/**
 * Span detection: propose `[[wikilink]]` insertions for a note body.
 *
 * The pipeline is surface-anchored by construction. A candidate exists ONLY
 * because a term's basename or frontmatter alias literally appears in a FREE
 * region of the body (see mask.ts). Retrieval signals never create candidates:
 * an injected lexical ranker may only reorder what the surface already found,
 * and an injected vector predicate may only veto. This is what keeps the
 * feature from hallucinating links into a user's vault.
 *
 * Two rules encode judgement the machine must not make on its own:
 *   - FIRST occurrence per target note only — a term linked ten times is noise.
 *   - Ambiguity (2+ notes claiming one span) is REPORTED, never resolved. The
 *     resolver's shortest-path tie-break is right for reading an existing link
 *     and wrong for creating a new one.
 *
 * Pure given its injected dependencies: no I/O, no globals, no clock.
 */

import path from "node:path";
import { matchTermInToken } from "./josa.js";
import { maskBody } from "./mask.js";
import type { LinkCandidate, MatchSource, Span, TermNote } from "./types.js";

/** Minimal shape of `EngineStore.queryLex` results — only what ranking needs. */
export interface LexHit {
  readonly docPath: string;
  readonly score: number;
}

/** Options for {@link suggestLinks}; every dependency is optional and injected. */
export interface SuggestOptions {
  /** Vault-relative path of the note being linkified; never linked to itself. */
  readonly notePath: string;
  /** Optional lexical re-ranker. Reorders surface-anchored candidates only. */
  readonly queryLex?: (text: string, k: number) => readonly LexHit[];
  /** Optional semantic veto, honoured only when `embeddingConfigured` is true. */
  readonly vectorVeto?: (candidate: LinkCandidate) => boolean;
  /** ADR-007 gate; when false the vector veto is inert. Defaults to true. */
  readonly embeddingConfigured?: boolean;
}

/** Surface form of a candidate note, paired with how it renders. */
interface Surface {
  readonly note: TermNote;
  readonly text: string;
  readonly source: MatchSource;
}

/** A surface hit located in the body, before dedup/ranking. */
interface Hit {
  readonly start: number;
  readonly end: number;
  readonly matchedText: string;
  readonly surface: Surface;
}

const BASENAME_CONFIDENCE = 0.9;
const ALIAS_CONFIDENCE = 0.6;
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

// ---------------------------------------------------------------------------
// Candidate universe
// ---------------------------------------------------------------------------


/** Basename + alias surfaces of a note, longest first so the greediest wins. */
function surfacesOf(note: TermNote): Surface[] {
  const basename = path.basename(note.path, ".md");
  const surfaces: Surface[] = [{ note, text: basename, source: "basename" }];
  for (const alias of note.aliases) {
    const trimmed = alias.trim();
    if (trimmed.length > 0) surfaces.push({ note, text: trimmed, source: "alias" });
  }
  return surfaces.sort((a, b) => b.text.length - a.text.length);
}

// ---------------------------------------------------------------------------
// Detection over free spans
// ---------------------------------------------------------------------------

/**
 * Locate every surface hit inside one free span, via the josa-aware matcher.
 *
 * At most one hit per NOTE per token (its longest matching surface), but every
 * note that claims the token is recorded — that is precisely the signal the
 * ambiguity check downstream needs.
 */
function hitsInSpan(body: string, span: Span, surfaces: readonly Surface[]): Hit[] {
  const text = body.slice(span.start, span.end);
  const hits: Hit[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    const tokenStart = match.index;
    if (tokenStart === undefined) continue;
    const claimed = new Set<string>();
    for (const surface of surfaces) {
      if (claimed.has(surface.note.path)) continue;
      const result = matchTermInToken(surface.text, token);
      if (result.kind === "no_match") continue;
      claimed.add(surface.note.path);
      hits.push({
        start: span.start + tokenStart + result.stemStart,
        end: span.start + tokenStart + result.stemEnd,
        matchedText: token.slice(result.stemStart, result.stemEnd),
        surface,
      });
    }
  }
  return hits;
}

/** Render the replacement, aliasing whenever the surface differs from the target. */
function render(matchedText: string, note: TermNote): string {
  const basename = path.basename(note.path, ".md");
  return matchedText === basename ? `[[${basename}]]` : `[[${basename}|${matchedText}]]`;
}

// ---------------------------------------------------------------------------
// Grouping, ranking
// ---------------------------------------------------------------------------

/** Fold hits sharing one offset span into a single (possibly ambiguous) candidate. */
function groupBySpan(hits: readonly Hit[]): LinkCandidate[] {
  const bySpan = new Map<string, Hit[]>();
  for (const hit of hits) {
    const key = `${String(hit.start)}:${String(hit.end)}`;
    const bucket = bySpan.get(key) ?? [];
    bucket.push(hit);
    bySpan.set(key, bucket);
  }

  return [...bySpan.values()].map((bucket): LinkCandidate => {
    const rivalPaths = [...new Set(bucket.map((hit) => hit.surface.note.path))];
    const best = bucket.reduce((a, b) => (confidenceOf(a) >= confidenceOf(b) ? a : b));
    return {
      startOffset: best.start,
      endOffset: best.end,
      matchedText: best.matchedText,
      targetPath: best.surface.note.path,
      renderedReplacement: render(best.matchedText, best.surface.note),
      source: best.surface.source,
      confidence: confidenceOf(best),
      ambiguous: rivalPaths.length > 1,
      rivalPaths,
    };
  });
}

function confidenceOf(hit: Hit): number {
  return hit.surface.source === "basename" ? BASENAME_CONFIDENCE : ALIAS_CONFIDENCE;
}

/** Keep the earliest candidate per target note; later mentions are noise. */
function firstPerTarget(candidates: readonly LinkCandidate[]): LinkCandidate[] {
  const seen = new Set<string>();
  return candidates
    .slice()
    .sort((a, b) => a.startOffset - b.startOffset)
    .filter((candidate) => {
      if (seen.has(candidate.targetPath)) return false;
      seen.add(candidate.targetPath);
      return true;
    });
}

/**
 * Additive lexical boost, normalised to (0, 0.1]: strong enough to reorder ties
 * between candidates of the same source class, too small to lift an alias hit
 * above an exact basename hit.
 */
function lexBoosts(body: string, options: SuggestOptions): ReadonlyMap<string, number> {
  const lex = options.queryLex;
  if (lex === undefined) return new Map();
  const hits = lex(body, 20);
  const top = Math.max(...hits.map((hit) => hit.score), 1);
  return new Map(hits.map((hit) => [hit.docPath, (hit.score / top) * 0.1]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Propose link candidates for `body` against `notes`.
 *
 * Candidates are returned ranked (highest confidence first, earliest offset
 * breaking ties) and are guaranteed to be non-overlapping, first-occurrence
 * only, outside every protected region, and never self-referential.
 */
export function suggestLinks(
  body: string,
  notes: readonly TermNote[],
  options: SuggestOptions,
): LinkCandidate[] {
  if (body.length < 1) return [];

  const surfaces = notes
    .filter((note) => note.path !== options.notePath)
    .flatMap(surfacesOf)
    .sort((a, b) => b.text.length - a.text.length);
  if (surfaces.length < 1) return [];

  const mask = maskBody(body);
  const hits = mask.freeSpans.flatMap((span) => hitsInSpan(body, span, surfaces));
  const candidates = firstPerTarget(groupBySpan(hits));

  const boosts = lexBoosts(body, options);
  const gateOpen = options.embeddingConfigured ?? true;
  const veto = gateOpen ? options.vectorVeto : undefined;

  return candidates
    .map((candidate): LinkCandidate => ({
      ...candidate,
      confidence: candidate.confidence + (boosts.get(candidate.targetPath) ?? 0),
    }))
    .filter((candidate) => veto === undefined || !veto(candidate))
    .sort((a, b) => b.confidence - a.confidence || a.startOffset - b.startOffset);
}
