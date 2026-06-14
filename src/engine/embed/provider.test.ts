import { describe, it, expect, afterEach } from "vitest";
import {
  createGGUFEmbeddingProvider,
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

// ---------------------------------------------------------------------------
// requireRealEmbeddingProvider factory (GGUF path)
// ---------------------------------------------------------------------------

describe("requireRealEmbeddingProvider — GGUF path", () => {
  it("returns GGUF provider when modelPath is provided", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    const p = requireRealEmbeddingProvider({ modelPath: "/fake/model.gguf" });
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
// GGUF provider with real model (skipped unless OMS_MODEL_PATH is set)
// ---------------------------------------------------------------------------

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

  it("THROWS with OMS_MODEL_PATH message when no modelPath and no UPSTAGE_API_KEY", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_MODEL_PATH");
  });

  it("THROWS mentioning 'hash-projection' to make the guard rationale clear", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    expect(() => requireRealEmbeddingProvider()).toThrow("hash-projection");
  });

  it("returns GGUF provider (dimensions===768) when modelPath is given", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    const p = requireRealEmbeddingProvider({ modelPath: "/fake/model.gguf" });
    expect(p.model).toMatch(/^node-llama-cpp:/);
    expect(p.dimensions).toBe(768);
  });

  it("does NOT throw when UPSTAGE_API_KEY is set (Upstage path)", () => {
    savedUpstage = process.env["UPSTAGE_API_KEY"];
    process.env["UPSTAGE_API_KEY"] = "test-key-123";
    const p = requireRealEmbeddingProvider({});
    expect(p.model).toContain("upstage");
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
