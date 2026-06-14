import { describe, it, expect } from "vitest";
import { buildAdjacency, traverseGraph } from "./traverse.js";
import type { GraphEdge } from "../types.js";

const EDGES: GraphEdge[] = [
  { from: "a.md", to: "b.md", weight: 3.0, kind: "wikilink" },
  { from: "b.md", to: "c.md", weight: 3.0, kind: "wikilink" },
  { from: "a.md", to: "c.md", weight: 1.0, kind: "type-affinity" },
  { from: "c.md", to: "d.md", weight: 2.0, kind: "frontmatter" },
];

describe("buildAdjacency", () => {
  it("creates adjacency map with correct neighbor counts", () => {
    const adj = buildAdjacency(EDGES);
    expect(adj.get("a.md")?.length).toBe(2); // b.md, c.md
    expect(adj.get("b.md")?.length).toBe(1); // c.md
  });

  it("skips zero-weight edges", () => {
    const edges: GraphEdge[] = [
      { from: "x.md", to: "y.md", weight: 0, kind: "unknown-ref" },
    ];
    const adj = buildAdjacency(edges);
    expect(adj.get("x.md")).toBeUndefined();
  });

  it("sums duplicate edges between same pair", () => {
    const edges: GraphEdge[] = [
      { from: "a.md", to: "b.md", weight: 2.0, kind: "wikilink" },
      { from: "a.md", to: "b.md", weight: 1.5, kind: "adamic-adar" },
    ];
    const adj = buildAdjacency(edges);
    const edge = adj.get("a.md")?.find((e) => e.to === "b.md");
    expect(edge?.weight).toBeCloseTo(3.5);
  });
});

describe("traverseGraph BFS", () => {
  const adj = buildAdjacency(EDGES);

  it("returns direct neighbors at depth 1", async () => {
    const hits = await traverseGraph(adj, { mode: "bfs", seed: "a.md", depth: 1 });
    const paths = hits.map((h) => h.docPath);
    expect(paths).toContain("b.md");
    expect(paths).toContain("c.md");
    expect(paths).not.toContain("a.md"); // seed excluded
  });

  it("depth-2 BFS reaches d.md via c.md", async () => {
    const hits = await traverseGraph(adj, { mode: "bfs", seed: "a.md", depth: 2 });
    const paths = hits.map((h) => h.docPath);
    expect(paths).toContain("d.md");
  });

  it("depth-1 BFS does NOT reach d.md", async () => {
    const hits = await traverseGraph(adj, { mode: "bfs", seed: "a.md", depth: 1 });
    const paths = hits.map((h) => h.docPath);
    expect(paths).not.toContain("d.md");
  });

  it("scores decay with hop distance", async () => {
    const hits = await traverseGraph(adj, { mode: "bfs", seed: "a.md", depth: 2 });
    const hitB = hits.find((h) => h.docPath === "b.md");
    const hitD = hits.find((h) => h.docPath === "d.md");
    expect(hitB?.score).toBeCloseTo(1 / 2); // depth 1
    expect(hitD?.score).toBeCloseTo(1 / 3); // depth 2
  });

  it("unknown seed returns empty list", async () => {
    const hits = await traverseGraph(adj, { mode: "bfs", seed: "nonexistent.md", depth: 2 });
    expect(hits).toEqual([]);
  });
});

describe("traverseGraph DFS", () => {
  const adj = buildAdjacency(EDGES);

  it("DFS mode visits all depth-1 neighbors of the seed", async () => {
    const dfs = await traverseGraph(adj, { mode: "dfs", seed: "a.md", depth: 2 });
    const paths = dfs.map((h) => h.docPath);
    // a→b and a→c are direct depth-1 links; both must appear
    expect(paths).toContain("b.md");
    expect(paths).toContain("c.md");
  });

  it("DFS depth-1 excludes the seed itself", async () => {
    const dfs = await traverseGraph(adj, { mode: "dfs", seed: "a.md", depth: 1 });
    const paths = dfs.map((h) => h.docPath);
    expect(paths).not.toContain("a.md");
  });
});

describe("traverseGraph community (falls back to BFS)", () => {
  const adj = buildAdjacency(EDGES);

  it("community mode returns non-empty hits", async () => {
    const hits = await traverseGraph(adj, { mode: "community", seed: "a.md", depth: 2 });
    expect(hits.length).toBeGreaterThan(0);
  });
});
