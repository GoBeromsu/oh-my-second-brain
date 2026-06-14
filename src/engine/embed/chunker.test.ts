import { describe, it, expect } from "vitest";
import { chunkDocument } from "./chunker.js";

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

  it("respects maxTokens option by splitting large docs", () => {
    // ~4 chars per token; 200 lines × ~10 chars each = ~2000 chars ≈ 500 tokens
    const text = Array.from({ length: 200 }, (_, i) => `Item number ${i}`).join("\n");
    const small = chunkDocument("notes/split.md", text, { maxTokens: 50 });
    const large = chunkDocument("notes/split.md", text, { maxTokens: 10000 });
    expect(small.length).toBeGreaterThan(large.length);
  });
});
