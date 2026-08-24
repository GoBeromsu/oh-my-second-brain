import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOntology } from "../ontology/loader.js";
import { retrieveMorningContext, type MorningSemanticBackend } from "./morning.js";
import { writeMorningVaultFixture } from "./morning-test-fixtures.js";
import type {
  SemanticDocumentResult,
  SemanticEmbeddingSyncResult,
  SemanticProviderStatus,
  SemanticQueryOptions,
  SemanticQueryResult,
  SemanticSearchHit,
} from "./semantic-contract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

function hit(p: string, extra: Partial<SemanticSearchHit> = {}): SemanticSearchHit {
  return {
    docid: p,
    score: 0.9,
    uri: `vault://${p}`,
    path: p,
    snippet: "Agent retrieval snippet",
    context: "Agent retrieval context",
    evidence: { lexical: true, vector: true },
    ...extra,
  };
}

const READY_STATUS: SemanticProviderStatus = {
  available: true,
  storage: "oms-native-json",
  models: { embedding: "stub" },
};

interface StubConfig {
  readonly status?: SemanticProviderStatus;
  readonly query?: SemanticQueryResult;
  readonly sync?: SemanticEmbeddingSyncResult | undefined;
  readonly documents?: SemanticDocumentResult;
}

interface StubBackend extends MorningSemanticBackend {
  readonly queryCalls: SemanticQueryOptions[];
  readonly getTargets: string[];
  readonly multiTargets: string[][];
}

function stubBackend(config: StubConfig = {}): StubBackend {
  const queryCalls: SemanticQueryOptions[] = [];
  const getTargets: string[] = [];
  const multiTargets: string[][] = [];
  return {
    queryCalls,
    getTargets,
    multiTargets,
    sync: () => Promise.resolve(config.sync),
    status: () => Promise.resolve(config.status ?? READY_STATUS),
    query: (opts) => {
      queryCalls.push(opts);
      return Promise.resolve(config.query ?? { available: true, hits: [] });
    },
    getDocument: (opts) => {
      getTargets.push(opts.target);
      return Promise.resolve(config.documents ?? { available: true, documents: [] });
    },
    multiGet: (opts) => {
      multiTargets.push([...opts.targets]);
      return Promise.resolve(config.documents ?? { available: true, documents: [] });
    },
  };
}

const BASE_OPTS = {
  property: "tags",
  value: "agent-graph",
  query: "agent retrieval",
  limit: 1,
  maxNeighbors: 5,
  useCache: false,
} as const;

describe("morning context retrieval", () => {
  it("combines local graph hits with engine semantic candidates", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      query: {
        available: true,
        hits: [hit("references/Agent Retrieval.md"), hit("references/Unrelated.md")],
      },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian", limit: 2 } },
      backend,
    );

    expect(result.providers.semantic.available).toBe(true);
    expect(result.graph.seeds.map((node) => node.path)).toEqual(["references/Agent Retrieval.md"]);
    expect(result.hits.map((h) => h.source)).toEqual(["oms-seed", "oms-neighbor", "oms-semantic", "oms-semantic"]);
    expect(result.hits.find((h) => h.source === "oms-semantic")).toEqual(
      expect.objectContaining({
        path: "references/Agent Retrieval.md",
        evidence: expect.objectContaining({ lexical: true, vector: true }),
      }),
    );
    expect(result.semanticHits.map((h) => h.path)).toContain("references/Unrelated.md");
  });

  it("restricts semantic candidates to the local graph when scope=graph", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      query: {
        available: true,
        hits: [hit("references/Agent Retrieval.md"), hit("references/Unrelated.md")],
      },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian", limit: 3, scope: "graph" } },
      backend,
    );

    expect(result.hits.map((h) => h.source)).toEqual(expect.arrayContaining(["oms-seed", "oms-neighbor", "oms-semantic"]));
    expect(result.semanticHits.map((h) => h.path)).not.toContain("references/Unrelated.md");
  });

  it("passes typed query options through to the backend", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      query: { available: true, hits: [hit("references/Agent Retrieval.md")] },
    });

    await retrieveMorningContext(
      {
        vault: tmpVault,
        ontology,
        ...BASE_OPTS,
        query: "fallback retrieve query",
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
        },
      },
      backend,
    );

    expect(backend.queryCalls).toHaveLength(1);
    expect(backend.queryCalls[0]).toEqual(
      expect.objectContaining({
        mode: "query",
        intent: "route semantic evidence through oms retrieve",
        lex: "agent retrieval",
        vec: "semantic notes about retrieval integration",
        minScore: 0.01,
      }),
    );
  });

  it("surfaces the embedding sync result when sync runs", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      sync: { available: true, storage: "oms-native-json", collection: "obsidian", status: READY_STATUS, steps: [] },
      query: { available: true, hits: [hit("references/Agent Retrieval.md")] },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian", syncBeforeSearch: true } },
      backend,
    );

    expect(result.embeddingSync).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));
    expect(result.semanticHits).toHaveLength(1);
  });

  it("keeps graph results and skips semantic search when embedding sync fails", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      sync: {
        available: false,
        reason: "OMS embedding provider is not configured.",
        storage: "oms-native-json",
        steps: [],
      },
      query: { available: true, hits: [hit("references/Agent Retrieval.md")] },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian", syncBeforeSearch: true } },
      backend,
    );

    expect(result.embeddingSync).toEqual(expect.objectContaining({ available: false }));
    expect(result.providers.semantic).toEqual({
      available: false,
      reason: expect.stringContaining("embedding sync failed:"),
    });
    expect(result.semanticHits).toEqual([]);
    expect(result.hits.map((h) => h.source)).toEqual(["oms-seed", "oms-neighbor"]);
    expect(backend.queryCalls).toHaveLength(0);
  });

  it("keeps graph results when the semantic provider is unavailable", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      status: { available: false, reason: "vector/HyDE require an embedding model" },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian" } },
      backend,
    );

    expect(result.providers.semantic).toEqual({
      available: false,
      reason: expect.stringContaining("embedding model"),
    });
    expect(result.semanticHits).toEqual([]);
    expect(result.hits.map((h) => h.source)).toEqual(["oms-seed", "oms-neighbor"]);
    expect(backend.queryCalls).toHaveLength(0);
  });

  it("hydrates the top semantic hit when requested", async () => {
    tmpVault = await writeMorningVaultFixture();
    const ontology = await loadOntology(ontologyDir);
    const backend = stubBackend({
      query: { available: true, hits: [hit("references/Agent Retrieval.md"), hit("references/Unrelated.md")] },
      documents: {
        available: true,
        documents: [{ target: "references/Agent Retrieval.md", path: "references/Agent Retrieval.md", content: "body" }],
      },
    });

    const result = await retrieveMorningContext(
      { vault: tmpVault, ontology, ...BASE_OPTS, semantic: { enabled: true, collection: "obsidian", hydrate: "top" } },
      backend,
    );

    expect(backend.multiTargets).toEqual([["references/Agent Retrieval.md"]]);
    expect(result.semanticDocuments.map((doc) => doc.path)).toEqual(["references/Agent Retrieval.md"]);
  });
});
