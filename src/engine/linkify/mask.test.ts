/**
 * Mask tests — every markdown construct that must never be linkified.
 *
 * The contract under test: `maskBody` tiles the body into protected + free
 * spans that together cover it exactly once, and every construct listed in the
 * table below lands entirely inside a protected span.
 */

import { describe, it, expect } from "vitest";
import { maskBody, isProtected, freeText } from "./mask.js";
import type { MaskResult, ProtectedKind } from "./types.js";

// ---------------------------------------------------------------------------
// Structural invariants (hold for every input)
// ---------------------------------------------------------------------------

/** Assert protected+free tile [0, body.length) with no overlap and no gap. */
function expectTiling(body: string, mask: MaskResult): void {
  const all = [
    ...mask.protectedSpans.map((s) => ({ start: s.start, end: s.end })),
    ...mask.freeSpans.map((s) => ({ start: s.start, end: s.end })),
  ].sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const span of all) {
    expect(span.end).toBeGreaterThan(span.start);
    expect(span.start).toBe(cursor);
    cursor = span.end;
  }
  expect(cursor).toBe(body.length);
}

/** Every offset covered by `needle` (first occurrence) is protected. */
function expectWhollyProtected(body: string, needle: string, mask: MaskResult): void {
  const start = body.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = start; i < start + needle.length; i += 1) {
    expect(isProtected(mask, i), `offset ${String(i)} (${JSON.stringify(body[i])}) should be protected`).toBe(true);
  }
}

/** Every offset covered by `needle` (first occurrence) is free. */
function expectWhollyFree(body: string, needle: string, mask: MaskResult): void {
  const start = body.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = start; i < start + needle.length; i += 1) {
    expect(isProtected(mask, i), `offset ${String(i)} (${JSON.stringify(body[i])}) should be free`).toBe(false);
  }
}

