import { describe, it, expect, vi } from "vitest";
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

describe("GGUF embedding provider runtime guards", () => {
  it("uses the same closed formatter before fake GGUF embeddings", async () => {
    const inputs: string[] = [];
    const loadModel = async () => ({
      tokenize: (text: string) => [text],
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext: async () => ({
        getEmbeddingFor: async (input: string) => {
          inputs.push(input);
          return { vector: [3, 4] };
        },
        dispose: async () => undefined,
      }),
      dispose: async () => undefined,
    });
    const provider = createGGUFEmbeddingProvider("/fake/model.gguf", {
      dimensions: 2,
      prefixScheme: "qwen3-embedding-v1",
    }, undefined, loadModel as never);

    await provider.embedQuery("question");
    await provider.embed("document", "Document title");
    expect(inputs).toEqual([
      "Instruct: Retrieve relevant documents for the given query\nQuery: question",
      "Document title\ndocument",
    ]);
    await provider.dispose();
  });

  it("never evaluates two embeddings on the same native context", async () => {
    // The sync kernel may have several documents in flight. Round-robin assignment
    // is not sufficient: when one call finishes early, its next chunk can land on a
    // different context that is still busy. This fake yields once after entering so
    // every unsafe overlap is visible without sleep or wall-clock timing.
    let contextId = 0;
    const contextOptions: Array<Record<string, unknown>> = [];
    const activeByContext = new Map<number, number>();
    const maxByContext = new Map<number, number>();
    const loadModel = async () => ({
      tokenize: (text: string) => [text],
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext: async (options: Record<string, unknown>) => {
        const id = contextId;
        contextId += 1;
        contextOptions.push(options);
        return {
          getEmbeddingFor: async () => {
            const active = (activeByContext.get(id) ?? 0) + 1;
            activeByContext.set(id, active);
            maxByContext.set(id, Math.max(maxByContext.get(id) ?? 0, active));
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeByContext.set(id, active - 1);
            return { vector: [3, 4] };
          },
          dispose: async () => undefined,
        };
      },
      dispose: async () => undefined,
    });
    const provider = createGGUFEmbeddingProvider(
      "/fake/model.gguf",
      { dimensions: 2 },
      undefined,
      loadModel as never,
    );

    const calls = (provider.maxConcurrency ?? 1) * 3;
    await Promise.all(Array.from({ length: calls }, (_, index) => provider.embed(`text ${index}`)));

    expect(contextId).toBe(provider.maxConcurrency);
    expect([...maxByContext.values()]).toEqual(
      Array.from({ length: provider.maxConcurrency ?? 1 }, () => 1),
    );
    // qmd and node-llama's measured fast path leaves batch sizing to the runtime.
    // Forcing it equal to the 2048-token context made the exact same 19 documents
    // take 23.68s instead of 12.42s and raised peak memory. Pin the absence so a
    // seemingly harmless "make all sizes explicit" cleanup cannot restore the 2×
    // regression.
    expect(contextOptions.every((options) => options.batchSize === undefined)).toBe(true);
    expect(contextOptions.every((options) => options.contextSize === 2048)).toBe(true);
    await provider.dispose();
  });

  it.each([
    "unknown-v1",
    "{\"query\":\"Q:\"}",
    "query=Q:,passage=P:",
  ])("rejects unsupported legacy or unknown prompt scheme %s", (prefixScheme) => {
    expect(() => createGGUFEmbeddingProvider("/fake/model.gguf", { dimensions: 2, prefixScheme }))
      .toThrow(/Unsupported embedding prefixScheme/);
  });

  it("does not dispose active contexts, rejects waiters, and disposes exactly once", async () => {
    const gates: Array<{ resolve: () => void; promise: Promise<void> }> = [];
    let entered = 0;
    let poolSize = 0;
    let releaseEntered: (() => void) | undefined;
    const allEntered = new Promise<void>((resolve) => { releaseEntered = resolve; });
    let contextsDisposed = 0;
    let modelDisposed = 0;
    const loadModel = async () => ({
      tokenize: (text: string) => [text],
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext: async () => ({
        getEmbeddingFor: async () => {
          entered += 1;
          if (entered === poolSize) releaseEntered?.();
          let resolve!: () => void;
          const promise = new Promise<void>((done) => { resolve = done; });
          gates.push({ resolve, promise });
          await promise;
          return { vector: [3, 4] };
        },
        dispose: async () => { contextsDisposed += 1; },
      }),
      dispose: async () => { modelDisposed += 1; },
    });
    const provider = createGGUFEmbeddingProvider("/fake/model.gguf", { dimensions: 2 }, undefined, loadModel as never);
    poolSize = provider.maxConcurrency ?? 1;
    const active = Array.from({ length: poolSize }, (_, index) => provider.embed(`active ${index}`));
    await allEntered;
    const waiter = provider.embed("queued");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstDispose = provider.dispose();
    const secondDispose = provider.dispose();
    await expect(waiter).rejects.toThrow(/disposed/);
    expect(contextsDisposed).toBe(0);
    for (const gate of gates) gate.resolve();
    await Promise.all(active);
    await Promise.all([firstDispose, secondDispose]);
    expect(contextsDisposed).toBe(poolSize);
    expect(modelDisposed).toBe(1);
    await expect(provider.embed("after dispose")).rejects.toThrow(/disposed/);
  });

  it("waits for a single-flight load before concurrent disposal", async () => {
    let releaseLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let modelDisposed = 0;
    const loadModel = async () => {
      await loadStarted;
      return {
        tokenize: (text: string) => [text],
        detokenize: (tokens: string[]) => tokens.join(""),
        createEmbeddingContext: async () => ({
          getEmbeddingFor: async () => ({ vector: [3, 4] }),
          dispose: async () => undefined,
        }),
        dispose: async () => { modelDisposed += 1; },
      };
    };
    const provider = createGGUFEmbeddingProvider("/fake/model.gguf", { dimensions: 2 }, undefined, loadModel as never);
    const embedding = provider.embed("loading");
    const firstDispose = provider.dispose();
    const secondDispose = provider.dispose();
    releaseLoad();
    await expect(embedding).rejects.toThrow(/disposed/);
    await Promise.all([firstDispose, secondDispose]);
    expect(modelDisposed).toBe(1);
  });

  it("unloads an idle pool only after completed work", async () => {
    vi.useFakeTimers();
    let contextDisposed = 0;
    let modelDisposed = 0;
    const loadModel = async () => ({
      tokenize: (text: string) => [text],
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext: async () => ({
        getEmbeddingFor: async () => ({ vector: [3, 4] }),
        dispose: async () => { contextDisposed += 1; },
      }),
      dispose: async () => { modelDisposed += 1; },
    });
    const provider = createGGUFEmbeddingProvider("/fake/model.gguf", { dimensions: 2 }, undefined, loadModel as never);
    await provider.embed("idle");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(contextDisposed).toBe(provider.maxConcurrency);
    expect(modelDisposed).toBe(1);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// requireRealEmbeddingProvider factory (GGUF path)
// ---------------------------------------------------------------------------

describe("requireRealEmbeddingProvider — GGUF path", () => {
  it("returns GGUF provider when provider=gguf + model are provided", () => {
    const p = requireRealEmbeddingProvider({ provider: "gguf", model: "/fake/model.gguf" });
    expect(p.model).toMatch(/^node-llama-cpp:/);
    expect(p.dimensions).toBe(GGUF_EMBEDDING_DIMENSIONS);
  });

  it("GGUF provider reports 768 dimensions (spec: float[768] no-fold)", () => {
    const p = createGGUFEmbeddingProvider("/fake/model.gguf");
    expect(p.dimensions).toBe(768);
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
  it("THROWS asking for OMS_EMBEDDING_PROVIDER when no provider is configured", () => {
    expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_EMBEDDING_PROVIDER");
  });

  it("THROWS asking for OMS_EMBEDDING_MODEL when provider is set but model is missing", () => {
    expect(() => requireRealEmbeddingProvider({ provider: "gguf" })).toThrow("OMS_EMBEDDING_MODEL");
  });

  it("returns GGUF provider (dimensions===768) when provider=gguf + model are given", () => {
    const p = requireRealEmbeddingProvider({ provider: "gguf", model: "/fake/model.gguf" });
    expect(p.model).toMatch(/^node-llama-cpp:/);
    expect(p.dimensions).toBe(768);
  });

  it("rejects non-local providers and names local GGUF as the only support", () => {
    expect(() =>
      requireRealEmbeddingProvider({ provider: "remote", model: "remote-embedding" }),
    ).toThrow(/unsupported.*gguf/i);
  });

  it("THROWS for an unsupported provider id", () => {
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
