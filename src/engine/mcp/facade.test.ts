import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpEngineAdapter } from "./facade.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import type { EmbeddingProvider, ScoredHit, VectorStore } from "../types.js";
import type { EngineStore } from "../embed/store.js";

// ---------------------------------------------------------------------------
// Fake backends
// ---------------------------------------------------------------------------

function makeStore(lexHits: ScoredHit[] = [], vecHits: ScoredHit[] = []): VectorStore {
  return {
    upsert: vi.fn(),
    queryLex: vi.fn().mockReturnValue(lexHits),
    queryVec: vi.fn().mockReturnValue(vecHits),
    close: vi.fn(),
  };
}

/**
 * Fake EngineStore for cleanup() — only listDocPaths / clearDocument are
 * exercised by the orphan diff; the rest of the surface is a no-op stub.
 */
function makeEngineStore(docPaths: string[] = []): EngineStore {
  return {
    upsert: vi.fn(),
    queryLex: vi.fn().mockReturnValue([]),
    queryVec: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    listDocPaths: vi.fn().mockReturnValue(docPaths),
    clearDocument: vi.fn(),
  } as unknown as EngineStore;
}

function makeEmbed(
  model = "test-embed",
  dims = 4,
  vec = new Float32Array([0.1, 0.2, 0.3, 0.4]),
): EmbeddingProvider {
  return {
    model,
    dimensions: dims,
    embed: vi.fn().mockResolvedValue(vec),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(
  lexHits: ScoredHit[] = [],
  vecHits: ScoredHit[] = [],
  model = "test-embed",
): DispatcherDeps {
  return { store: makeStore(lexHits, vecHits), embed: makeEmbed(model) };
}

const LEX_HIT: ScoredHit = { docPath: "notes/lex.md", chunkOrdinal: 0, score: 0.8 };
const VEC_HIT: ScoredHit = { docPath: "notes/vec.md", chunkOrdinal: 0, score: 0.9 };

// ---------------------------------------------------------------------------
// Temp-vault fixtures (real markdown — graph / node-index / cleanup are now
// real filesystem ops as of the task #5 swap, not the old deferred stubs).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** Create an isolated temp vault with two linked notes; auto-cleaned. */
function freshVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oms-facade-"));
  mkdirSync(path.join(dir, "notes"), { recursive: true });
  writeFileSync(
    path.join(dir, "notes", "alpha.md"),
    "---\nconcept: Project\nstatus: active\n---\n# Alpha\n\nLinks to [[beta]].\n",
  );
  writeFileSync(
    path.join(dir, "notes", "beta.md"),
    "---\nconcept: Reference\n---\n# Beta\n\nReferenced by alpha.\n",
  );
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("McpEngineAdapter — construction", () => {
  it("constructs without throwing (deps + vault root are received, not instantiated)", () => {
    const adapter = new McpEngineAdapter(makeDeps(), "/vault");
    expect(adapter).toBeInstanceOf(McpEngineAdapter);
  });
});

// ---------------------------------------------------------------------------
// semanticQuery
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.semanticQuery", () => {
  it("returns available=true with mapped hits for a lex query", async () => {
    const adapter = new McpEngineAdapter(makeDeps([LEX_HIT], []), "/vault");
    const result = await adapter.semanticQuery({ query: "test", mode: "query" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.length).toBeGreaterThan(0);
    const paths = result.hits.map((h) => h.path);
    expect(paths).toContain("notes/lex.md");
  });

  it("returns available=true with vec hit for vsearch mode", async () => {
    const adapter = new McpEngineAdapter(makeDeps([], [VEC_HIT]), "/vault");
    const result = await adapter.semanticQuery({ query: "semantic", mode: "vsearch" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    const paths = result.hits.map((h) => h.path);
    expect(paths).toContain("notes/vec.md");
  });

  it("applies minScore filter", async () => {
    const lowHit: ScoredHit = { docPath: "low.md", chunkOrdinal: 0, score: 0.1 };
    const adapter = new McpEngineAdapter(makeDeps([lowHit], []), "/vault");
    const result = await adapter.semanticQuery({ query: "x", minScore: 0.5 });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.every((h) => h.score >= 0.5)).toBe(true);
  });

  it("returns available=true with empty hits for an empty store", async () => {
    const adapter = new McpEngineAdapter(makeDeps([], []), "/vault");
    const result = await adapter.semanticQuery({ query: "" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits).toHaveLength(0);
  });

  it("returns unavailable on dispatch error", async () => {
    const badStore: VectorStore = {
      upsert: vi.fn(),
      queryLex: vi.fn().mockImplementation(() => {
        throw new Error("db locked");
      }),
      queryVec: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    };
    const adapter = new McpEngineAdapter({ store: badStore, embed: makeEmbed() }, "/vault");
    const result = await adapter.semanticQuery({ query: "x", mode: "search" });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("db locked");
  });
});

// ---------------------------------------------------------------------------
// syncEmbeddings — real (delegates to syncEngineStore, which opens its own
// provider). Without a configured model the run reports available=false; the
// happy path is covered end-to-end by the golden harness (real GGUF).
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.syncEmbeddings", () => {
  it("returns available=false when no real embedding provider is configured", async () => {
    const savedModel = process.env["OMS_MODEL_PATH"];
    const savedKey = process.env["UPSTAGE_API_KEY"];
    delete process.env["OMS_MODEL_PATH"];
    delete process.env["UPSTAGE_API_KEY"];
    try {
      const v = freshVault();
      const adapter = new McpEngineAdapter(makeDeps([], [], "my-model"), v);
      const result = await adapter.syncEmbeddings({ vault: v });
      expect(result.available).toBe(false);
    } finally {
      if (savedModel !== undefined) process.env["OMS_MODEL_PATH"] = savedModel;
      if (savedKey !== undefined) process.env["UPSTAGE_API_KEY"] = savedKey;
    }
  });
});

// ---------------------------------------------------------------------------
// semanticStatus
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.semanticStatus", () => {
  it("returns available=true with embed model name", () => {
    const adapter = new McpEngineAdapter(makeDeps([], [], "my-embed-model"), "/vault");
    const result = adapter.semanticStatus({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.models.embedding).toBe("my-embed-model");
  });
});

