import { describe, expect, it } from "vitest";
import { buildWikilinkIndex, resolveWikilink, wikilinkEdges } from "./resolver.js";

const VAULT_FILES = [
  "projects/foo.md",
  "projects/bar.md",
  "notes/deep/foo.md",       // ambiguous basename "foo" — deeper path
  "references/exact-path.md",
];

const INDEX = buildWikilinkIndex(VAULT_FILES);

describe("buildWikilinkIndex", () => {
  it("indexes all provided files", () => {
    // byPath has one entry per file (normalised to lowercase with .md)
    expect(INDEX.byPath.size).toBe(VAULT_FILES.length);
  });
});

describe("resolveWikilink", () => {
  it("exact match: resolves basename to the shallowest path", () => {
    const result = resolveWikilink("foo", INDEX);
    expect(result.target).toBe("foo");
    // "projects/foo.md" (depth 2) wins over "notes/deep/foo.md" (depth 3)
    expect(result.docPath).toBe("projects/foo.md");
  });

  it("strips [[  ]] brackets before resolving", () => {
    const result = resolveWikilink("[[bar]]", INDEX);
    expect(result.docPath).toBe("projects/bar.md");
  });

  it("alias: strips the alias and resolves the target", () => {
    const result = resolveWikilink("[[foo|My Alias]]", INDEX);
    expect(result.target).toBe("foo");
    expect(result.docPath).toBe("projects/foo.md");
  });

  it("heading: strips the heading anchor and resolves the target", () => {
    const result = resolveWikilink("[[foo#Section 1]]", INDEX);
    expect(result.target).toBe("foo");
    expect(result.docPath).toBe("projects/foo.md");
  });

  it("heading + alias: resolves correctly", () => {
    const result = resolveWikilink("[[bar#Details|See here]]", INDEX);
    expect(result.docPath).toBe("projects/bar.md");
  });

  it("exact vault-relative path (with .md) resolves to that file", () => {
    const result = resolveWikilink("references/exact-path.md", INDEX);
    expect(result.docPath).toBe("references/exact-path.md");
  });

  it("exact vault-relative path (without .md) resolves to that file", () => {
    const result = resolveWikilink("references/exact-path", INDEX);
    expect(result.docPath).toBe("references/exact-path.md");
  });

  it("case-insensitive basename match", () => {
    const result = resolveWikilink("FOO", INDEX);
    expect(result.docPath).toBe("projects/foo.md");
  });

  it("unresolvable: returns docPath null", () => {
    const result = resolveWikilink("nonexistent-note", INDEX);
    expect(result.target).toBe("nonexistent-note");
    expect(result.docPath).toBeNull();
  });

  it("empty string: returns docPath null", () => {
    const result = resolveWikilink("", INDEX);
    expect(result.docPath).toBeNull();
  });
});

describe("wikilinkEdges", () => {
  it("resolved link produces wikilink edge with correct weight", () => {
    const edgesOut = wikilinkEdges("source.md", ["foo"], INDEX, 3.0);
    expect(edgesOut).toHaveLength(1);
    expect(edgesOut[0]).toEqual({
      from: "source.md",
      to: "projects/foo.md",
      weight: 3.0,
      kind: "wikilink",
    });
  });

  it("unresolvable link produces unknown-ref edge with weight 0", () => {
    const edgesOut = wikilinkEdges("source.md", ["ghost-note"], INDEX);
    expect(edgesOut).toHaveLength(1);
    const e = edgesOut[0]!;
    expect(e.kind).toBe("unknown-ref");
    expect(e.weight).toBe(0);
    expect(e.to).toBe("ghost-note");
  });

  it("mixed links: resolved and unresolved in one batch", () => {
    const edgesOut = wikilinkEdges("source.md", ["foo", "ghost"], INDEX, 3.0);
    expect(edgesOut).toHaveLength(2);
    expect(edgesOut.find((e) => e.kind === "wikilink")?.to).toBe("projects/foo.md");
    expect(edgesOut.find((e) => e.kind === "unknown-ref")?.to).toBe("ghost");
  });
});
