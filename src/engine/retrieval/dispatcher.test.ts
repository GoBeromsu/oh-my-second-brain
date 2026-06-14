import { describe, expect, it, vi } from "vitest";
import { dispatch, createCancelToken } from "./dispatcher.js";
import type { DispatcherDeps } from "./dispatcher.js";
import type { EmbeddingProvider, GphQuery, ScoredHit, VectorStore } from "../types.js";

// ---------------------------------------------------------------------------
// Fake backends
// ---------------------------------------------------------------------------

function makeStore(
  lexHits: ScoredHit[] = [],
  vecHits: ScoredHit[] = [],
): VectorStore {
  return {
    upsert: vi.fn(),
    queryLex: vi.fn().mockReturnValue(lexHits),
    queryVec: vi.fn().mockReturnValue(vecHits),
    close: vi.fn(),
  };
}

function makeEmbed(vec: Float32Array = new Float32Array([0.1, 0.2, 0.3, 0.4])): EmbeddingProvider {
  return {
    model: "test-embed",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue(vec),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const LEX_HIT: ScoredHit = { docPath: "lex-result.md", chunkOrdinal: 0, score: 0.8 };
const VEC_HIT: ScoredHit = { docPath: "vec-result.md", chunkOrdinal: 0, score: 0.9 };
const GRAPH_HIT: ScoredHit = { docPath: "graph-result.md", chunkOrdinal: 0, score: 0.7 };

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("dispatch — routing", () => {
  it("lex sub-query calls store.queryLex and not store.queryVec or embed", async () => {
    const store = makeStore([LEX_HIT], []);
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    const results = await dispatch([{ type: "lex", query: "hello" }], deps);

    expect(store.queryLex).toHaveBeenCalledWith("hello", 10);
    expect(store.queryVec).not.toHaveBeenCalled();
    expect(embed.embed).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.docPath).toBe("lex-result.md");
  });

  it("vec sub-query calls embed then store.queryVec", async () => {
    const store = makeStore([], [VEC_HIT]);
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    const results = await dispatch([{ type: "vec", query: "semantic query" }], deps);

    expect(embed.embed).toHaveBeenCalledWith("semantic query");
    expect(store.queryVec).toHaveBeenCalled();
    expect(store.queryLex).not.toHaveBeenCalled();
    expect(results[0]!.docPath).toBe("vec-result.md");
  });

  it("hyde sub-query calls hydeGenerator then embed then store.queryVec", async () => {
    const store = makeStore([], [VEC_HIT]);
    const embed = makeEmbed();
    const hydeGenerator = vi.fn().mockResolvedValue("hypothetical answer text");
    const deps: DispatcherDeps = { store, embed, hydeGenerator };

    const results = await dispatch([{ type: "hyde", query: "what is RRF?" }], deps);

    expect(hydeGenerator).toHaveBeenCalledWith("what is RRF?");
    expect(embed.embed).toHaveBeenCalledWith("hypothetical answer text");
    expect(store.queryVec).toHaveBeenCalled();
    expect(results[0]!.docPath).toBe("vec-result.md");
  });

  it("hyde with no hydeGenerator falls back to identity stub (embeds the query directly)", async () => {
    const store = makeStore([], [VEC_HIT]);
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    await dispatch([{ type: "hyde", query: "fallback query" }], deps);

    // Without hydeGenerator, embed is called with the original query string
    expect(embed.embed).toHaveBeenCalledWith("fallback query");
  });

  it("graph sub-query calls graphTraverse with bfs GphQuery", async () => {
    const store = makeStore([], []);
    const embed = makeEmbed();
    const graphTraverse = vi.fn<[GphQuery], Promise<ScoredHit[]>>().mockResolvedValue([GRAPH_HIT]);
    const deps: DispatcherDeps = { store, embed, graphTraverse };

    const results = await dispatch([{ type: "graph", query: "seed-note.md" }], deps);

    expect(graphTraverse).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "bfs", seed: "seed-note.md" }),
    );
    expect(results[0]!.docPath).toBe("graph-result.md");
  });

  it("graph sub-query with no graphTraverse returns empty list", async () => {
    const store = makeStore([], []);
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    const results = await dispatch([{ type: "graph", query: "seed.md" }], deps);

    expect(results).toHaveLength(0);
  });

  it("empty subQueries returns empty list", async () => {
    const deps: DispatcherDeps = { store: makeStore(), embed: makeEmbed() };
    const results = await dispatch([], deps);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fusion tests
// ---------------------------------------------------------------------------

describe("dispatch — RRF fusion", () => {
  it("fuses lex and vec results via RRF (shared doc scores accumulate)", async () => {
    const sharedHit: ScoredHit = { docPath: "shared.md", chunkOrdinal: 0, score: 0.5 };
    const store = makeStore([sharedHit], [sharedHit]);
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    const results = await dispatch(
      [{ type: "lex", query: "q" }, { type: "vec", query: "q" }],
      deps,
    );

    // shared.md appears in both lists → higher fused score than if from only one
    const sharedResult = results.find((r) => r.docPath === "shared.md");
    expect(sharedResult).toBeDefined();
    // From two rank-1 positions: 2 × (1/61) ≈ 0.0328
    expect(sharedResult!.score).toBeCloseTo(2 / 61, 10);
  });

  it("perTypeScores contains raw scores per type", async () => {
    const store = makeStore(
      [{ docPath: "note.md", chunkOrdinal: 0, score: 0.88 }],
      [],
    );
    const embed = makeEmbed();
    const deps: DispatcherDeps = { store, embed };

    const results = await dispatch([{ type: "lex", query: "q" }], deps);

    expect(results[0]!.perTypeScores).toEqual({ lex: 0.88 });
  });

  it("provenance boost is applied and provenance field is set", async () => {
    const store = makeStore([{ docPath: "my-note.md", chunkOrdinal: 0, score: 0.5 }], []);
    const embed = makeEmbed();
    const provenanceMap = vi.fn().mockReturnValue("authored");
    const deps: DispatcherDeps = { store, embed, provenanceMap };

    const results = await dispatch([{ type: "lex", query: "q" }], deps);

    expect(results[0]!.provenance).toBe("authored");
    // base RRF score 1/61 + authored boost 0.02
    expect(results[0]!.score).toBeCloseTo(1 / 61 + 0.02, 10);
  });

  it("results are sorted descending by final score", async () => {
    // low-score lex hit + high-score graph hit → graph result should rank first
    const lowHit: ScoredHit = { docPath: "low.md", chunkOrdinal: 0, score: 0.1 };
    const highHit: ScoredHit = { docPath: "high.md", chunkOrdinal: 0, score: 0.9 };
    const store = makeStore([lowHit], []);
    const embed = makeEmbed();
    const graphTraverse = vi.fn<[GphQuery], Promise<ScoredHit[]>>().mockResolvedValue([highHit]);
    const deps: DispatcherDeps = { store, embed, graphTraverse };

    const results = await dispatch(
      [{ type: "lex", query: "q" }, { type: "graph", query: "seed.md" }],
      deps,
    );

    expect(results[0]!.docPath).toBe("high.md");
    expect(results[1]!.docPath).toBe("low.md");
  });
});

// ---------------------------------------------------------------------------
// Cancel token
// ---------------------------------------------------------------------------

describe("createCancelToken", () => {
  it("starts uncancelled", () => {
    const token = createCancelToken();
    expect(token.cancelled).toBe(false);
  });

  it("becomes cancelled after cancel()", () => {
    const token = createCancelToken();
    token.cancel();
    expect(token.cancelled).toBe(true);
  });

  it("dispatch rejects when token is pre-cancelled", async () => {
    const store = makeStore([{ docPath: "x.md", chunkOrdinal: 0, score: 1 }]);
    const deps: DispatcherDeps = { store, embed: makeEmbed() };
    const token = createCancelToken();
    token.cancel();

    await expect(
      dispatch([{ type: "lex", query: "q" }], deps, 10, token),
    ).rejects.toThrow("cancelled");
  });
});
