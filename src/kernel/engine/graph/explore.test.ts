import { describe, expect, it } from "vitest";
import { exploreEngineGraph } from "./explore.js";
import type { EngineGraphNode } from "./node.js";
import type { GraphEdge } from "../types.js";

function node(path: string, axes: Readonly<Record<string, readonly string[]>>, terms: readonly string[]): EngineGraphNode {
  return {
    path,
    template: path === "seed.md" ? "seed" : "reference",
    folder: "notes",
    axes,
    wikilinks: [],
    bodyPreview: "",
    searchTerms: new Set(terms),
  };
}

const longQuery = "architecture boundaries dependencies interfaces abstractions coupling cohesion modules testing contracts invariants adapters ports domain application infrastructure persistence delivery observability reliability";
const queryTerms = longQuery.split(" ");

describe("exploreEngineGraph neighbour ranking", () => {
  it("uses reason count before lexical overlap and exposes lexical scores", () => {
    const nodes = [
      node("seed.md", { topic: ["shared"] }, []),
      node("more-reasons.md", { topic: ["shared"] }, []),
      node("stronger-lexical.md", {}, queryTerms),
    ];
    const edges: GraphEdge[] = [
      { from: "seed.md", to: "more-reasons.md", weight: 1, kind: "wikilink" },
      { from: "seed.md", to: "stronger-lexical.md", weight: 1, kind: "wikilink" },
    ];

    const result = exploreEngineGraph(nodes, edges, { template: "seed", query: longQuery });

    expect(result.neighbors.map((neighbor) => neighbor.path)).toEqual([
      "more-reasons.md",
      "stronger-lexical.md",
    ]);
    expect(result.neighbors.map((neighbor) => neighbor.score)).toEqual([0, expect.any(Number)]);
    expect(result.neighbors[1]?.score).toBeGreaterThan(1);
  });

  it("uses lexical overlap to break equal reason-count ties", () => {
    const nodes = [
      node("seed.md", {}, []),
      node("weaker-lexical.md", {}, [queryTerms[0]!]),
      node("stronger-lexical.md", {}, queryTerms),
    ];
    const edges: GraphEdge[] = [
      { from: "seed.md", to: "weaker-lexical.md", weight: 1, kind: "wikilink" },
      { from: "seed.md", to: "stronger-lexical.md", weight: 1, kind: "wikilink" },
    ];

    const result = exploreEngineGraph(nodes, edges, { template: "seed", query: longQuery });

    expect(result.neighbors.map((neighbor) => neighbor.path)).toEqual([
      "stronger-lexical.md",
      "weaker-lexical.md",
    ]);
    expect(result.neighbors.map((neighbor) => neighbor.score)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(result.neighbors[0]!.score).toBeGreaterThan(result.neighbors[1]!.score);
    expect(result.neighbors[0]!.score).toBeLessThan(2);
  });
});
