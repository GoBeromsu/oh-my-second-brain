import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../ontology/loader.js";
import { retrieveMorningContext } from "./morning.js";
import { writeMorningVaultFixture } from "./morning-test-fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("morning context retrieval", () => {
  it("combines local graph hits with OMS native semantic candidates", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        limit: 2,
        syncBeforeSearch: true,
      },
    });

    expect(result.providers.semantic.available).toBe(true);
    expect(result.graph.seeds.map((node) => node.path)).toEqual(["references/Agent Retrieval.md"]);
    expect(result.hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor", "oms-semantic", "oms-semantic"]);
    expect(result.hits.find((hit) => hit.source === "oms-semantic")).toEqual(
      expect.objectContaining({
        path: "references/Agent Retrieval.md",
        evidence: expect.objectContaining({ lexical: true, vector: true }),
      }),
    );
    expect(result.semanticHits.map((hit) => hit.path)).toContain("references/Unrelated.md");
  });

  it("can restrict semantic candidates to the local graph when requested", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        limit: 3,
        scope: "graph",
        syncBeforeSearch: true,
      },
    });

    expect(result.hits.map((hit) => hit.source)).toEqual(
      expect.arrayContaining(["oms-seed", "oms-neighbor", "oms-semantic"]),
    );
    expect(result.semanticHits.map((hit) => hit.path)).not.toContain("references/Unrelated.md");
  });

  it("uses typed semantic query options and preserves native result context", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "fallback retrieve query",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        limit: 3,
        mode: "query",
        intent: "route semantic evidence through oms retrieve",
        lex: "agent retrieval",
        vec: "semantic notes about retrieval integration",
        hyde: "A note explaining how OMS semantic search is available from retrieve.",
        minScore: 0.01,
        syncBeforeSearch: true,
      },
    });

    expect(result.semanticHits[0]).toEqual(
      expect.objectContaining({
        path: "references/Agent Retrieval.md",
        context: expect.stringContaining("Agent retrieval"),
      }),
    );
    expect(result.hits.find((hit) => hit.source === "oms-semantic")).toEqual(
      expect.objectContaining({
        source: "oms-semantic",
        context: expect.stringContaining("Agent retrieval"),
      }),
    );
  });

  it("syncs embeddings before search when retrieve asks for fresh semantic storage", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        syncBeforeSearch: true,
        syncForce: true,
        index: "brain",
        chunkStrategy: "auto",
      },
    });

    expect(result.embeddingSync).toEqual(
      expect.objectContaining({
        available: true,
        storage: "qmd-sqlite",
        index: path.join(tmpVault, "brain"),
      }),
    );
    expect(result.embeddingSync?.steps.map((step) => step.name)).toEqual(["scan", "write-index", "status"]);
    expect(result.semanticHits).toHaveLength(1);
  });

  it("can route retrieve semantic sync through the JSON compatibility store when requested", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        syncBeforeSearch: true,
        syncForce: true,
        storage: "oms-native-json",
        modelPath: "/models/embed.gguf",
      },
    });

    expect(result.embeddingSync).toEqual(
      expect.objectContaining({
        available: true,
        storage: "oms-native-json",
      }),
    );
    expect(result.providers.semantic).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));
    expect(result.semanticHits).toHaveLength(1);
  });

  it("keeps graph results and skips semantic search when requested embedding sync fails", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
        syncBeforeSearch: true,
        index: ".",
      },
    });

    expect(result.embeddingSync).toEqual(expect.objectContaining({ available: false }));
    expect(result.providers.semantic).toEqual({
      available: false,
      reason: expect.stringContaining("embedding sync failed:"),
    });
    expect(result.semanticHits).toEqual([]);
    expect(result.hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor"]);
  });

  it("keeps graph results when the native semantic index is unavailable", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
      },
    });

    expect(result.providers.semantic).toEqual({
      available: false,
      reason: expect.stringContaining("OMS SQLite semantic store not found"),
    });
    expect(result.hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor"]);
  });

  it("keeps graph results and explains semantic provider failure when the native index is malformed", async () => {
    tmpVault = await writeMorningVaultFixture();
    await mkdir(path.join(tmpVault, ".oms"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "semantic-store.sqlite"), "not-sqlite", "utf-8");
    const ontology = await loadOntology(ontologyDir);

    const result = await retrieveMorningContext({
      vault: tmpVault,
      ontology,
      property: "tags",
      value: "agent-graph",
      query: "agent retrieval",
      limit: 1,
      maxNeighbors: 5,
      useCache: false,
      semantic: {
        enabled: true,
        collection: "obsidian",
      },
    });

    expect(result.providers.semantic).toEqual({
      available: false,
      reason: expect.stringContaining("SQLite semantic store"),
    });
    expect(result.semanticHits).toEqual([]);
    expect(result.hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor"]);
  });
});
