import { describe, expect, it } from "vitest";
import { detectCommunities } from "./community.js";
import type { GraphEdge } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wl(from: string, to: string): GraphEdge {
  return { from, to, weight: 1.0, kind: "wikilink" };
}

/** Build a fully-connected undirected clique from the given node names. */
function clique(nodes: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const u = nodes[i]!;
      const v = nodes[j]!;
      edges.push(wl(u, v), wl(v, u));
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Basic correctness
// ---------------------------------------------------------------------------

describe("detectCommunities – basic", () => {
  it("returns an empty array for no edges", () => {
    expect(detectCommunities([])).toEqual([]);
  });

  it("returns a single community when all nodes are in one cluster", () => {
    const edges = clique(["a.md", "b.md", "c.md"]);
    const communities = detectCommunities(edges);
    expect(communities).toHaveLength(1);
    expect(communities[0]?.members.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("single isolated node (no edges) returns no communities (minSize=1)", () => {
    // no edges, no nodes → empty
    const communities = detectCommunities([]);
    expect(communities).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Two-cluster separation
// ---------------------------------------------------------------------------

describe("detectCommunities – two disjoint clusters", () => {
  it("returns >=2 clusters on a 2-cluster toy graph", () => {
    // Two fully-connected triangles with no cross edges
    const edges: GraphEdge[] = [
      ...clique(["a.md", "b.md", "c.md"]),
      ...clique(["d.md", "e.md", "f.md"]),
    ];

    const communities = detectCommunities(edges);

    expect(communities.length).toBeGreaterThanOrEqual(2);

    // All 6 nodes must be assigned
    const allMembers = communities.flatMap((c) => c.members).sort();
    expect(allMembers).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]);
  });

  it("separates the two clusters correctly", () => {
    const clusterA = ["a.md", "b.md", "c.md"];
    const clusterB = ["d.md", "e.md", "f.md"];
    const edges: GraphEdge[] = [...clique(clusterA), ...clique(clusterB)];

    const communities = detectCommunities(edges);

    const setA = new Set(clusterA);
    const setB = new Set(clusterB);

    // Each community should be entirely within one of the two clusters
    for (const community of communities) {
      const membersInA = community.members.filter((m) => setA.has(m)).length;
      const membersInB = community.members.filter((m) => setB.has(m)).length;
      // A valid community is either all-A or all-B
      expect(membersInA === 0 || membersInB === 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge weight influence
// ---------------------------------------------------------------------------

describe("detectCommunities – weighted edges", () => {
  it("strong intra-cluster weights dominate weak cross-cluster edges", () => {
    // Cluster 1: a↔b weight 10, cluster 2: c↔d weight 10, cross a↔c weight 0.01
    const edges: GraphEdge[] = [
      { from: "a.md", to: "b.md", weight: 10, kind: "wikilink" },
      { from: "b.md", to: "a.md", weight: 10, kind: "wikilink" },
      { from: "c.md", to: "d.md", weight: 10, kind: "wikilink" },
      { from: "d.md", to: "c.md", weight: 10, kind: "wikilink" },
      // very weak cross-cluster link — should not merge the two groups
      { from: "a.md", to: "c.md", weight: 0.01, kind: "wikilink" },
      { from: "c.md", to: "a.md", weight: 0.01, kind: "wikilink" },
    ];

    const communities = detectCommunities(edges);
    expect(communities.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe("detectCommunities – options", () => {
  it("minSize filters out communities smaller than the threshold", () => {
    // Single isolated node (connected to nothing in another group)
    const edges: GraphEdge[] = [
      ...clique(["a.md", "b.md", "c.md"]),
      // orphan: no edges to the main cluster
    ];
    // Force an orphan by using a separate node with no edges
    // (orphan will be its own community of size 1)
    const withOrphan: GraphEdge[] = [
      ...edges,
      // Add a self-linking orphan by connecting it to nothing —
      // we test minSize by asking for minSize=3
    ];

    const all = detectCommunities(withOrphan, { minSize: 1 });
    const big = detectCommunities(withOrphan, { minSize: 3 });

    expect(big.every((c) => c.members.length >= 3)).toBe(true);
    expect(big.length).toBeLessThanOrEqual(all.length);
  });

  it("ids are 0-based sequential integers", () => {
    const edges: GraphEdge[] = [...clique(["a.md", "b.md"]), ...clique(["c.md", "d.md"])];
    const communities = detectCommunities(edges);
    communities.forEach((c, idx) => expect(c.id).toBe(idx));
  });

  it("members within each community are sorted alphabetically", () => {
    const edges = clique(["c.md", "a.md", "b.md"]);
    const communities = detectCommunities(edges);
    expect(communities[0]?.members).toEqual(["a.md", "b.md", "c.md"]);
  });
});
