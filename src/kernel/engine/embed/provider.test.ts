import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createGGUFEmbeddingProvider,
  createUpstageProvider,
  requireRealEmbeddingProvider,
  GGUF_EMBEDDING_DIMENSIONS,
} from "./provider.js";
import { createHashProjectionProvider } from "./hash-stub.test-helper.js";

describe("createHashProjectionProvider", () => {
  it("returns an EmbeddingProvider with correct model label", () => {
    const p = createHashProjectionProvider(64);
    expect(p.model).toBe("hash-projection:dim=64");
  });

  it("exposes correct dimensions", () => {
    const p = createHashProjectionProvider(128);
    expect(p.dimensions).toBe(128);
  });

  it("embed returns Float32Array of configured length", async () => {
    const p = createHashProjectionProvider(64);
    const v = await p.embed("hello world");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(64);
  });

  it("embedding is L2-normalised (magnitude ≈ 1)", async () => {
    const p = createHashProjectionProvider(64);
    const v = await p.embed("machine learning and graphs");
    let mag = 0;
    for (const x of v) mag += x * x;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });

  it("same text → identical vector (deterministic)", async () => {
    const p = createHashProjectionProvider(64);
    const v1 = await p.embed("Obsidian vault");
    const v2 = await p.embed("Obsidian vault");
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it("different texts produce different vectors", async () => {
    const p = createHashProjectionProvider(64);
    const v1 = await p.embed("apple");
    const v2 = await p.embed("orange");
    expect(Array.from(v1)).not.toEqual(Array.from(v2));
  });

  it("empty text returns zero vector without throwing", async () => {
    const p = createHashProjectionProvider(64);
    const v = await p.embed("");
    expect(v.length).toBe(64);
    let mag = 0;
    for (const x of v) mag += x * x;
    expect(mag).toBe(0);
  });

  it("dispose resolves without error", async () => {
    const p = createHashProjectionProvider(64);
    await expect(p.dispose()).resolves.toBeUndefined();
  });
});

describe("embedding provider runtime guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("honors query/passage prefixes for the Upstage provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [3, 4] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createUpstageProvider("test-key", "test-model", 2, {
      prefixScheme: "query=Q:,passage=P:",
    }) as ReturnType<typeof createUpstageProvider> & {
      readonly embedQuery: (text: string) => Promise<Float32Array>;
    };

    await provider.embed("document");
    await provider.embedQuery("question");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.upstage.ai/v1/embeddings",
      expect.objectContaining({ body: JSON.stringify({ input: "P:document", model: "test-model" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.upstage.ai/v1/embeddings",
      expect.objectContaining({ body: JSON.stringify({ input: "Q:question", model: "test-model" }) }),
    );
  });

  it("substitutes the document title into a passage prefix that declares the slot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [3, 4] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createUpstageProvider("test-key", "test-model", 2, {
      prefixScheme: JSON.stringify({
        query: "task: search result | query: ",
        passage: "title: {title} | text: ",
      }),
    });

    await provider.embed("body text", "Stellar Nucleosynthesis");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.upstage.ai/v1/embeddings",
      expect.objectContaining({
        body: JSON.stringify({
          input: "title: Stellar Nucleosynthesis | text: body text",
          model: "test-model",
        }),
      }),
    );
  });

  it("falls back to the untitled literal for a missing or blank title", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [3, 4] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createUpstageProvider("test-key", "test-model", 2, {
      prefixScheme: JSON.stringify({ passage: "title: {title} | text: " }),
    });

    await provider.embed("body");
    await provider.embed("body", "   ");
    for (const call of [1, 2]) {
      expect(fetchMock).toHaveBeenNthCalledWith(
        call,
        "https://api.upstage.ai/v1/embeddings",
        expect.objectContaining({
          body: JSON.stringify({ input: "title: none | text: body", model: "test-model" }),
        }),
      );
    }
  });

  it("leaves a prefix without a title slot byte-identical when a title is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [3, 4] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createUpstageProvider("test-key", "test-model", 2, {
      prefixScheme: "query=Q:,passage=P:",
    });

    await provider.embed("document", "Ignored Title");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.upstage.ai/v1/embeddings",
      expect.objectContaining({ body: JSON.stringify({ input: "P:document", model: "test-model" }) }),
    );
  });

  it("rejects a non-finite model vector instead of coercing it to zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, Number.NaN] }] }),
    }));
    const provider = createUpstageProvider("test-key", "test-model", 2);
    await expect(provider.embed("text")).rejects.toThrow(/non-finite/i);
  });
});

