import { describe, expect, it, vi } from "vitest";
import {
  createLlamaReranker,
  PassthroughReranker,
  passthroughReranker,
  type RankingContext,
  type RankingModel,
} from "./reranker.js";
import type { Reranker } from "./reranker.js";
import type { ScoredHit } from "../types.js";
import { readFileSync } from "node:fs";
import path from "node:path";

function hit(docPath: string, score: number): ScoredHit {
  return { docPath, chunkOrdinal: 0, score };
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
