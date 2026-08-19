import { describe, expect, it } from "vitest";
import {
  buildWikilinkIndex,
  buildWikilinkIndexWithFrontmatter,
  resolveWikilink,
  wikilinkEdges,
} from "./resolver.js";

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

describe("buildWikilinkIndexWithFrontmatter", () => {
  const DOCS = [
    {
      path: "concepts/ataraxia-note.md",
      frontmatter: { aliases: ["Ataraxia", "アタラクシア"] },
    },
    { path: "projects/foo.md", frontmatter: { aliases: ["some-alias"] } },
    { path: "notes/deep/plain.md", frontmatter: {} },
  ];
  const ALIAS_INDEX = buildWikilinkIndexWithFrontmatter(DOCS);

  it("path-only builder yields an empty byAlias map", () => {
    expect(INDEX.byAlias.size).toBe(0);
  });

  it("latin alias resolves to the declaring note", () => {
    const result = resolveWikilink("[[Ataraxia]]", ALIAS_INDEX);
    expect(result.docPath).toBe("concepts/ataraxia-note.md");
  });

  it("non-latin alias resolves to the declaring note", () => {
    const result = resolveWikilink("[[アタラクシア]]", ALIAS_INDEX);
    expect(result.docPath).toBe("concepts/ataraxia-note.md");
  });

  it("alias lookup is case-insensitive", () => {
    expect(resolveWikilink("[[ATARAXIA]]", ALIAS_INDEX).docPath).toBe(
      "concepts/ataraxia-note.md",
    );
  });

  it("previously unresolvable alias link now resolves", () => {
    expect(resolveWikilink("some-alias", INDEX).docPath).toBeNull();
    expect(resolveWikilink("some-alias", ALIAS_INDEX).docPath).toBe("projects/foo.md");
  });

  it("exact path and basename still win over an alias claiming the same name", () => {
    const shadowed = buildWikilinkIndexWithFrontmatter([
      { path: "projects/foo.md", frontmatter: {} },
      { path: "decoys/decoy.md", frontmatter: { aliases: ["foo"] } },
    ]);
    expect(resolveWikilink("foo", shadowed).docPath).toBe("projects/foo.md");
  });

  it("ambiguous alias: shortest path wins, ties broken alphabetically", () => {
    const ambiguous = buildWikilinkIndexWithFrontmatter([
      { path: "a/b/c/deep.md", frontmatter: { aliases: ["shared"] } },
      { path: "top.md", frontmatter: { aliases: ["shared"] } },
    ]);
    expect(resolveWikilink("shared", ambiguous).docPath).toBe("top.md");
  });

  it("malformed aliases (non-string, empty, non-array) are skipped without throwing", () => {
    const malformed = buildWikilinkIndexWithFrontmatter([
      { path: "a.md", frontmatter: { aliases: [42, null, "", "  ", { x: 1 }, "ok"] } },
      { path: "b.md", frontmatter: { aliases: "single-string" } },
      { path: "c.md", frontmatter: { aliases: 7 } },
      { path: "d.md", frontmatter: {} },
    ]);
    expect(resolveWikilink("ok", malformed).docPath).toBe("a.md");
    expect(resolveWikilink("single-string", malformed).docPath).toBe("b.md");
    expect(malformed.byAlias.has("")).toBe(false);
    expect(resolveWikilink("42", malformed).docPath).toBeNull();
  });

  it("display alias in [[Target|Alias]] is still stripped, not resolved", () => {
    const result = resolveWikilink("[[projects/foo|Ataraxia]]", ALIAS_INDEX);
    expect(result.target).toBe("projects/foo");
    expect(result.docPath).toBe("projects/foo.md");
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
