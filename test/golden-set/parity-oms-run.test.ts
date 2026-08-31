import { describe, expect, it, vi } from "vitest";
import { runOmsMeasuredParityArm } from "./parity-oms-run.js";
import type { FrozenSettings } from "./parity-preregistration.js";

const settings = (expansion: boolean): FrozenSettings => ({
  candidateLimit: 40,
  k: 10,
  rrfK: 60,
  rerank: expansion,
  expansion,
  embedModel: "model",
  embedRevision: "revision",
  embedSha256: "e".repeat(64),
  embedPromptScheme: "scheme",
  qmdEmbedUri: "hf:example/model.gguf",
  ...(expansion ? {
    rerankModel: "reranker",
    rerankRevision: "rerank-revision",
    rerankSha256: "1".repeat(64),
    qmdRerankUri: "hf:example/reranker.gguf",
    generateModel: "generator",
    generateRevision: "generate-revision",
    generateSha256: "2".repeat(64),
    generatePromptScheme: "qmd-query-expansion-v2.8.3",
    qmdGenerateUri: "hf:example/generator.gguf",
  } : {}),
});

const queries = [
  { id: "lex-1", type: "lex" as const, queryClass: "ko", query: "평온" },
  { id: "vec-1", type: "vec" as const, queryClass: "en", query: "calm" },
  { id: "hyde-1", type: "hyde" as const, queryClass: "mixed", query: "a calm passage" },
];

function clock(step = 10) {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

describe("runOmsMeasuredParityArm", () => {
  it("derives B1 counts, vector parity, RSS, embed wall, and p95 from the actual run", async () => {
    const semanticQuery = vi.fn().mockResolvedValue({
      available: true,
      hits: [{ path: "notes/calm.md", score: 1 }],
    });
    const syncVault = vi.fn().mockResolvedValue({
      available: true,
      scanned: 2,
      added: 2,
      updated: 0,
      skipped: 0,
    });

    const result = await runOmsMeasuredParityArm({
      engine: { adapter: { semanticQuery } as never, syncVault: syncVault as never },
      queries,
      settings: settings(false),
      dbPath: "/unused",
      sampleIntervalMs: 0,
      probes: { now: clock(), rss: () => 4096 },
      inspectCounts: () => ({ documents: 2, chunks: 4, vectors: 4 }),
    });

    expect(syncVault).toHaveBeenCalledWith({ files: undefined, embed: true });
    expect(result.rows.map(({ type }) => type)).toEqual(["lex", "vec"]);
    expect(result.operability).toEqual({
      exitCode: 0,
      scanned: 2,
      indexed: 2,
      skipped: 0,
      errors: 0,
      vectorCount: 4,
      expectedVectorCount: 4,
      peakRssBytes: 4096,
      embedWallMs: 10,
      plainQueryP95Ms: 10,
    });
  });

  it("measures B2 plain and precision p95 independently", async () => {
    const semanticQuery = vi.fn().mockResolvedValue({ available: true, hits: [] });
    const result = await runOmsMeasuredParityArm({
      engine: {
        adapter: { semanticQuery } as never,
        syncVault: vi.fn().mockResolvedValue({
          available: true,
          scanned: 3,
          added: 3,
          updated: 0,
          skipped: 0,
        }) as never,
      },
      queries,
      settings: settings(true),
      dbPath: "/unused",
      sampleIntervalMs: 0,
      probes: { now: clock(5), rss: () => 8192 },
      inspectCounts: () => ({ documents: 3, chunks: 6, vectors: 6 }),
    });

    expect(semanticQuery).toHaveBeenCalledTimes(6);
    expect(semanticQuery.mock.calls.slice(0, 3).every(([options]) =>
      options.strategy === undefined && options.query !== undefined)).toBe(true);
    expect(semanticQuery.mock.calls.slice(3).every(([options]) =>
      options.strategy?.kind === "expand")).toBe(true);
    expect(result.operability).toMatchObject({
      plainQueryP95Ms: 5,
      precisionQueryP95Ms: 5,
      exitCode: 0,
    });
  });

  it("preserves sync and query failures as a failing operability input", async () => {
    const semanticQuery = vi.fn().mockResolvedValue({
      available: false,
      reason: "embedding unavailable",
      hits: [],
    });
    const result = await runOmsMeasuredParityArm({
      engine: {
        adapter: { semanticQuery } as never,
        syncVault: vi.fn().mockResolvedValue({
          available: false,
          reason: "checksum mismatch",
          scanned: 2,
          added: 0,
          updated: 0,
          skipped: 0,
        }) as never,
      },
      queries,
      settings: settings(false),
      dbPath: "/unused",
      sampleIntervalMs: 0,
      probes: { now: clock(), rss: () => 1024 },
      inspectCounts: () => ({ documents: 0, chunks: 0, vectors: 0 }),
    });

    expect(result.sync).toMatchObject({ available: false, reason: "checksum mismatch" });
    expect(result.rows.every((row) => row.error === "embedding unavailable")).toBe(true);
    expect(result.operability).toMatchObject({
      exitCode: 1,
      errors: 1,
      plainQueryP95Ms: Number.MAX_SAFE_INTEGER,
    });
  });
});
