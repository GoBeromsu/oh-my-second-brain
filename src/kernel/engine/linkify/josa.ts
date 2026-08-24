/**
 * Korean josa (조사) table + stem matcher for the linkify span detector.
 *
 * Why this exists: Korean is agglutinative, so a vault term almost never appears
 * bare in prose — "아타락시아" shows up as "아타락시아를", "아타락시아는",
 * "아타락시아에서". A plain word-boundary matcher misses every one of them, and a
 * plain prefix matcher over-matches ("학교" inside "학교폭력").
 *
 * The rule this module encodes: a term matches a token when the term is a prefix
 * and the remainder is a KNOWN particle from the table below (or empty). An
 * unknown remainder is NOT a match — there is no morphological analysis here and
 * no guessing. Latin-script terms get ordinary case-insensitive whole-token
 * matching; particle logic never applies to them.
 *
 * Pure module: no I/O, no state. Tokenisation grain matches
 * src/engine/graph/node.ts::tokenize (\p{L}/\p{N} runs), so callers can feed it
 * whitespace/punctuation-delimited tokens directly.
 */

// ---------------------------------------------------------------------------
// Particle table
// ---------------------------------------------------------------------------

/**
 * Common Korean particles, ≤2 syllables, that may directly follow a noun.
 *
 * Plain reviewable data, grouped by role. Deliberately conservative: only
 * particles that attach to a bare noun stem are listed, because anything longer
 * or more contextual (verb endings such as "하게", "이라는") is exactly the case
 * the matcher must reject rather than guess at.
 */
export const KOREAN_PARTICLES = [
  // subject (주격)
  "이",
  "가",
  "께서",
  // topic (보조사 — 주제)
  "은",
  "는",
  // object (목적격)
  "을",
  "를",
  // possessive (관형격)
  "의",
  // locative / directional (부사격)
  "에",
  "에서",
  "에게",
  "께",
  "한테",
  "으로",
  "로",
  // comitative / conjunctive (접속)
  "와",
  "과",
  "하고",
  "이랑",
  "랑",
  // comparative / source (부사격)
  "보다",
  "부터",
  "까지",
  "에도",
  "에는",
  // auxiliary (보조사)
  "도",
  "만",
  "조차",
  "마저",
  "밖에",
  "이나",
  "이란",
  "란",
  // copula attached straight to a noun
  "이다",
] as const;

/** A particle string drawn from {@link KOREAN_PARTICLES}. */
export type KoreanParticle = (typeof KOREAN_PARTICLES)[number];

const PARTICLE_SET: ReadonlySet<string> = new Set<string>(KOREAN_PARTICLES);

// ---------------------------------------------------------------------------
// Match result
// ---------------------------------------------------------------------------

/**
 * Outcome of matching a term against a single token.
 *
 * Offsets are UTF-16 code-unit indices into the token, so `token.slice(stemStart,
 * stemEnd)` yields the stem the caller should wrap. Particle fields are null on
 * a bare match (no trailing particle).
 */
export type JosaMatch =
  | {
      readonly kind: "match";
      readonly stem: string;
      readonly stemStart: number;
      readonly stemEnd: number;
      readonly particle: string | null;
      readonly particleStart: number | null;
      readonly particleEnd: number | null;
    }
  | { readonly kind: "no_match" };

const NO_MATCH: JosaMatch = { kind: "no_match" };

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

const HANGUL_SYLLABLE = /^[\uAC00-\uD7A3]+$/u;

/** True when the string's last character is a Hangul syllable. */
function endsWithHangul(text: string): boolean {
  const last = text.slice(-1);
  return last.length > 0 && HANGUL_SYLLABLE.test(last);
}

/** True when the remainder is a known particle short enough to be one. */
export function isKnownParticle(remainder: string): boolean {
  return remainder.length <= 2 && PARTICLE_SET.has(remainder);
}

/**
 * Match `term` inside a single whitespace/punctuation-delimited `token`.
 *
 * Korean-final terms accept one trailing particle from {@link KOREAN_PARTICLES};
 * the returned span covers the stem only. Every other trailing remainder is a
 * no-match. Latin/other-script terms require the whole token to equal the term
 * (case-insensitive) — no particle absorption, no partial-word hits.
 */
export function matchTermInToken(term: string, token: string): JosaMatch {
  if (term.length < 1 || token.length < 1) return NO_MATCH;

  if (!endsWithHangul(term)) {
    return token.toLowerCase() === term.toLowerCase() ? bareMatch(term.length, token) : NO_MATCH;
  }

  if (!token.startsWith(term)) return NO_MATCH;

  const remainder = token.slice(term.length);
  if (remainder.length < 1) return bareMatch(term.length, token);
  if (!isKnownParticle(remainder)) return NO_MATCH;

  return {
    kind: "match",
    stem: token.slice(0, term.length),
    stemStart: 0,
    stemEnd: term.length,
    particle: remainder,
    particleStart: term.length,
    particleEnd: token.length,
  };
}

/** Whole-token match with no trailing particle. */
function bareMatch(stemEnd: number, token: string): JosaMatch {
  return {
    kind: "match",
    stem: token.slice(0, stemEnd),
    stemStart: 0,
    stemEnd,
    particle: null,
    particleStart: null,
    particleEnd: null,
  };
}