// ---------------------------------------------------------------------------
// requireRealEmbeddingProvider factory (GGUF path)
// ---------------------------------------------------------------------------

describe("requireRealEmbeddingProvider — GGUF path", () => {
  it("returns GGUF provider when provider=gguf + model are provided", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    const p = requireRealEmbeddingProvider({ provider: "gguf", model: "/fake/model.gguf" });
    expect(p.model).toMatch(/^node-llama-cpp:/);
    expect(p.dimensions).toBe(GGUF_EMBEDDING_DIMENSIONS);
    if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
  });

  it("GGUF provider reports 768 dimensions (spec: float[768] no-fold)", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    const p = createGGUFEmbeddingProvider("/fake/model.gguf");
    expect(p.dimensions).toBe(768);
    if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
  });

  it("dispose resolves on GGUF provider without a loaded model", async () => {
    // Provider is lazy — dispose() before any embed() should not throw
    const p = createGGUFEmbeddingProvider("/fake/model.gguf");
    await expect(p.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requireRealEmbeddingProvider — strict production factory
// ---------------------------------------------------------------------------

describe("requireRealEmbeddingProvider — strict guard", () => {
  // Save and restore env state around each test
  let savedUpstage: string | undefined;
  afterEach(() => {
    if (savedUpstage !== undefined) {
      process.env["UPSTAGE_API_KEY"] = savedUpstage;
    } else {
      delete process.env["UPSTAGE_API_KEY"];
    }
  });

  it("THROWS asking for OMS_EMBEDDING_PROVIDER when no provider is configured", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_EMBEDDING_PROVIDER");
  });

  it("THROWS asking for OMS_EMBEDDING_MODEL when provider is set but model is missing", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() => requireRealEmbeddingProvider({ provider: "gguf" })).toThrow("OMS_EMBEDDING_MODEL");
  });

  it("returns GGUF provider (dimensions===768) when provider=gguf + model are given", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    const p = requireRealEmbeddingProvider({ provider: "gguf", model: "/fake/model.gguf" });
    expect(p.model).toMatch(/^node-llama-cpp:/);
    expect(p.dimensions).toBe(768);
  });

  it("does NOT auto-detect Upstage from UPSTAGE_API_KEY — provider must be explicit", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    process.env["UPSTAGE_API_KEY"] = "test-key-123";
    // Key present but no OMS_EMBEDDING_PROVIDER → still throws (no key-based auto-detect).
    expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_EMBEDDING_PROVIDER");
  });

  it("returns Upstage provider when provider=upstage + model + UPSTAGE_API_KEY are set", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    process.env["UPSTAGE_API_KEY"] = "test-key-123";
    const p = requireRealEmbeddingProvider({ provider: "upstage", model: "solar-embedding-1-large" });
    expect(p.model).toContain("upstage");
  });

  it("THROWS for provider=upstage when UPSTAGE_API_KEY is missing", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() =>
      requireRealEmbeddingProvider({ provider: "upstage", model: "solar-embedding-1-large" }),
    ).toThrow("UPSTAGE_API_KEY");
  });

  it("THROWS for an unsupported provider id", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() =>
      requireRealEmbeddingProvider({ provider: "cohere", model: "embed-v3" }),
    ).toThrow("unsupported");
  });
});

// ---------------------------------------------------------------------------
// GGUF provider with real model (skipped unless OMS_MODEL_PATH is set)
// ---------------------------------------------------------------------------

const MODEL_PATH = process.env["OMS_MODEL_PATH"];

describe.skipIf(!MODEL_PATH)(
  "createGGUFEmbeddingProvider — real GGUF (OMS_MODEL_PATH required)",
  () => {
    it(
      "returns Float32Array of length 768 (EmbeddingGemma-300M, no fold)",
      async () => {
        const p = createGGUFEmbeddingProvider(MODEL_PATH!);
        const v = await p.embed("knowledge graph retrieval");
        expect(v).toBeInstanceOf(Float32Array);
        expect(v.length).toBe(768);
        // L2-normalised
        let mag = 0;
        for (const x of v) mag += x * x;
        expect(Math.sqrt(mag)).toBeCloseTo(1, 4);
        await p.dispose();
      },
      60_000, // 60 s — model load on first run can be slow
    );

    it(
      "same text → same vector (deterministic across two embed calls)",
      async () => {
        const p = createGGUFEmbeddingProvider(MODEL_PATH!);
        const v1 = await p.embed("Obsidian PKM vault");
        const v2 = await p.embed("Obsidian PKM vault");
        expect(Array.from(v1)).toEqual(Array.from(v2));
        await p.dispose();
      },
      60_000,
    );
  },
);
