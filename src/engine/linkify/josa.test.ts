/**
 * Josa stem matcher tests — table-driven.
 *
 * The matcher is the span detector's boundary rule: a term may be followed by a
 * KNOWN Korean particle (아타락시아 + 를), in which case only the stem is a link
 * span. An unknown remainder (아타락시아하게) is never a match — the matcher must
 * not guess at morphology.
 */

import { describe, it, expect } from "vitest";
import { KOREAN_PARTICLES, matchTermInToken } from "./josa.js";
import type { JosaMatch } from "./josa.js";

// ---------------------------------------------------------------------------
// Particle table
// ---------------------------------------------------------------------------

describe("KOREAN_PARTICLES", () => {
  it("contains the core object/subject/topic/possessive/locative particles", () => {
    // Given: the reviewable particle table
    // When: the core particles every Korean sentence uses are looked up
    const core = ["을", "를", "이", "가", "은", "는", "의", "에", "에서", "으로", "로", "와", "과", "도", "만"];
    // Then: every one is present
    for (const particle of core) {
      expect(KOREAN_PARTICLES).toContain(particle);
    }
  });

  it("holds only Hangul strings of at most 2 syllables", () => {
    // Given: the particle table
    // When: each entry is inspected
    // Then: entries are short Hangul only (no NLP-grade suffixes)
    for (const particle of KOREAN_PARTICLES) {
      expect(particle).toMatch(/^[\uAC00-\uD7A3]{1,2}$/u);
    }
  });

  it("has no duplicate entries", () => {
    // Given: the particle table
    // When: it is deduplicated
    // Then: nothing is removed
    expect(new Set(KOREAN_PARTICLES).size).toBe(KOREAN_PARTICLES.length);
  });
});

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

interface MatchCase {
  readonly name: string;
  readonly term: string;
  readonly token: string;
  readonly expected: JosaMatch;
}

const MATCH_CASES: readonly MatchCase[] = [
  {
    name: "Korean term + object particle 를 wraps the stem only",
    term: "아타락시아",
    token: "아타락시아를",
    expected: {
      kind: "match",
      stem: "아타락시아",
      stemStart: 0,
      stemEnd: 5,
      particle: "를",
      particleStart: 5,
      particleEnd: 6,
    },
  },
  {
    name: "Korean term + 2-syllable particle 에서",
    term: "서울",
    token: "서울에서",
    expected: {
      kind: "match",
      stem: "서울",
      stemStart: 0,
      stemEnd: 2,
      particle: "에서",
      particleStart: 2,
      particleEnd: 4,
    },
  },
  {
    name: "Korean term with no remainder is an exact match",
    term: "아타락시아",
    token: "아타락시아",
    expected: {
      kind: "match",
      stem: "아타락시아",
      stemStart: 0,
      stemEnd: 5,
      particle: null,
      particleStart: null,
      particleEnd: null,
    },
  },
  {
    name: "unknown Korean remainder (하게) is never guessed",
    term: "아타락시아",
    token: "아타락시아하게",
    expected: { kind: "no_match" },
  },
  {
    name: "strict prefix of an unrelated Korean word without a particle boundary",
    term: "학교",
    token: "학교폭력",
    expected: { kind: "no_match" },
  },
  {
    name: "Korean term longer than the token",
    term: "아타락시아",
    token: "아타락",
    expected: { kind: "no_match" },
  },
  {
    name: "Latin term matches the whole token exactly",
    term: "ataraxia",
    token: "ataraxia",
    expected: {
      kind: "match",
      stem: "ataraxia",
      stemStart: 0,
      stemEnd: 8,
      particle: null,
      particleStart: null,
      particleEnd: null,
    },
  },
  {
    name: "Latin term is case-insensitive",
    term: "Ataraxia",
    token: "ataraxia",
    expected: {
      kind: "match",
      stem: "ataraxia",
      stemStart: 0,
      stemEnd: 8,
      particle: null,
      particleStart: null,
      particleEnd: null,
    },
  },
  {
    name: "Latin term keeps word-boundary matching — no particle logic",
    term: "ataraxia",
    token: "ataraxias",
    expected: { kind: "no_match" },
  },
  {
    name: "Latin term never absorbs a Hangul particle",
    term: "ataraxia",
    token: "ataraxia를",
    expected: { kind: "no_match" },
  },
  {
    name: "empty term is rejected",
    term: "",
    token: "아타락시아를",
    expected: { kind: "no_match" },
  },
  {
    name: "empty token is rejected",
    term: "아타락시아",
    token: "",
    expected: { kind: "no_match" },
  },
  {
    name: "both empty is rejected",
    term: "",
    token: "",
    expected: { kind: "no_match" },
  },
  {
    name: "non-Hangul remainder after a Korean term is not a particle",
    term: "아타락시아",
    token: "아타락시아x",
    expected: { kind: "no_match" },
  },
  {
    name: "punctuation remainder after a Korean term is not a particle",
    term: "아타락시아",
    token: "아타락시아!!",
    expected: { kind: "no_match" },
  },
  {
    name: "mixed-script term with a Korean particle wraps the stem only",
    term: "GPT모델",
    token: "GPT모델은",
    expected: {
      kind: "match",
      stem: "GPT모델",
      stemStart: 0,
      stemEnd: 5,
      particle: "은",
      particleStart: 5,
      particleEnd: 6,
    },
  },
  {
    name: "remainder longer than 2 syllables is not a particle",
    term: "서울",
    token: "서울에서도가",
    expected: { kind: "no_match" },
  },
];

describe("matchTermInToken", () => {
  for (const testCase of MATCH_CASES) {
    it(testCase.name, () => {
      // Given: a term and a delimited token
      // When: the matcher runs
      const actual = matchTermInToken(testCase.term, testCase.token);
      // Then: the reported span is exactly the expected stem/particle split
      expect(actual).toEqual(testCase.expected);
    });
  }

  it("reports stem offsets that slice the token back to the stem", () => {
    // Given: a Korean token carrying a particle
    // When: it matches
    const actual = matchTermInToken("아타락시아", "아타락시아를");
    // Then: the offsets are usable directly as token slice bounds
    expect(actual.kind).toBe("match");
    if (actual.kind !== "match") return;
    expect("아타락시아를".slice(actual.stemStart, actual.stemEnd)).toBe("아타락시아");
    expect("아타락시아를".slice(actual.particleStart ?? 0, actual.particleEnd ?? 0)).toBe("를");
  });
});