describe("maskBody — structural invariants", () => {
  const BODIES: readonly { readonly name: string; readonly body: string }[] = [
    { name: "empty body", body: "" },
    { name: "plain prose", body: "ataraxia is calm" },
    { name: "frontmatter only", body: "---\ntitle: X\n---\n" },
    { name: "unterminated fence", body: "before\n```ts\nconst a = 1;\n" },
    { name: "unterminated inline code", body: "prose `unclosed span\nmore" },
    { name: "nested brackets", body: "see [[a [[b]] c]] and [x [y](z)](w)\n" },
    { name: "crlf line endings", body: "# H\r\n\r\ntext `code` end\r\n" },
  ];

  for (const { name, body } of BODIES) {
    it(`tiles the body exactly once for ${name}`, () => {
      // Given: a body that may be malformed
      // When: it is masked
      const mask = maskBody(body);
      // Then: protected+free spans cover every offset exactly once, in order
      expectTiling(body, mask);
    });
  }

  it("returns no spans at all for an empty body", () => {
    // Given: an empty note body
    // When: it is masked
    const mask = maskBody("");
    // Then: there is nothing to protect and nothing to scan
    expect(mask.protectedSpans).toEqual([]);
    expect(mask.freeSpans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-construct protection
// ---------------------------------------------------------------------------

interface ProtectCase {
  readonly name: string;
  readonly body: string;
  readonly protectedText: string;
  readonly kind: ProtectedKind;
  readonly freeText?: string;
}

const PROTECT_CASES: readonly ProtectCase[] = [
  {
    name: "leading frontmatter block",
    body: "---\ntitle: Ataraxia\naliases: [calm]\n---\n\nataraxia in prose\n",
    protectedText: "---\ntitle: Ataraxia\naliases: [calm]\n---",
    kind: "frontmatter",
    freeText: "ataraxia in prose",
  },
  {
    name: "backtick fenced code block",
    body: "prose one\n\n```ts\nconst ataraxia = 1;\n```\n\nprose two\n",
    protectedText: "```ts\nconst ataraxia = 1;\n```",
    kind: "fenced-code",
    freeText: "prose two",
  },
  {
    name: "tilde fenced code block",
    body: "prose\n\n~~~\nataraxia\n~~~\n\nafter\n",
    protectedText: "~~~\nataraxia\n~~~",
    kind: "fenced-code",
    freeText: "after",
  },
  {
    name: "unterminated fence runs to end of body",
    body: "before\n\n```\nataraxia forever\n",
    protectedText: "```\nataraxia forever\n",
    kind: "fenced-code",
    freeText: "before",
  },
  {
    name: "inline code span",
    body: "call `ataraxia()` now\n",
    protectedText: "`ataraxia()`",
    kind: "inline-code",
    freeText: "now",
  },
  {
    name: "double-backtick inline span containing a backtick",
    body: "use ``a ` b`` here\n",
    protectedText: "``a ` b``",
    kind: "inline-code",
    freeText: "here",
  },
  {
    name: "existing wikilink including its alias",
    body: "see [[Ataraxia|아타락시아]] there\n",
    protectedText: "[[Ataraxia|아타락시아]]",
    kind: "wikilink",
    freeText: "there",
  },
  {
    name: "markdown link label and target",
    body: "read [Ataraxia](notes/ataraxia.md) today\n",
    protectedText: "[Ataraxia](notes/ataraxia.md)",
    kind: "markdown-link",
    freeText: "today",
  },
  {
    name: "image embed label and target",
    body: "pic ![Ataraxia](img/a.png) end\n",
    protectedText: "![Ataraxia](img/a.png)",
    kind: "image-embed",
    freeText: "end",
  },
  {
    name: "wiki image embed",
    body: "pic ![[Ataraxia.png]] end\n",
    protectedText: "![[Ataraxia.png]]",
    kind: "image-embed",
    freeText: "end",
  },
  {
    name: "html tag",
    body: "raw <span class=\"ataraxia\">x</span> done\n",
    protectedText: "<span class=\"ataraxia\">",
    kind: "html",
    freeText: "done",
  },
  {
    name: "ATX heading line",
    body: "## Ataraxia heading\n\nbody ataraxia\n",
    protectedText: "## Ataraxia heading",
    kind: "heading",
    freeText: "body ataraxia",
  },
  {
    name: "setext heading line and underline",
    body: "Ataraxia title\n=====\n\nprose\n",
    protectedText: "Ataraxia title\n=====",
    kind: "heading",
    freeText: "prose",
  },
  {
    name: "bare url",
    body: "src https://example.com/ataraxia?x=1 end\n",
    protectedText: "https://example.com/ataraxia?x=1",
    kind: "url",
    freeText: "end",
  },
  {
    name: "block id at line end",
    body: "a sentence about ataraxia ^blk-01\n",
    protectedText: "^blk-01",
    kind: "block-id",
    freeText: "a sentence about ataraxia",
  },
  {
    name: "hashtag",
    body: "tagged #ataraxia and prose\n",
    protectedText: "#ataraxia",
    kind: "tag",
    freeText: "and prose",
  },
];

describe("maskBody — protected constructs", () => {
  for (const testCase of PROTECT_CASES) {
    it(`protects ${testCase.name}`, () => {
      // Given: a body containing the construct
      // When: it is masked
      const mask = maskBody(testCase.body);
      // Then: every offset of the construct is protected, under the right kind
      expectTiling(testCase.body, mask);
      expectWhollyProtected(testCase.body, testCase.protectedText, mask);
      const start = testCase.body.indexOf(testCase.protectedText);
      const owner = mask.protectedSpans.find((s) => s.start <= start && start < s.end);
      expect(owner?.kind).toBe(testCase.kind);
      if (testCase.freeText !== undefined) {
        expectWhollyFree(testCase.body, testCase.freeText, mask);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Non-protection: prose stays scannable
// ---------------------------------------------------------------------------

describe("maskBody — free regions", () => {
  it("leaves ordinary prose entirely free", () => {
    // Given: a body with no markdown constructs
    const body = "ataraxia 아타락시아를 논한다\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: nothing is protected
    expect(mask.protectedSpans).toEqual([]);
    expect(freeText(body, mask)).toEqual([body]);
  });

  it("does not treat a mid-word hash or caret as a tag or block id", () => {
    // Given: prose where # and ^ are not at a construct position
    const body = "a#b and x^2 are ataraxia math\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: the whole line stays free
    expect(mask.protectedSpans).toEqual([]);
  });

  it("keeps frontmatter protection to a LEADING block only", () => {
    // Given: a --- rule in the middle of the body (a thematic break, not frontmatter)
    const body = "prose one\n\n---\n\nprose two about ataraxia\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: no frontmatter span is claimed and the later prose stays free
    expect(mask.protectedSpans.filter((s) => s.kind === "frontmatter")).toEqual([]);
    expectWhollyFree(body, "prose two about ataraxia", mask);
  });

  it("protects prose inside a fence even when the fence holds link syntax", () => {
    // Given: a fenced block containing text that also looks like prose
    const body = "intro ataraxia\n\n```md\nataraxia in code\n```\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: only the outside occurrence is free
    expectWhollyFree(body, "intro ataraxia", mask);
    expectWhollyProtected(body, "ataraxia in code", mask);
  });
});

// ---------------------------------------------------------------------------
// Overlapping constructs
// ---------------------------------------------------------------------------

describe("maskBody — overlapping constructs merge without duplication", () => {
  it("merges a url inside a markdown link target into one protected region", () => {
    // Given: a markdown link whose target is a bare-url-shaped string
    const body = "see [x](https://example.com/a) end\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: the tiling still holds and the whole link is protected
    expectTiling(body, mask);
    expectWhollyProtected(body, "[x](https://example.com/a)", mask);
  });

  it("does not report the same offset in two protected spans", () => {
    // Given: a heading that itself contains a wikilink and inline code
    const body = "# Head [[A]] `c`\n\nprose\n";
    // When: it is masked
    const mask = maskBody(body);
    // Then: spans are disjoint and ascending
    expectTiling(body, mask);
    let previousEnd = -1;
    for (const span of mask.protectedSpans) {
      expect(span.start).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = span.end;
    }
  });
});
