import { describe, it, expect } from "vitest";
import { chunkDocument } from "./chunker.js";
import { UNTITLED_DOCUMENT_TITLE } from "../types.js";

/** A body long enough to span several chunks at a small token budget. */
function longBody(): string {
  return Array.from({ length: 400 }, (_, index) => `Body line number ${index}.`).join("\n");
}

describe("chunkDocument", () => {
  it("produces at least one chunk for non-empty text", () => {
    const chunks = chunkDocument("notes/test.md", "Hello world\nThis is a test.");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("returns empty array for blank text", () => {
    const chunks = chunkDocument("notes/empty.md", "   \n\n  ");
    expect(chunks.length).toBe(0);
  });

  it("sets docPath on every chunk", () => {
    const chunks = chunkDocument("projects/foo.md", "Line one\nLine two");
    for (const c of chunks) expect(c.docPath).toBe("projects/foo.md");
  });

  it("ordinals are zero-based and monotonically increasing", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkDocument("notes/big.md", text, { maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
  });

  it("sha is a 64-char hex string", () => {
    const chunks = chunkDocument("notes/sha.md", "Some content here");
    expect(chunks[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two chunks with identical text get the same sha", () => {
    const c1 = chunkDocument("a.md", "same content");
    const c2 = chunkDocument("b.md", "same content");
    expect(c1[0]?.sha).toBe(c2[0]?.sha);
  });

  it("tracks heading path for level-1 heading", () => {
    const text = "# Introduction\nSome text here.";
    const chunks = chunkDocument("notes/headings.md", text);
    expect(chunks[0]?.headingPath).toEqual(["Introduction"]);
  });

  it("tracks nested headings correctly", () => {
    const text = "# Chapter\n## Section\nContent here.";
    const chunks = chunkDocument("notes/nested.md", text);
    expect(chunks[0]?.headingPath).toContain("Chapter");
    expect(chunks[0]?.headingPath).toContain("Section");
  });

  it("carries the frontmatter title on every chunk", () => {
    const chunks = chunkDocument(
      "notes/titled.md",
      `---\ntitle: Stellar Nucleosynthesis\n---\n${longBody()}`,
      { maxTokens: 60 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.title).toBe("Stellar Nucleosynthesis");
  });

  it("falls back to the first H1 when frontmatter declares no title", () => {
    const chunks = chunkDocument("notes/h1.md", "# Braising Technique\nLow steady heat.");
    expect(chunks[0]?.title).toBe("Braising Technique");
  });

  it("prefers a frontmatter title over an H1", () => {
    const chunks = chunkDocument(
      "notes/both.md",
      "---\ntitle: Declared\n---\n# Heading Title\nBody.",
    );
    expect(chunks[0]?.title).toBe("Declared");
  });

  it("uses the untitled literal when no title is declared at all", () => {
    const chunks = chunkDocument("notes/bare.md", "Just body text, no title anywhere.");
    expect(chunks[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
  });

  it("ignores a blank frontmatter title rather than embedding an empty one", () => {
    const chunks = chunkDocument("notes/blank.md", "---\ntitle: '   '\n---\nBody text.");
    expect(chunks[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
  });

  it("still yields a title when frontmatter is malformed", () => {
    const chunks = chunkDocument("notes/broken.md", "---\ntitle: [broken\n---\n# Real Heading\nBody.");
    expect(chunks[0]?.title).toBe("Real Heading");
  });

  it("never mistakes a YAML frontmatter comment for the document title", () => {
    // A YAML comment is syntactically identical to an ATX H1. Scanning the raw
    // document for a heading would embed private metadata as the note's title,
    // making an internal remark searchable content.
    const chunks = chunkDocument(
      "notes/comment.md",
      "---\n# Internal note, do not ship\nstatus: draft\n---\nBody text here.",
    );
    expect(chunks[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
  });

  it("ignores an H1 inside a fenced code block", () => {
    const backticks = chunkDocument(
      "notes/fence.md",
      "Intro.\n\n```markdown\n# Sample Heading\n```\n\nMore body.",
    );
    const tildes = chunkDocument("notes/tilde.md", "Intro.\n\n~~~\n# Sample Heading\n~~~\n\nBody.");

    expect(backticks[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
    expect(tildes[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
  });

  it("finds a real H1 that follows a fenced code block", () => {
    const chunks = chunkDocument(
      "notes/after-fence.md",
      "Intro.\n\n```\n# Sample\n```\n\n# Real Title\nBody.",
    );
    expect(chunks[0]?.title).toBe("Real Title");
  });

  it("keeps a fence open across a shorter inner run", () => {
    // CommonMark closes a fence only on a run at least as long as the opener,
    // so the inner ``` does not end a ```` block and the heading stays sample text.
    const chunks = chunkDocument(
      "notes/nested-fence.md",
      "Intro.\n\n````\n```\n# Still Inside\n````\n\nBody.",
    );
    expect(chunks[0]?.title).toBe(UNTITLED_DOCUMENT_TITLE);
  });

  it("ignores a non-string frontmatter title instead of coercing it", () => {
    expect(chunkDocument("n.md", "---\ntitle: 12345\n---\nBody.")[0]?.title)
      .toBe(UNTITLED_DOCUMENT_TITLE);
    expect(chunkDocument("l.md", "---\ntitle:\n  - A\n  - B\n---\nBody.")[0]?.title)
      .toBe(UNTITLED_DOCUMENT_TITLE);
    expect(chunkDocument("z.md", "---\ntitle: null\n---\n# Real H1\nBody.")[0]?.title)
      .toBe("Real H1");
  });

  it("changes the sha of body-only chunks when only the title changes", () => {
    // The title reaches every chunk's embedding input, so a retitle must
    // invalidate chunks that do not themselves contain the title line.
    // Without a title-aware digest those chunks would be reported unchanged
    // and keep vectors encoding the OLD title.
    const body = longBody();
    const before = chunkDocument("notes/retitle.md", `---\ntitle: Before\n---\n${body}`, { maxTokens: 60 });
    const after = chunkDocument("notes/retitle.md", `---\ntitle: After\n---\n${body}`, { maxTokens: 60 });

    const tail = before.length - 1;
    expect(before.length).toBe(after.length);
    expect(before.length).toBeGreaterThan(1);
    // The final chunk's raw text is identical; only the document title differs.
    expect(after[tail]?.text).toBe(before[tail]?.text);
    expect(after[tail]?.sha).not.toBe(before[tail]?.sha);
  });

  it("keeps the sha stable when neither title nor text changes", () => {
    const raw = "---\ntitle: Stable\n---\nUnchanged body.";
    expect(chunkDocument("a.md", raw)[0]?.sha).toBe(chunkDocument("b.md", raw)[0]?.sha);
  });

  it("cannot be made to collide by moving a NUL across the title boundary", () => {
    // A bare separator is only unambiguous while the inputs cannot contain it.
    // Nothing forbids a NUL in note text, so ("a", "\0b") and ("a\0", "b") would
    // hash identically under plain concatenation, letting a crafted retitle
    // impersonate a body edit and suppress re-embedding.
    const left = chunkDocument("x.md", "---\ntitle: \"a\"\n---\n\u0000b");
    const right = chunkDocument("x.md", "---\ntitle: \"a\\u0000\"\n---\nb");

    expect(left[0]?.title).toBe("a");
    expect(right[0]?.title).toBe("a\u0000");
    expect(left[0]?.sha).not.toBe(right[0]?.sha);
  });

  it("respects maxTokens option by splitting large docs", () => {
    // ~4 chars per token; 200 lines × ~10 chars each = ~2000 chars ≈ 500 tokens
    const text = Array.from({ length: 200 }, (_, i) => `Item number ${i}`).join("\n");
    const small = chunkDocument("notes/split.md", text, { maxTokens: 50 });
    const large = chunkDocument("notes/split.md", text, { maxTokens: 10000 });
    expect(small.length).toBeGreaterThan(large.length);
  });
});
