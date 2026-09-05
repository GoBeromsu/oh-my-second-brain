import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpEngineAdapter } from "./facade.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import type { EmbeddingProvider, ScoredHit, VectorStore } from "../types.js";
import type { EngineStore } from "../embed/store.js";
import { loadResolvedTemplates, sourceSignature } from "../../templates/resolver.js";
import type { Digest, SourceDescriptor } from "../../templates/types.js";

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

const digest = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

/** Create an isolated template-authorized vault with two linked notes. */
function freshVault(intents: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oms-facade-"));
  mkdirSync(path.join(dir, "notes"), { recursive: true });
  mkdirSync(path.join(dir, ".oms"), { recursive: true });
  mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  mkdirSync(path.join(dir, "Templates", "OMS"), { recursive: true });
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
    base: { fields: {} },
    contracts: {
      project: { intent: "project note.", fields: { status: { type: "text" }, rating: { type: "number" }, done: { type: "boolean" } }, views: [] },
      reference: { intent: "reference note.", fields: { rating: { type: "number" }, done: { type: "boolean" } }, views: [] },
    },
    templates: {
      project: { templateId: "project", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/project.md", contract: "project", naming: "{{title}}" },
      reference: { templateId: "reference", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/reference.md", contract: "reference", naming: "{{title}}" },
    },
  });
  const intentEntries = Object.entries(intents).sort(([left], [right]) => left.localeCompare(right));
  const taxonomy = JSON.stringify({
    folders: Object.fromEntries(intentEntries.map(([folder, intent]) => [folder, { intent }])),
    templates: {
      project: { templateFolder: "Inbox" },
      reference: { templateFolder: "Inbox" },
    },
  });
  const types = JSON.stringify({ types: { status: "text", rating: "number", done: "boolean" } });
  const projectTemplate = "---\nstatus: active\nrating: 1\ndone: false\n---\nBody\n";
  const referenceTemplate = "---\nrating: 1\ndone: false\n---\nBody\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(types) },
    { path: "Templates/OMS/project.md", signature: digest(projectTemplate) },
    { path: "Templates/OMS/reference.md", signature: digest(referenceTemplate) },
  ];
  const field = (type: string) => ({ type });
  const folderOntology = intentEntries.length === 0
    ? {}
    : {
        "folder-ontology": {
          kind: "folder",
          key: "folder",
          type: "text",
          intent: "Semantic meanings of vault folders.",
          members: intentEntries.map(([folder]) => folder),
          extensions: { intents: Object.fromEntries(intentEntries) },
        },
      };
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
    managed: {
      base: { fields: {} }, globalAxes: folderOntology,
      templates: {
        project: { templateId: "project", destinationClass: "managed-default", sourcePath: "Templates/OMS/project.md", targetFolder: "Inbox", keyOrder: ["status", "rating", "done"], fields: { status: field("text"), rating: field("number"), done: field("boolean") }, views: [], naming: "{{title}}", bodySignature: digest("Body\n") },
        reference: { templateId: "reference", destinationClass: "managed-default", sourcePath: "Templates/OMS/reference.md", targetFolder: "Inbox", keyOrder: ["rating", "done"], fields: { rating: field("number"), done: field("boolean") }, views: [], naming: "{{title}}", bodySignature: digest("Body\n") },
      },
    },
  });
  writeFileSync(path.join(dir, ".oms", "template-policy.json"), policy);
  writeFileSync(path.join(dir, ".oms", "taxonomy.json"), taxonomy);
  writeFileSync(path.join(dir, ".obsidian", "types.json"), types);
  writeFileSync(path.join(dir, ".oms", "types.json"), projection);
  writeFileSync(path.join(dir, "Templates", "OMS", "project.md"), projectTemplate);
  writeFileSync(path.join(dir, "Templates", "OMS", "reference.md"), referenceTemplate);
  writeFileSync(path.join(dir, "notes", "alpha.md"), "---\ntemplate: project\nstatus: active\n---\n# Alpha\n\nLinks to [[beta]].\n");
  writeFileSync(path.join(dir, "notes", "beta.md"), "---\ntemplate: reference\n---\n# Beta\n\nreferenced by alpha.\n");
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
  it("keeps a plain query lexical-only even when a vector provider is available", async () => {
    const store = makeStore([LEX_HIT], [VEC_HIT]);
    const adapter = new McpEngineAdapter(
      { store, embed: makeEmbed() },
      "/vault",
      undefined,
      undefined,
      false,
      false,
    );

    const result = await adapter.semanticQuery({ query: "test" });

    expect(result.available).toBe(true);
    expect(store.queryLex).toHaveBeenCalled();
    expect(store.queryVec).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      requestedStrategy: "plain",
      usedChannels: ["lex"],
      generatedSearches: [],
    });
  });

  it("executes a validated expansion plan with active taxonomy provenance", async () => {
    const vault = freshVault({
      notes: "Permanent project notes",
      unused: "No indexed documents",
    });
    // Parallel legacy context must never reach a model prompt.
    writeFileSync(path.join(vault, "taxonomy.json"), `
folders:
  notes:
    intent: Legacy context must not leak
`);
    const store = makeEngineStore(["notes/alpha.md", "notes/beta.md", "inbox/raw.md"]);
    vi.mocked(store.queryLex).mockReturnValue([
      { docPath: "notes/alpha.md", chunkOrdinal: 0, score: 0.9 },
    ]);
    vi.mocked(store.queryVec).mockReturnValue([
      { docPath: "notes/beta.md", chunkOrdinal: 0, score: 0.8 },
    ]);
    const queryExpander = vi.fn().mockResolvedValue([
      { type: "lex", query: "ataraxia" },
      { type: "vec", query: "freedom from disturbance" },
    ]);
    const adapter = new McpEngineAdapter(
      { store, embed: makeEmbed(), queryExpander },
      vault,
      undefined,
      undefined,
      false,
      false,
    );

    const result = await adapter.semanticQuery({
      query: "what is ataraxia",
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
    });

    expect(result.available).toBe(true);
    expect(queryExpander).toHaveBeenCalledWith({
      query: "what is ataraxia",
      context: "- notes: Permanent project notes",
    });
    expect(JSON.stringify(queryExpander.mock.calls)).not.toContain("Legacy context must not leak");
    expect(store.queryLex).toHaveBeenCalledWith("ataraxia", expect.any(Number));
    expect(store.queryVec).toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      requestedStrategy: "expand",
      generatedSearches: [
        { type: "lex", query: "ataraxia" },
        { type: "vec", query: "freedom from disturbance" },
      ],
      taxonomyIntents: [
        {
          folder: "notes",
          intent: "Permanent project notes",
          source: ".oms/taxonomy.json",
        },
      ],
    });
    expect(result.receipt.warnings).toEqual([
      'Indexed folder "inbox" has no intent in .oms/taxonomy.json.',
      'Taxonomy folder "unused" has no indexed Markdown files.',
    ]);
  });

  it("reports template-contract diagnostics and doctor guidance for expansion", async () => {
    const vault = freshVault();
    rmSync(path.join(vault, ".oms", "types.json"));
    const adapter = new McpEngineAdapter(
      { store: makeEngineStore(["notes/alpha.md"]), embed: makeEmbed(), queryExpander: vi.fn() },
      vault,
      undefined,
      undefined,
      false,
      false,
    );

    const result = await adapter.semanticQuery({
      query: "what is ataraxia",
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("TEMPLATE_SOURCE_INVALID");
    expect(result.reason).toContain("Run oms doctor --vault <vault>");
  });

  it("reports generate-unavailable for expansion without an expander", async () => {
    const adapter = new McpEngineAdapter(makeDeps([LEX_HIT]), "/vault", undefined, undefined, false, false);

    const result = await adapter.semanticQuery({
      query: "expand me",
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/OMS_GENERATE_PROVIDER/);
    expect(result.reason).toMatch(/OMS_GENERATE_MODEL/);
    expect(result.reason).toMatch(/\.oms\/models\.json/);
    expect(result.receipt.requestedStrategy).toBe("expand");
  });

  it("rejects expansion before a lex-only plan can bypass missing embeddings", async () => {
    const store = makeEngineStore();
    store.capabilities = vi.fn().mockReturnValue({ vecAvailable: false });
    const embed = makeEmbed();
    embed.embed = vi.fn().mockRejectedValue(new Error(
      "Embedding provider unavailable. Configure OMS_EMBEDDING_PROVIDER and OMS_EMBEDDING_MODEL.",
    ));
    const queryExpander = vi.fn().mockResolvedValue([
      { type: "lex", query: "expanded lexical query" },
    ]);
    const adapter = new McpEngineAdapter(
      {
        store,
        embed,
        queryExpander,
      },
      "/vault",
      undefined,
      undefined,
      false,
      false,
    );

    const result = await adapter.semanticQuery({
      query: "expand me",
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("OMS_EMBEDDING_PROVIDER");
    expect(queryExpander).not.toHaveBeenCalled();
    expect(embed.embed).not.toHaveBeenCalled();
    expect(store.queryLex).not.toHaveBeenCalled();
  });

  it("rejects an invalid caller-injected expansion plan before dispatch", async () => {
    const store = makeStore([LEX_HIT], [VEC_HIT]);
    const adapter = new McpEngineAdapter(
      {
        store,
        embed: makeEmbed(),
        queryExpander: vi.fn().mockResolvedValue([
          { type: "graph", query: "not allowed" },
        ]) as never,
      },
      "/vault",
      undefined,
      undefined,
      false,
      false,
    );

    const result = await adapter.semanticQuery({
      query: "q",
      strategy: { kind: "expand", profile: "qmd-v2.8.3" },
    });

    expect(result.available).toBe(false);
    expect(store.queryLex).not.toHaveBeenCalled();
    expect(store.queryVec).not.toHaveBeenCalled();
  });

  it("feeds active taxonomy intent to reranking and records it", async () => {
    const vault = freshVault({ notes: "Permanent project notes" });
    const store = makeEngineStore(["notes/alpha.md", "notes/beta.md"]);
    vi.mocked(store.queryLex).mockReturnValue([
      { docPath: "notes/alpha.md", chunkOrdinal: 0, score: 0.9 },
    ]);
    const rerank = vi.fn().mockImplementation(async (_query, hits) => hits);
    const adapter = new McpEngineAdapter(
      { store, embed: makeEmbed() },
      vault,
      undefined,
      { rerank },
      false,
      false,
    );

    const result = await adapter.semanticQuery({ query: "ataraxia", rerank: true });

    expect(result.available).toBe(true);
    expect(rerank).toHaveBeenCalledWith(
      "ataraxia\n\nVault folder intents:\n- notes: Permanent project notes",
      expect.any(Array),
    );
    expect(result.receipt).toMatchObject({
      requestedStrategy: "plain",
      rerankApplied: true,
      taxonomyIntents: [
        {
          folder: "notes",
          intent: "Permanent project notes",
          source: ".oms/taxonomy.json",
        },
      ],
    });
  });

  it("reports template-contract diagnostics and doctor guidance for reranking", async () => {
    const vault = freshVault();
    writeFileSync(path.join(vault, ".oms", "template-migration.json"), "{}\n");
    const adapter = new McpEngineAdapter(
      { store: makeEngineStore(["notes/alpha.md"]), embed: makeEmbed() },
      vault,
      undefined,
      { rerank: vi.fn().mockResolvedValue([]) },
      false,
      false,
    );

    const result = await adapter.semanticQuery({ query: "ataraxia", rerank: true });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("MIGRATION_INCOMPLETE");
    expect(result.reason).toContain("Run oms doctor --vault <vault>");
  });

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
    // The refusal has to be actionable for the person who hit it, not just for a
    // programmer reading the source. It previously named only `assembleEngine()`,
    // which tells a CLI or MCP user nothing they can act on. Assert the whole
    // remedy: the exact rerank environment pair, the vault contract file, and the
    // setup command that installs one.
    const reason = result.available === false ? result.reason : "";
    expect(reason).toMatch(/OMS_RERANK_PROVIDER/);
    expect(reason).toMatch(/OMS_RERANK_MODEL/);
    expect(reason).toMatch(/\.oms\/models\.json/);
    expect(reason).toMatch(/oms setup --models-descriptor/);
    // A programmatic caller still learns about injection.
    expect(reason).toMatch(/assembleEngine\(\)/);
  });

  it("names the rerank capability, never the embed pair, when reranking is unavailable", async () => {
    // Guards a plausible regression: reusing the embed guidance would send a user
    // to install an embedding model that would not enable reranking at all.
    const adapter = new McpEngineAdapter(makeDeps([LEX_HIT], []), "/vault");

    const result = await adapter.semanticQuery({ query: "test", rerank: true });

    const reason = result.available === false ? result.reason : "";
    expect(reason).not.toMatch(/OMS_EMBEDDING_PROVIDER/);
    expect(reason).not.toMatch(/models-default/);
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

  it("uses template-declared typed axes for filtering", async () => {
    const v = freshVault();
    writeFileSync(path.join(v, "notes", "alpha.md"), "---\ntemplate: project\nrating: 9\ndone: false\n---\n# Alpha\n");
    writeFileSync(path.join(v, "notes", "beta.md"), "---\ntemplate: reference\nrating: 2\ndone: true\n---\n# Beta\n");
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
      // A plain query is lexical-only even when a model is installed, so the
      // axis path executes exactly what was requested instead of dropping an
      // implicit vector channel and calling the result approximate.
      receipt: { usedChannels: ["lex"], approximated: false },
    });
    expect(result.facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "field", key: "rating", value: "9", count: 1 }),
      expect.objectContaining({ axis: "template", value: "project", count: 1 }),
    ]));
    if (result.available) expect(result.hits[0]?.path).toBe("notes/alpha.md");
  });

  it("applies the query envelope after axis filtering without returning zero-score nonmatches", async () => {
    const v = freshVault();
    writeFileSync(path.join(v, "notes", "first.md"), "---\ntemplate: project\n---\n# Needle\nneedle needle\n");
    writeFileSync(path.join(v, "notes", "second.md"), "---\ntemplate: project\n---\n# Needle\nneedle\n");
    writeFileSync(path.join(v, "notes", "nonmatch.md"), "---\ntemplate: project\n---\n# Other\nunrelated text\n");
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

  it("applies lexical score thresholds consistently to axis hits and facets", async () => {
    const v = freshVault();
    writeFileSync(path.join(v, "notes", "matching.md"), "---\ntemplate: project\nstatus: active\n---\n# Needle\nneedle\n");
    writeFileSync(path.join(v, "notes", "nonmatching.md"), "---\ntemplate: project\nstatus: archived\n---\n# Other\nunrelated text\n");
    const adapter = new McpEngineAdapter(makeDeps(), v, undefined, undefined, false, false);

    const result = await adapter.semanticQuery({
      query: "needle",
      axes: { folder: "notes" },
      minScore: 0,
      limit: 10,
    });

    expect(result).toMatchObject({ available: true, totalCount: 1 });
    if (!result.available) return;
    expect(result.hits.map((hit) => hit.path)).toEqual(["notes/matching.md"]);
    expect(result.facets).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ axis: "field", key: "status", value: "archived" }),
    ]));
  });

  it("derives reranked threshold facets from the same final hit set", async () => {
    const v = freshVault();
    const rerank = vi.fn().mockResolvedValue([
      { docPath: "notes/beta.md", chunkOrdinal: 0, score: 0.9 },
      { docPath: "notes/alpha.md", chunkOrdinal: 0, score: 0.1 },
    ]);
    const adapter = new McpEngineAdapter(makeDeps(), v, undefined, { rerank }, false, false);

    const result = await adapter.semanticQuery({
      query: "alpha",
      axes: { folder: "notes" },
      rerank: true,
      minScore: 0.5,
      limit: 10,
    });

    expect(result).toMatchObject({ available: true, totalCount: 1 });
    if (!result.available) return;
    expect(result.hits.map((hit) => hit.path)).toEqual(["notes/beta.md"]);
    expect(result.facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "template", value: "reference", count: 1 }),
    ]));
    expect(result.facets).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ axis: "template", value: "project" }),
      expect.objectContaining({ axis: "field", key: "status", value: "active" }),
    ]));
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
    const savedProvider = process.env["OMS_EMBEDDING_PROVIDER"];
    const savedModel = process.env["OMS_EMBEDDING_MODEL"];
    delete process.env["OMS_EMBEDDING_PROVIDER"];
    delete process.env["OMS_EMBEDDING_MODEL"];
    try {
      const v = freshVault();
      const adapter = new McpEngineAdapter(makeDeps([], [], "my-model"), v);
      const result = await adapter.syncEmbeddings({ vault: v });
      expect(result.available).toBe(false);
    } finally {
      if (savedProvider !== undefined) process.env["OMS_EMBEDDING_PROVIDER"] = savedProvider;
      if (savedModel !== undefined) process.env["OMS_EMBEDDING_MODEL"] = savedModel;
    }
  });
});

