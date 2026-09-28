/**
 * Korean syllable-bigram lexical channel (branch-only experiment, PR6).
 *
 * The production FTS query (`makeFtsQuery` in embed/store.ts) prefix-matches
 * whole whitespace tokens, so a particle-attached term ("기준을") or an infix
 * ("단계분류" inside "욕창단계분류") never matches. This channel indexes and
 * queries every Hangul run as overlapping syllable bigrams instead, which
 * matches inside compounds and tolerates a trailing particle.
 *
 * It is not wired into the dispatcher or sync; the bench (scripts/bench) is its
 * only caller.
 */

const HANGUL_SYLLABLE = /[가-힣]/;
const TOKEN = /[가-힣]+|[a-z0-9]+/g;
const MAX_QUERY_TERMS = 64;

/**
 * Overlapping syllable bigrams of one Hangul run. A one-syllable run yields itself.
 */
export function hangulBigrams(run: string): string[] {
  const syllables = Array.from(run);
  if (syllables.length <= 1) return syllables;
  return syllables.slice(1).map((syllable, index) => `${syllables[index]}${syllable}`);
}

function tokens(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(TOKEN) ?? [];
}

/**
 * Index-side text: Hangul runs become space-separated bigrams, other
 * alphanumeric tokens pass through lowercased.
 */
export function expandKoreanBigrams(text: string): string {
  const out: string[] = [];
  for (const token of tokens(text)) {
    if (HANGUL_SYLLABLE.test(token)) out.push(...hangulBigrams(token));
    else out.push(token);
  }
  return out.join(" ");
}

/**
 * Query-side FTS5 expression, OR-joined:
 * - a Hangul run of two or more syllables contributes its bigrams as exact terms;
 * - a one-syllable Hangul run is a prefix term, so it matches any bigram it starts;
 * - a non-Hangul token of two or more characters is a prefix term, as in CUR.
 * Returns "" when nothing is searchable.
 */
export function makeBigramFtsQuery(text: string): string {
  const terms = new Set<string>();
  for (const token of tokens(text)) {
    if (HANGUL_SYLLABLE.test(token)) {
      const syllables = Array.from(token);
      if (syllables.length === 1) terms.add(`"${token}"*`);
      else for (const bigram of hangulBigrams(token)) terms.add(`"${bigram}"`);
    } else if (token.length >= 2) {
      terms.add(`"${token}"*`);
    }
  }
  return [...terms].slice(0, MAX_QUERY_TERMS).join(" OR ");
}
