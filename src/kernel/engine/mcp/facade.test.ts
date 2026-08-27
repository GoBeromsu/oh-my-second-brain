import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpEngineAdapter } from "./facade.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import type { EmbeddingProvider, ScoredHit, VectorStore } from "../types.js";
import type { EngineStore } from "../embed/store.js";
import { openAxisStore } from "../axes/store.js";
import { nodeSourceSignature } from "../graph/builder.js";

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
  it("does not download a model while serving an MCP query", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const adapter = new McpEngineAdapter(makeDeps([LEX_HIT], []), "/vault");
      const result = await adapter.semanticQuery({ query: "test", mode: "query" });
      expect(result).toMatchObject({ available: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it("uses the configured reranker when requested and skips it when rerank is false", async () => {
    const first: ScoredHit = { docPath: "notes/first.md", chunkOrdinal: 0, score: 0.9 };
    const second: ScoredHit = { docPath: "notes/second.md", chunkOrdinal: 0, score: 0.8 };
    const rerank = vi.fn().mockResolvedValue([
      { docPath: second.docPath, chunkOrdinal: 0, score: 2 },
      { docPath: first.docPath, chunkOrdinal: 0, score: 1 },
    ]);
    const adapter = new McpEngineAdapter(
      makeDeps([first, second], []),
      "/vault",
      undefined,
      { rerank },
    );

    const rerankedResult = await adapter.semanticQuery({
      query: "test",
      rerank: true,
    });
    const skippedResult = await adapter.semanticQuery({
      query: "test",
      rerank: false,
    });

    expect(rerankedResult.hits.map((hit) => hit.path)).toEqual([second.docPath, first.docPath]);
    expect(skippedResult.hits.map((hit) => hit.path)).toEqual([first.docPath, second.docPath]);
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it("rejects requested reranking when no real reranker is configured", async () => {
    const adapter = new McpEngineAdapter(makeDeps([LEX_HIT], []), "/vault");

    const result = await adapter.semanticQuery({ query: "test", rerank: true });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/configured Reranker/i);
  });

  it("returns available=true with empty hits for an empty store", async () => {
    const adapter = new McpEngineAdapter(makeDeps([], []), "/vault");
    const result = await adapter.semanticQuery({ query: "" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits).toHaveLength(0);
  });

  it("keeps totalCount and offset cursors accurate beyond the first 50 candidates", async () => {
    const allHits: ScoredHit[] = Array.from({ length: 75 }, (_, index) => ({
      docPath: `notes/note-${index}.md`,
      chunkOrdinal: 0,
      score: 1 / (index + 1),
    }));
    const queryLex = vi.fn((_query: string, k: number) => allHits.slice(0, k));
    const adapter = new McpEngineAdapter({
      store: {
        upsert: vi.fn(),
        queryLex,
        queryVec: vi.fn().mockReturnValue([]),
        close: vi.fn(),
      },
      embed: makeEmbed(),
    }, "/vault");

    const first = await adapter.semanticQuery({
      searches: [{ type: "lex", query: "notes" }],
      limit: 10,
    });
    expect(first).toMatchObject({ available: true, totalCount: 75, cursor: "10" });
    expect(first.hits).toHaveLength(10);
    expect(queryLex).toHaveBeenCalledWith("notes", Number.MAX_SAFE_INTEGER);

    const page = await adapter.semanticQuery({
      searches: [{ type: "lex", query: "notes" }],
      limit: 10,
      cursor: "60",
    });
    expect(page).toMatchObject({ available: true, totalCount: 75, cursor: "70" });
    expect(page.hits.map((hit) => hit.path)).toEqual(
      allHits.slice(60, 70).map((hit) => hit.docPath),
    );
  });

  it.each([
    ["vec shorthand", { vec: "alpha" }],
    ["hyde shorthand", { hyde: "alpha" }],
    ["typed vec", { searches: [{ type: "vec" as const, query: "alpha" }] }],
    ["typed hyde", { searches: [{ type: "hyde" as const, query: "alpha" }] }],
    ["vsearch mode", { query: "alpha", mode: "vsearch" as const }],
  ])("rejects explicit %s retrieval on model-free axes", async (_name, search) => {
    const adapter = new McpEngineAdapter(makeDeps(), freshVault());
    const result = await adapter.semanticQuery({
      ...search,
      axes: { folder: "notes" },
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/OMS_EMBEDDING_PROVIDER/);
    expect(result.reason).toMatch(/OMS_EMBEDDING_MODEL/);
    expect(result.reason).toMatch(/vector\/HyDE/i);
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

  it("uses the read-only EAV snapshot for typed axis filtering", async () => {
    const v = freshVault();
    mkdirSync(path.join(v, ".oms", "cache"), { recursive: true });
    const axisStore = openAxisStore(path.join(v, ".oms", "cache", "axes.sqlite"));
    axisStore.replaceNote("notes/alpha.md", { rating: 9, done: false }, { folder: "notes" });
    axisStore.replaceNote("notes/beta.md", { rating: 2, done: true }, { folder: "notes" });
    axisStore.setSourceSignature(await nodeSourceSignature(v));
    axisStore.close();
    const adapter = new McpEngineAdapter(makeDeps(), v, undefined, undefined, false, false);

    const result = await adapter.semanticQuery({
      query: "alpha",
      axes: { field: { rating: { gte: 8 }, done: false } },
      limit: 1,
      intent: "typed axis lookup",
    });

    expect(result).toMatchObject({
      available: true,
      totalCount: 1,
      intent: "typed axis lookup",
      receipt: { usedChannels: ["lex"], approximated: true },
    });
    expect(result.facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "field", key: "rating", value: "9", count: 1 }),
    ]));
    if (result.available) expect(result.hits[0]?.path).toBe("notes/alpha.md");
  });

  it("applies the query envelope after axis filtering without returning zero-score nonmatches", async () => {
    const v = mkdtempSync(path.join(tmpdir(), "oms-axis-envelope-"));
    tempDirs.push(v);
    mkdirSync(path.join(v, "notes"), { recursive: true });
    writeFileSync(path.join(v, "notes", "first.md"), "# Needle\nneedle needle\n");
    writeFileSync(path.join(v, "notes", "second.md"), "# Needle\nneedle\n");
    writeFileSync(path.join(v, "notes", "nonmatch.md"), "# Other\nunrelated text\n");
    const rerank = vi.fn().mockResolvedValue([
      { docPath: "notes/second.md", chunkOrdinal: 0, score: 2 },
      { docPath: "notes/first.md", chunkOrdinal: 0, score: 1 },
    ]);
    const adapter = new McpEngineAdapter(
      makeDeps(),
      v,
      undefined,
      { rerank },
      false,
      false,
    );

    const result = await adapter.semanticQuery({
      query: "needle",
      axes: { folder: "notes" },
      candidateLimit: 2,
      rerank: true,
      limit: 1,
    });

    expect(result).toMatchObject({ available: true, totalCount: 2, cursor: "1" });
    if (!result.available) return;
    expect(result.hits.map((hit) => hit.path)).toEqual(["notes/second.md"]);
    expect(rerank).toHaveBeenCalledWith("needle", [
      expect.objectContaining({ docPath: "notes/first.md" }),
      expect.objectContaining({ docPath: "notes/second.md" }),
    ]);
  });

  it("does not report lexical or vector evidence for an axis-only query", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v, undefined, undefined, false, false);

    const result = await adapter.semanticQuery({
      axes: { folder: "notes" },
      limit: 10,
    });

    expect(result).toMatchObject({
      available: true,
      receipt: { usedChannels: [], approximated: false },
    });
    if (!result.available) return;
    expect(result.hits.every((hit) => hit.evidence.lexical === false && hit.evidence.vector === false)).toBe(true);
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

  it("rejects cleanup while another writer holds the engine lock", async () => {
    const v = freshVault();
    const dbPath = path.join(v, ".oms", "engine-store.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}.lock`, `${process.pid}\n`, "utf8");
    const store = makeEngineStore(["ghost/removed.md"]);
    const adapter = new McpEngineAdapter({ store, embed: makeEmbed() }, v, { dbPath });

    const result = await adapter.cleanup({});

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/already in progress|lock/i);
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
