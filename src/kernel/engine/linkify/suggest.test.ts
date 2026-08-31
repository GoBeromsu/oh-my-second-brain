/**
 * Suggest tests — the span detector's behavioural contract.
 *
 * Every rule this suite locks is a rule that, if broken, corrupts a user's
 * vault: linking inside code, linking a note to itself, silently picking one of
 * two notes that both claim a word, or linking the same term ten times in one
 * note.
 */

import { describe, it, expect } from "vitest";
import { suggestLinks } from "./suggest.js";
import type { LinkCandidate, TermNote } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATARAXIA: TermNote = {
  path: "terms/Ataraxia.md",
  aliases: ["아타락시아", "tranquility"],
};

const STOICISM: TermNote = {
  path: "terms/Stoicism.md",
  aliases: [],
};

const SELF: TermNote = {
  path: "notes/Ataraxia.md",
  aliases: [],
};

function candidateFor(candidates: readonly LinkCandidate[], text: string): LinkCandidate | undefined {
  return candidates.find((c) => c.matchedText === text);
}

// ---------------------------------------------------------------------------
// Surface matching
// ---------------------------------------------------------------------------

describe("suggestLinks — surface matching", () => {
  it("proposes an exact basename match in prose", () => {
    // Given: a note mentioning a term note's basename
    const body = "The goal is Ataraxia for the sage.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the exact surface is proposed as a bare wikilink
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      matchedText: "Ataraxia",
      targetPath: "terms/Ataraxia.md",
      renderedReplacement: "[[Ataraxia]]",
      source: "basename",
      ambiguous: false,
    });
    expect(body.slice(candidates[0]?.startOffset ?? 0, candidates[0]?.endOffset ?? 0)).toBe("Ataraxia");
  });

  it("proposes an alias match rendered with the alias as display text", () => {
    // Given: a body using an alias, not the basename
    const body = "He sought tranquility above all.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the alias renders as [[Target|alias]]
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      matchedText: "tranquility",
      renderedReplacement: "[[Ataraxia|tranquility]]",
      source: "alias",
    });
  });

  it("ranks an exact basename hit above an alias hit of a DIFFERENT note", () => {
    // Given: a body naming one note by basename and another by alias, alias first
    const apatheia: TermNote = { path: "terms/Apatheia.md", concept: "term", aliases: ["equanimity"] };
    const body = "equanimity precedes Stoicism.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [apatheia, STOICISM], { notePath: "notes/Sage.md" });
    // Then: the basename candidate outranks the alias one despite appearing later
    const exact = candidateFor(candidates, "Stoicism");
    const alias = candidateFor(candidates, "equanimity");
    expect(exact).toBeDefined();
    expect(alias).toBeDefined();
    expect(exact?.confidence).toBeGreaterThan(alias?.confidence ?? Number.POSITIVE_INFINITY);
    expect(candidates[0]?.source).toBe("basename");
  });

  it("matches case-insensitively but preserves the body's own casing", () => {
    // Given: prose using lowercase where the note title is capitalised
    const body = "true ataraxia matters\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the replacement keeps the surface, aliasing to the canonical target
    expect(candidates[0]?.matchedText).toBe("ataraxia");
    expect(candidates[0]?.renderedReplacement).toBe("[[Ataraxia|ataraxia]]");
  });

  it("does not match a term inside a larger Latin word", () => {
    // Given: prose where the term is a substring of another word
    const body = "Stoicisms and Stoicismy are not words.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [STOICISM], { notePath: "notes/Sage.md" });
    // Then: nothing is proposed
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Korean / josa
// ---------------------------------------------------------------------------

describe("suggestLinks — Korean stems", () => {
  it("matches a Korean alias carrying an object particle and links the stem only", () => {
    // Given: prose using a Korean alias with the 를 particle
    const body = "그는 아타락시아를 추구했다.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the span covers the stem, the particle stays outside the link
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate?.matchedText).toBe("아타락시아");
    expect(candidate?.renderedReplacement).toBe("[[Ataraxia|아타락시아]]");
    const spliced =
      body.slice(0, candidate?.startOffset ?? 0) +
      (candidate?.renderedReplacement ?? "") +
      body.slice(candidate?.endOffset ?? 0);
    expect(spliced).toBe("그는 [[Ataraxia|아타락시아]]를 추구했다.\n");
  });

  it("rejects a Korean token whose remainder is not a known particle", () => {
    // Given: prose where the alias is followed by a verb ending, not a particle
    const body = "그는 아타락시아하게 살았다.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: no guess is made
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Masking, first-occurrence, self-link
// ---------------------------------------------------------------------------

describe("suggestLinks — safety rules", () => {
  it("never proposes a span inside a fenced code block", () => {
    // Given: a body whose only mention of the term is inside a fence
    const body = "intro line\n\n```ts\nconst Ataraxia = 1;\n```\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: nothing is proposed
    expect(candidates).toEqual([]);
  });

  it("never proposes a span that duplicates an existing wikilink", () => {
    // Given: a body that already links the term once and mentions it again
    const body = "See [[Ataraxia]] here.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the existing link is left alone and not re-linked
    expect(candidates).toEqual([]);
  });

  it("proposes only the FIRST occurrence of a term per note", () => {
    // Given: a body mentioning the same term three times
    const body = "Ataraxia now. Ataraxia later. Ataraxia always.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: exactly one candidate, at the first occurrence
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.startOffset).toBe(0);
  });

  it("counts basename and alias surfaces of ONE note as the same term", () => {
    // Given: a body using the basename first and an alias later
    const body = "Ataraxia is calm; tranquility is its name.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: only the first surface of that note is proposed
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchedText).toBe("Ataraxia");
  });

  it("never links a note to itself", () => {
    // Given: a note whose own basename appears in its own body
    const body = "This note about Ataraxia is self-referential.\n";
    // When: links are suggested with that note as the source
    const candidates = suggestLinks(body, [SELF], { notePath: "notes/Ataraxia.md" });
    // Then: nothing is proposed
    expect(candidates).toEqual([]);
  });

  it("returns nothing for an empty body", () => {
    // Given: an empty note body
    // When: links are suggested
    const candidates = suggestLinks("", [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: there is nothing to propose
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

describe("suggestLinks — ambiguity", () => {
  const RIVAL: TermNote = { path: "terms/philosophy/Ataraxia.md", concept: "term", aliases: [] };

  it("flags a span claimed by two notes and does NOT auto-pick a winner", () => {
    // Given: two term notes sharing a basename (one with a shorter path)
    const body = "Ataraxia matters.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA, RIVAL], { notePath: "notes/Sage.md" });
    // Then: one ambiguous candidate naming both rivals, no shortest-path tie-break
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ambiguous).toBe(true);
    expect([...(candidates[0]?.rivalPaths ?? [])].sort()).toEqual([
      "terms/Ataraxia.md",
      "terms/philosophy/Ataraxia.md",
    ]);
  });

  it("leaves a single-claimant span unambiguous", () => {
    // Given: exactly one note claiming the surface
    const body = "Ataraxia matters.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA], { notePath: "notes/Sage.md" });
    // Then: the candidate is unambiguous and names one rival path only
    expect(candidates[0]?.ambiguous).toBe(false);
    expect(candidates[0]?.rivalPaths).toEqual(["terms/Ataraxia.md"]);
  });
});

// ---------------------------------------------------------------------------
// Candidate universe
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Optional rankers
// ---------------------------------------------------------------------------

describe("suggestLinks — injected rankers", () => {
  it("works with no rankers injected at all", () => {
    // Given: no lexical or vector ranker
    const body = "Ataraxia and Stoicism.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA, STOICISM], { notePath: "notes/Sage.md" });
    // Then: both surface-anchored candidates survive
    expect(candidates.map((c) => c.targetPath).sort()).toEqual([
      "terms/Ataraxia.md",
      "terms/Stoicism.md",
    ]);
  });

  it("uses queryLex only to re-rank surface-anchored candidates, never to add one", () => {
    // Given: a lexical ranker that boosts Stoicism and also names an unmentioned note
    const body = "Ataraxia and Stoicism.\n";
    const lex = (): readonly { readonly docPath: string; readonly score: number }[] => [
      { docPath: "terms/Stoicism.md", score: 10 },
      { docPath: "terms/NeverMentioned.md", score: 99 },
    ];
    // When: links are suggested with that ranker
    const candidates = suggestLinks(body, [ATARAXIA, STOICISM], {
      notePath: "notes/Sage.md",
      queryLex: lex,
    });
    // Then: the boosted candidate leads and no unmentioned note is invented
    expect(candidates[0]?.targetPath).toBe("terms/Stoicism.md");
    expect(candidates.map((c) => c.targetPath)).not.toContain("terms/NeverMentioned.md");
    expect(candidates).toHaveLength(2);
  });

  it("lets an injected vector veto drop a candidate without adding any", () => {
    // Given: a vector veto that rejects Stoicism
    const body = "Ataraxia and Stoicism.\n";
    // When: links are suggested with that veto
    const candidates = suggestLinks(body, [ATARAXIA, STOICISM], {
      notePath: "notes/Sage.md",
      vectorVeto: (candidate) => candidate.targetPath === "terms/Stoicism.md",
    });
    // Then: only the surviving candidate remains
    expect(candidates.map((c) => c.targetPath)).toEqual(["terms/Ataraxia.md"]);
  });

  it("ignores the vector veto when the embedding gate is closed", () => {
    // Given: a veto paired with an explicitly closed embedding gate
    const body = "Ataraxia and Stoicism.\n";
    // When: links are suggested
    const candidates = suggestLinks(body, [ATARAXIA, STOICISM], {
      notePath: "notes/Sage.md",
      embeddingConfigured: false,
      vectorVeto: () => true,
    });
    // Then: nothing is vetoed — the veto is inert without an embedding config
    expect(candidates).toHaveLength(2);
  });
});
