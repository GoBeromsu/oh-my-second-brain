import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, loadCachedGraph, saveCachedGraph } from "./builder.js";
import type { GraphEdge } from "../types.js";

let tmpVault: string;

beforeEach(async () => {
  tmpVault = await mkdtemp(path.join(tmpdir(), "oms-engine-graph-"));
});

afterEach(async () => {
  await rm(tmpVault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeVaultFile(relPath: string, content: string): Promise<void> {
  const full = path.join(tmpVault, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function edgesOfKind(edges: GraphEdge[], kind: GraphEdge["kind"]): GraphEdge[] {
  return edges.filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------
// Tier 1: wikilinks × 3.0
// ---------------------------------------------------------------------------

describe("Tier 1 – wikilink edges", () => {
  it("produces a wikilink edge with weight 3.0 for a resolved [[link]]", async () => {
    await writeVaultFile("a.md", "# A\n\nSee [[b]] for details.\n");
    await writeVaultFile("b.md", "# B\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const wikilinks = edgesOfKind(edges, "wikilink");

    expect(wikilinks).toContainEqual({
      from: "a.md",
      to: "b.md",
      weight: 3.0,
      kind: "wikilink",
    });
  });

  it("emits an unknown-ref edge (weight 0) for an unresolvable [[link]]", async () => {
    await writeVaultFile("a.md", "Link to [[ghost-note]] which does not exist.\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const unknowns = edgesOfKind(edges, "unknown-ref");

    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]).toMatchObject({ from: "a.md", weight: 0, kind: "unknown-ref" });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: frontmatter sources / relations × 4.0
// ---------------------------------------------------------------------------

describe("Tier 2 – frontmatter edges", () => {
  it("produces a frontmatter edge with weight 4.0 for a sources entry", async () => {
    await writeVaultFile(
      "note.md",
      "---\nsources:\n  - ref.md\n---\n# Note\n",
    );
    await writeVaultFile("ref.md", "# Ref\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const fm = edgesOfKind(edges, "frontmatter");

    expect(fm).toContainEqual({
      from: "note.md",
      to: "ref.md",
      weight: 4.0,
      kind: "frontmatter",
    });
  });

  it("produces a frontmatter edge with weight 4.0 for a relations entry", async () => {
    await writeVaultFile(
      "note.md",
      "---\nrelations:\n  - other\n---\n# Note\n",
    );
    await writeVaultFile("other.md", "# Other\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const fm = edgesOfKind(edges, "frontmatter");

    expect(fm).toContainEqual({
      from: "note.md",
      to: "other.md",
      weight: 4.0,
      kind: "frontmatter",
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Adamic-Adar × 1.5 — numeric correctness
// ---------------------------------------------------------------------------

describe("Tier 3 – Adamic-Adar edges", () => {
  it("computes correct Adamic-Adar weight for two nodes sharing one common neighbour", async () => {
    // Graph: a → c, b → c  (both link to c; c is the common neighbour)
    // Adjacency (undirected): adj(c) = {a, b}  — degree 2
    // AA(a, b) via c = 1/log(2)
    // Edge weight   = 1/log(2) * 1.5
    await writeVaultFile("a.md", "[[c]]\n");
    await writeVaultFile("b.md", "[[c]]\n");
    await writeVaultFile("c.md", "");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const aaEdges = edgesOfKind(edges, "adamic-adar");

    // Both directions emitted
    expect(aaEdges.length).toBeGreaterThanOrEqual(2);

    const expectedWeight = (1 / Math.log(2)) * 1.5;
    const ab = aaEdges.find((e) => e.from === "a.md" && e.to === "b.md");
    const ba = aaEdges.find((e) => e.from === "b.md" && e.to === "a.md");

    expect(ab).toBeDefined();
    expect(ba).toBeDefined();
    expect(ab?.weight).toBeCloseTo(expectedWeight, 10);
    expect(ba?.weight).toBeCloseTo(expectedWeight, 10);
  });

  it("Adamic-Adar accumulates correctly for two common neighbours", async () => {
    // Graph: a → c, a → d, b → c, b → d
    // adj(c) = {a,b}, adj(d) = {a,b}  — each degree 2
    // AA(a, b) = 1/log(2) + 1/log(2) = 2/log(2)
    // Edge weight = 2/log(2) * 1.5
    await writeVaultFile("a.md", "[[c]]\n[[d]]\n");
    await writeVaultFile("b.md", "[[c]]\n[[d]]\n");
    await writeVaultFile("c.md", "");
    await writeVaultFile("d.md", "");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const ab = edgesOfKind(edges, "adamic-adar").find(
      (e) => e.from === "a.md" && e.to === "b.md",
    );

    expect(ab).toBeDefined();
    expect(ab?.weight).toBeCloseTo((2 / Math.log(2)) * 1.5, 10);
  });

  it("no Adamic-Adar edges when no common neighbours exist", async () => {
    // a → b, c is isolated
    await writeVaultFile("a.md", "[[b]]\n");
    await writeVaultFile("b.md", "");
    await writeVaultFile("c.md", "");

    const edges = await buildGraph({ vaultPath: tmpVault });
    // b has degree 1 (only neighbour is a) → contrib = 0 → no AA edge
    expect(edgesOfKind(edges, "adamic-adar")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 4: type-affinity × 1.0
// ---------------------------------------------------------------------------

describe("Tier 4 – type-affinity edges", () => {
  it("produces type-affinity edges (weight 1.0) for notes in the same folder", async () => {
    await writeVaultFile("projects/alpha.md", "# Alpha\n");
    await writeVaultFile("projects/beta.md", "# Beta\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    const affinities = edgesOfKind(edges, "type-affinity");

    expect(affinities).toContainEqual({
      from: "projects/alpha.md",
      to: "projects/beta.md",
      weight: 1.0,
      kind: "type-affinity",
    });
    expect(affinities).toContainEqual({
      from: "projects/beta.md",
      to: "projects/alpha.md",
      weight: 1.0,
      kind: "type-affinity",
    });
  });

  it("does not emit type-affinity between notes in different folders", async () => {
    await writeVaultFile("folder1/x.md", "# X\n");
    await writeVaultFile("folder2/y.md", "# Y\n");

    const edges = await buildGraph({ vaultPath: tmpVault });
    expect(edgesOfKind(edges, "type-affinity")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cache round-trip
// ---------------------------------------------------------------------------

describe("cache helpers", () => {
  it("saveCachedGraph and loadCachedGraph round-trip GraphEdge[]", async () => {
    const cachePath = path.join(tmpVault, ".oms", "cache", "engine", "graph.json");
    const original: GraphEdge[] = [
      { from: "a.md", to: "b.md", weight: 3.0, kind: "wikilink" },
      { from: "b.md", to: "a.md", weight: 1.5, kind: "adamic-adar" },
    ];

    await saveCachedGraph(cachePath, original);
    const loaded = await loadCachedGraph(cachePath);

    expect(loaded).toEqual(original);
  });

  it("loadCachedGraph returns null when file does not exist", async () => {
    const result = await loadCachedGraph(path.join(tmpVault, "nonexistent.json"));
    expect(result).toBeNull();
  });
});