// ---------------------------------------------------------------------------
// semanticStatus
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.semanticStatus", () => {
  it("returns available=true with embed model name", async () => {
    const adapter = new McpEngineAdapter(makeDeps([], [], "my-embed-model"), "/vault");
    const result = await adapter.semanticStatus({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.models.embedding).toBe("my-embed-model");
    expect(result.capabilities).toBeUndefined();
  });

  it("reports three path-safe model capabilities only when status is requested", async () => {
    const modelCapabilityStatus = vi.fn(() => ({
      embed: {
        capability: "embed" as const,
        available: true,
        source: "environment" as const,
        provider: "gguf",
        model: "portable-embed",
        revision: "revision-1",
        sha256: "a".repeat(64),
        promptScheme: "query-document",
        guidance: "Configured by OMS_EMBEDDING_MODEL.",
      },
      rerank: {
        capability: "rerank" as const,
        available: false,
        source: "unavailable" as const,
        guidance: "Configure a reranker to enable reranking.",
      },
      generate: {
        capability: "generate" as const,
        available: false,
        source: "unavailable" as const,
        guidance: "Configure a generator to enable generation.",
      },
    }));
    const store = {
      ...makeStore(),
      readEmbeddingIdentity: () => ({ fingerprint: "store-fingerprint" }),
    };
    const adapter = new McpEngineAdapter(
      { store, embed: makeEmbed("/Users/secret/model.gguf") },
      "/vault",
      { embeddingModel: "portable-embed", modelCapabilityStatus },
    );

    expect(modelCapabilityStatus).not.toHaveBeenCalled();
    await adapter.semanticQuery({ query: "test" });
    expect(modelCapabilityStatus).not.toHaveBeenCalled();
    const result = await adapter.semanticStatus({});

    expect(modelCapabilityStatus).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      available: true,
      models: { embedding: "portable-embed" },
      storeEmbeddingFingerprint: "store-fingerprint",
    });
    if (!result.available) return;
    expect(Object.keys(result.capabilities ?? {})).toEqual(["embed", "rerank", "generate"]);
    expect(result.capabilities?.embed).toMatchObject({
      capability: "embed",
      source: "environment",
      promptScheme: "query-document",
      sha256: "a".repeat(64),
    });
    expect(JSON.stringify(result)).not.toContain("/Users/secret/model.gguf");
  });

  it("reports deterministic taxonomy context drift without exposing a second source", async () => {
    const vault = freshVault({
      notes: "Permanent notes",
      unused: "No indexed files",
    });
    const adapter = new McpEngineAdapter(
      { store: makeEngineStore(["notes/alpha.md", "inbox/raw.md"]), embed: makeEmbed() },
      vault,
    );

    const result = await adapter.semanticStatus({});

    expect(result).toMatchObject({
      available: true,
      taxonomyContext: {
        matched: [
          { folder: "notes", intent: "Permanent notes", source: ".oms/taxonomy.json" },
        ],
        indexedWithoutIntent: ["inbox"],
        taxonomyWithoutIndexed: ["unused"],
        warnings: [
          'Indexed folder "inbox" has no intent in .oms/taxonomy.json.',
          'Taxonomy folder "unused" has no indexed Markdown files.',
        ],
      },
    });
  });

  it("returns a generic unavailable status when capability resolution throws", async () => {
    const adapter = new McpEngineAdapter(makeDeps(), "/vault", {
      modelCapabilityStatus: () => {
        throw new Error("/Users/secret/model.gguf");
      },
    });

    const result = await adapter.semanticStatus({});

    expect(result).toEqual({
      available: false,
      reason: "Model capability resolution is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("/Users/secret/model.gguf");
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
  it("returns empty context list", async () => {
    const adapter = new McpEngineAdapter(makeDeps(), "/vault");
    const result = await adapter.listContexts({});
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.contexts).toHaveLength(0);
  });

  it("lists active taxonomy intents with provenance instead of a parallel store", async () => {
    const vault = freshVault({ notes: "Permanent project notes" });
    const adapter = new McpEngineAdapter(
      { store: makeEngineStore(["notes/alpha.md"]), embed: makeEmbed() },
      vault,
    );

    const result = await adapter.listContexts({});

    expect(result).toMatchObject({
      available: true,
      contexts: [{
        collection: "notes",
        pathPrefix: "notes",
        context: "Permanent project notes",
        source: ".oms/taxonomy.json",
      }],
    });
    if (!result.available) return;
    expect(result.contexts[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
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
    const nodeIndexPath = path.join(v, ".oms", "cache", "engine", "node-index.json");
    expect(existsSync(nodeIndexPath)).toBe(true);
    const cached = JSON.parse(readFileSync(nodeIndexPath, "utf8")) as { nodes: readonly { path: string }[] };
    expect(cached.nodes.some((node) => node.path.startsWith("Templates/OMS/"))).toBe(false);
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
    expect(existsSync(path.join(v, ".oms", "cache", "engine"))).toBe(false);
  });

  it("rejects a stale graph projection cache without rebuilding it", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    await adapter.graphBuild({}, v);
    const graphPath = path.join(v, ".oms", "cache", "engine", "graph.json");
    const cached = JSON.parse(readFileSync(graphPath, "utf8")) as Record<string, unknown>;
    cached.projectionSignature = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    writeFileSync(graphPath, `${JSON.stringify(cached)}\n`);
    expect((await adapter.graphStatus(v)).available).toBe(false);
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
  it("filters the node index by template and JSON-encodes axis metadata in context", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveByAxis({ template: "project" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    const alpha = result.hits.find((h) => h.path.endsWith("alpha.md"));
    expect(alpha).toBeDefined();
    expect(alpha!.evidence).toEqual({ lexical: true, vector: false });
    const ctx = JSON.parse(alpha!.context ?? "{}") as { template?: string };
    expect(ctx.template).toBe("project");
  });

  it("does not surface notes outside the requested template axis", async () => {
    const v = freshVault();
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveByAxis({ template: "reference" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits.some((h) => h.path.endsWith("beta.md"))).toBe(true);
    expect(result.hits.some((h) => h.path.endsWith("alpha.md"))).toBe(false);
  });

  it("returns an unavailable result when template authority is missing", async () => {
    const v = mkdtempSync(path.join(tmpdir(), "oms-missing-authority-"));
    tempDirs.push(v);
    const adapter = new McpEngineAdapter(makeDeps(), v);
    const result = await adapter.retrieveByAxis({ template: "project" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toMatch(/TEMPLATE/);
  });
});
