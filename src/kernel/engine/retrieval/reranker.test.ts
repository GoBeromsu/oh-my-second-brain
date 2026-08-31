import { describe, expect, it, vi } from "vitest";
import {
  createLazyOwnedReranker,
  createLlamaReranker,
  type RankingContext,
  type RankingModel,
} from "./reranker.js";
import { PassthroughReranker, passthroughReranker } from "./passthrough.test-helper.js";
import type { DisposableReranker, Reranker } from "./reranker.js";
import type { ScoredHit } from "../types.js";
import { readFileSync } from "node:fs";
import path from "node:path";

function hit(docPath: string, score: number): ScoredHit {
  return { docPath, chunkOrdinal: 0, score };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("PassthroughReranker", () => {
  it("documents the locked no-fake embedder contract", () => {
    const adr = readFileSync(
      path.resolve(process.cwd(), "docs/decisions/ADR-007-no-fake-embedder-fallback-native-dim-integrity.md"),
      "utf8",
    );
    expect(adr).toContain("OMS_EMBEDDING_PROVIDER");
    expect(adr).toContain("OMS_EMBEDDING_MODEL");
    expect(adr).toMatch(/available:\s*false|guidance naming/i);
  });

  it("satisfies the Reranker interface", () => {
    const r: Reranker = new PassthroughReranker();
    expect(typeof r.rerank).toBe("function");
  });

  it("returns hits in the original order unchanged", async () => {
    const hits: ScoredHit[] = [
      hit("first.md", 0.9),
      hit("second.md", 0.7),
      hit("third.md", 0.5),
    ];
    const result = await passthroughReranker.rerank("some query", hits);
    expect(result).toHaveLength(3);
    expect(result[0]!.docPath).toBe("first.md");
    expect(result[1]!.docPath).toBe("second.md");
    expect(result[2]!.docPath).toBe("third.md");
  });

  it("preserves scores exactly", async () => {
    const hits: ScoredHit[] = [hit("a.md", 0.123456), hit("b.md", 0.654321)];
    const result = await passthroughReranker.rerank("q", hits);
    expect(result[0]!.score).toBe(0.123456);
    expect(result[1]!.score).toBe(0.654321);
  });

  it("handles empty hit list", async () => {
    const result = await passthroughReranker.rerank("q", []);
    expect(result).toEqual([]);
  });

  it("singleton and new instance behave identically", async () => {
    const hits = [hit("x.md", 0.5)];
    const fromSingleton = await passthroughReranker.rerank("q", hits);
    const fromNew = await new PassthroughReranker().rerank("q", hits);
    expect(fromSingleton).toEqual(fromNew);
  });
});

describe("createLazyOwnedReranker", () => {
  it("constructs once for concurrent first calls and reuses the inner reranker", async () => {
    const construction = deferred<Reranker>();
    const rerank = vi.fn(async (_query: string, hits: ScoredHit[]) => hits);
    const factory = vi.fn(() => construction.promise);
    const reranker = createLazyOwnedReranker(factory);
    const first = reranker.rerank("first", [hit("first.md", 0.8)]);
    const second = reranker.rerank("second", [hit("second.md", 0.7)]);

    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    construction.resolve({ rerank });
    await expect(first).resolves.toEqual([hit("first.md", 0.8)]);
    await expect(second).resolves.toEqual([hit("second.md", 0.7)]);

    await reranker.rerank("third", [hit("third.md", 0.6)]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(rerank).toHaveBeenCalledTimes(3);
    await reranker.dispose();
  });

  it("does not construct for empty or cancelled requests", async () => {
    const factory = vi.fn(() => ({
      rerank: vi.fn(async (_query: string, hits: ScoredHit[]) => hits),
    }));
    const reranker = createLazyOwnedReranker(factory);

    await expect(reranker.rerank("empty", [])).resolves.toEqual([]);
    await expect(
      reranker.rerank("cancelled", [hit("first.md", 0.8)], { cancelled: true }),
    ).rejects.toThrow(/cancelled/i);
    expect(factory).not.toHaveBeenCalled();
    await reranker.dispose();
  });

  it("propagates factory failures without constructing a passthrough", async () => {
    const failure = new Error("model unavailable");
    const factory = vi.fn(() => Promise.reject(failure));
    const reranker = createLazyOwnedReranker(factory);

    await expect(reranker.rerank("query", [hit("first.md", 0.8)])).rejects.toThrow(failure);
    await expect(reranker.dispose()).rejects.toThrow(failure);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("propagates inner rerank failures", async () => {
    const failure = new Error("ranking failed");
    const reranker = createLazyOwnedReranker(() => ({
      rerank: async () => {
        throw failure;
      },
    }));

    await expect(reranker.rerank("query", [hit("first.md", 0.8)])).rejects.toThrow(failure);
    await reranker.dispose();
  });

  it("allows admitted calls to drain before disposing the owned inner reranker", async () => {
    const rankGate = deferred<void>();
    const dispose = vi.fn(async () => undefined);
    const inner: DisposableReranker = {
      rerank: async (_query, hits) => {
        await rankGate.promise;
        return hits;
      },
      dispose,
    };
    const reranker = createLazyOwnedReranker(() => inner);
    const ranking = reranker.rerank("query", [hit("first.md", 0.8)]);

    await Promise.resolve();
    const disposing = reranker.dispose();
    expect(reranker.dispose()).toBe(disposing);
    await expect(reranker.rerank("new", [hit("second.md", 0.7)])).rejects.toThrow(/disposed/i);
    expect(dispose).not.toHaveBeenCalled();

    rankGate.resolve();
    await ranking;
    await disposing;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not construct when disposed before use", async () => {
    const factory = vi.fn(() => ({
      rerank: vi.fn(async (_query: string, hits: ScoredHit[]) => hits),
    }));
    const reranker = createLazyOwnedReranker(factory);

    const firstDispose = reranker.dispose();
    expect(reranker.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(factory).not.toHaveBeenCalled();
    await expect(reranker.rerank("query", [hit("first.md", 0.8)])).rejects.toThrow(/disposed/i);
  });

  it("disposes a factory result that resolves after disposal starts", async () => {
    const construction = deferred<Reranker>();
    const dispose = vi.fn(async () => undefined);
    const reranker = createLazyOwnedReranker(() => construction.promise);
    const ranking = reranker.rerank("query", [hit("first.md", 0.8)]);

    await Promise.resolve();
    const disposing = reranker.dispose();
    construction.resolve({
      rerank: async (_query, hits) => hits,
      dispose,
    });

    await ranking;
    await disposing;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("supports inner rerankers without dispose", async () => {
    const rerank = vi.fn(async (_query: string, hits: ScoredHit[]) => hits);
    const reranker = createLazyOwnedReranker(() => ({ rerank }));

    await expect(reranker.rerank("query", [hit("first.md", 0.8)])).resolves.toEqual([
      hit("first.md", 0.8),
    ]);
    await expect(reranker.dispose()).resolves.toBeUndefined();
  });
});

function fakeLoader(scores: readonly number[] = []): {
  load: ReturnType<typeof vi.fn>;
  createContext: ReturnType<typeof vi.fn>;
  rankAll: ReturnType<typeof vi.fn>;
  contextDispose: ReturnType<typeof vi.fn>;
  modelDispose: ReturnType<typeof vi.fn>;
} {
  const rankAll = vi.fn(async (_query: string, documents: string[]) =>
    scores.length > 0 ? scores.slice(0, documents.length) : documents.map(() => 0.5),
  );
  const contextDispose = vi.fn(async () => undefined);
  const modelDispose = vi.fn(async () => undefined);
  const context: RankingContext = { rankAll, dispose: contextDispose };
  const createContext = vi.fn(async () => context);
  const model: RankingModel = {
    createRankingContext: createContext,
    dispose: modelDispose,
  };
  const load = vi.fn(async (_modelPath: string) => model);
  return { load, createContext, rankAll, contextDispose, modelDispose };
}

describe("LlamaReranker", () => {
  it("does not load a model or create a context until reranking is requested", async () => {
    const fake = fakeLoader();
    const reranker = createLlamaReranker({ modelPath: "/tmp/reranker.gguf", loadModel: fake.load });

    expect(fake.load).not.toHaveBeenCalled();
    expect(fake.createContext).not.toHaveBeenCalled();
    await reranker.dispose();
    expect(fake.load).not.toHaveBeenCalled();
    expect(fake.createContext).not.toHaveBeenCalled();
  });

  it("caps candidates before ranking and returns only the capped, reranked hits", async () => {
    const fake = fakeLoader([0.1, 0.9]);
    const reranker = createLlamaReranker({
      modelPath: "/tmp/reranker.gguf",
      candidateCap: 2,
      loadModel: fake.load,
    });
    const result = await reranker.rerank("query", [
      hit("first.md", 0.8),
      hit("second.md", 0.7),
      hit("third.md", 0.6),
    ]);

    expect(fake.rankAll).toHaveBeenCalledWith("query", ["first.md", "second.md"]);
    expect(result.map((entry) => entry.docPath)).toEqual(["second.md", "first.md"]);
    expect(result).toHaveLength(2);
    await reranker.dispose();
  });

  it("keeps the model loaded by default (idle unload is opt-in)", async () => {
    const fake = fakeLoader();
    const reranker = createLlamaReranker({ modelPath: "/tmp/reranker.gguf", loadModel: fake.load });

    await reranker.rerank("query", [hit("first.md", 0.8)]);
    expect(fake.modelDispose).not.toHaveBeenCalled();
    expect(fake.contextDispose).not.toHaveBeenCalled();
    await reranker.dispose();
  });

  it("unloads context and model after an enabled idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeLoader();
      const reranker = createLlamaReranker({
        modelPath: "/tmp/reranker.gguf",
        idleUnloadMs: 10,
        loadModel: fake.load,
      });

      await reranker.rerank("query", [hit("first.md", 0.8)]);
      await vi.advanceTimersByTimeAsync(11);
      expect(fake.contextDispose).toHaveBeenCalledTimes(1);
      expect(fake.modelDispose).toHaveBeenCalledTimes(1);
      await reranker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight rank call before disposing native resources", async () => {
    let releaseRank!: () => void;
    const rankFinished = new Promise<void>((resolve) => {
      releaseRank = resolve;
    });
    const fake = fakeLoader();
    fake.rankAll.mockImplementation(async () => {
      await rankFinished;
      return [0.5];
    });
    const reranker = createLlamaReranker({ modelPath: "/tmp/reranker.gguf", loadModel: fake.load });
    const ranking = reranker.rerank("query", [hit("first.md", 0.8)]);
    await Promise.resolve();
    const disposing = reranker.dispose();
    await Promise.resolve();
    expect(fake.contextDispose).not.toHaveBeenCalled();
    expect(fake.modelDispose).not.toHaveBeenCalled();

    releaseRank();
    await ranking;
    await disposing;
    expect(fake.contextDispose).toHaveBeenCalledTimes(1);
    expect(fake.modelDispose).toHaveBeenCalledTimes(1);
  });

  it("rejects cancelled requests and does not rank them", async () => {
    const fake = fakeLoader();
    const reranker = createLlamaReranker({ modelPath: "/tmp/reranker.gguf", loadModel: fake.load });
    await expect(
      reranker.rerank("query", [hit("first.md", 0.8)], { cancelled: true }),
    ).rejects.toThrow(/cancelled/i);
    expect(fake.load).not.toHaveBeenCalled();
    await reranker.dispose();
  });
});
