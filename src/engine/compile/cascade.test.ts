import { describe, expect, it } from "vitest";
import { createNullGraph, createStubGraph, withCascade } from "./cascade.js";
import type { CompileResult } from "./types.js";

const baseResult: CompileResult = {
  body: "## Concept\nContent with [[wikilinks]]",
  sha: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  provenance: ["authored", "curated"],
};

describe("withCascade", () => {
  it("returns empty affected_backlinks when null graph is used", () => {
    const result = withCascade(baseResult, "concepts/foo.md", createNullGraph());
    expect(result.affected_backlinks).toEqual([]);
  });

  it("returns correct backlinks from stub graph", () => {
    const graph = createStubGraph({
      "concepts/foo.md": ["wiki/bar.md", "wiki/baz.md"],
    });
    const result = withCascade(baseResult, "concepts/foo.md", graph);
    expect(result.affected_backlinks).toEqual(["wiki/bar.md", "wiki/baz.md"]);
  });

  it("returns empty when concept has no backlinks in stub graph", () => {
    const graph = createStubGraph({ "concepts/other.md": ["wiki/x.md"] });
    const result = withCascade(baseResult, "concepts/foo.md", graph);
    expect(result.affected_backlinks).toEqual([]);
  });

  it("preserves all CompileResult fields in the returned CascadeResult", () => {
    const result = withCascade(baseResult, "concepts/foo.md", createNullGraph());
    expect(result.body).toBe(baseResult.body);
    expect(result.sha).toBe(baseResult.sha);
    expect(result.provenance).toEqual(baseResult.provenance);
  });

  it("affected_backlinks is an array even for unknown concept IDs", () => {
    const result = withCascade(baseResult, "concepts/missing.md", createNullGraph());
    expect(Array.isArray(result.affected_backlinks)).toBe(true);
  });
});

describe("createNullGraph", () => {
  it("always returns empty array for any path", () => {
    const graph = createNullGraph();
    expect(graph.getBacklinks("anything.md")).toEqual([]);
    expect(graph.getBacklinks("")).toEqual([]);
    expect(graph.getBacklinks("concepts/x.md")).toEqual([]);
  });
});

describe("createStubGraph", () => {
  it("maps multiple concepts independently", () => {
    const graph = createStubGraph({
      "a.md": ["x.md"],
      "b.md": ["y.md", "z.md"],
    });
    expect(graph.getBacklinks("a.md")).toEqual(["x.md"]);
    expect(graph.getBacklinks("b.md")).toEqual(["y.md", "z.md"]);
  });

  it("returns empty for paths not in the seed map", () => {
    const graph = createStubGraph({ "a.md": ["x.md"] });
    expect(graph.getBacklinks("c.md")).toEqual([]);
  });
});