// ---------------------------------------------------------------------------
// listCollections
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.listCollections", () => {
  it("returns a synthetic default collection", () => {
    const adapter = new McpEngineAdapter(makeDeps(), "/vault");
    const result = adapter.listCollections({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.collections[0]!.name).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// listContexts
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.listContexts", () => {
  it("returns empty context list", () => {
    const adapter = new McpEngineAdapter(makeDeps(), "/vault");
    const result = adapter.listContexts({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.contexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cleanup — real orphan diff (store doc_paths − live vault paths)
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.cleanup", () => {
  it("removes store docs that no longer exist in the live vault", async () => {
    const v = freshVault(); // live: notes/alpha.md, notes/beta.md
    const store = makeEngineStore(["notes/alpha.md", "notes/beta.md", "ghost/removed.md"]);
    const adapter = new McpEngineAdapter({ store, embed: makeEmbed() }, v);
    const result = await adapter.cleanup({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.removedDocuments).toBe(1);
    expect(result.remainingDocuments).toBe(2);
    expect(store.clearDocument).toHaveBeenCalledWith("ghost/removed.md");
    expect(store.clearDocument).toHaveBeenCalledTimes(1);
  });

  it("removes nothing when every stored doc is still live", async () => {
    const v = freshVault();
    const store = makeEngineStore(["notes/alpha.md", "notes/beta.md"]);
    const adapter = new McpEngineAdapter({ store, embed: makeEmbed() }, v);
    const result = await adapter.cleanup({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.removedDocuments).toBe(0);
    expect(result.remainingDocuments).toBe(2);
    expect(store.clearDocument).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// graphBuild / graphStatus — real edge graph + node index, cached on disk
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.graphBuild", () => {
  it("builds the edge graph + node index and persists both to .oms/cache/engine", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.graphBuild({}, v);
    expect(result.available).toBe(true);
    expect(typeof result.notes).toBe("number");
    expect(typeof result.edges).toBe("number");
    expect(typeof result.generatedAt).toBe("string");
    expect(existsSync(path.join(v, ".oms", "cache", "engine", "graph.json"))).toBe(true);
    expect(existsSync(path.join(v, ".oms", "cache", "engine", "node-index.json"))).toBe(true);
  });

  it("dryRun reports the persisted stats without rebuilding", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const built = await adapter.graphBuild({}, v);
    const dry = await adapter.graphBuild({ dryRun: true }, v);
    expect(dry.available).toBe(true);
    expect(dry.notes).toBe(built.notes);
    expect(dry.edges).toBe(built.edges);
  });
});

describe("McpEngineAdapter.graphStatus", () => {
  it("returns available=false before the cache is built", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.graphStatus(v);
    expect(result.available).toBe(false);
  });

  it("returns available=true after graphBuild", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    await adapter.graphBuild({}, v);
    const result = await adapter.graphStatus(v);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(typeof result.notes).toBe("number");
    expect(typeof result.edges).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// retrieveByAxis — node-index axis filter + lexical score
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.retrieveByAxis", () => {
  it("filters the node index by concept and JSON-encodes axis metadata in context", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveByAxis({ concept: "Project" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    const alpha = result.hits.find((h) => h.path.endsWith("alpha.md"));
    expect(alpha).toBeDefined();
    expect(alpha!.evidence).toEqual({ lexical: true, vector: false });
    const ctx = JSON.parse(alpha!.context ?? "{}") as { concept?: string };
    expect(ctx.concept).toBe("Project");
  });

  it("does not surface notes outside the requested concept axis", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveByAxis({ concept: "Reference" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.some((h) => h.path.endsWith("beta.md"))).toBe(true);
    expect(result.hits.some((h) => h.path.endsWith("alpha.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retrieveContext — axis-seeded local-graph exploration
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.retrieveContext", () => {
  it("returns seed hits from the axis-filtered exploration", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveContext({ concept: "Project" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    const seed = result.hits.find((h) => {
      try {
        return (JSON.parse(h.context ?? "{}") as { source?: string }).source === "oms-seed";
      } catch {
        return false;
      }
    });
    expect(seed).toBeDefined();
    expect(seed!.path).toContain("alpha");
  });
});
