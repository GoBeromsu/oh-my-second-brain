import { describe, expect, it, vi } from "vitest";
import {
  capsToEngineStatusResult,
  cleanupResultUnavailable,
  engineGraphBuildResultToMcp,
  engineGraphBuildToStatusResult,
  engineStatusResultToMcp,
  engineStatusToCollectionResult,
  engineStatusToContextResult,
  engineSyncResultToCleanupResult,
  engineSyncResultToMcp,
  graphBuildOptionsToEngineArgs,
  statusResultUnavailable,
  syncOptionsToEngineArgs,
  syncResultUnavailable,
} from "./op-mappers.js";
import type { McpSemanticEmbeddingSyncOptions } from "./types.js";
import type { EmbeddingProvider, VectorStore } from "../types.js";

// ---------------------------------------------------------------------------
// Fake backends
// ---------------------------------------------------------------------------

function makeEmbed(model = "test-model", dims = 64): EmbeddingProvider {
  return {
    model,
    dimensions: dims,
    embed: vi.fn().mockResolvedValue(new Float32Array(dims)),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStore(): VectorStore {
  return {
    upsert: vi.fn(),
    queryLex: vi.fn().mockReturnValue([]),
    queryVec: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
}

const SYNC_OPTS: McpSemanticEmbeddingSyncOptions = { vault: "/vault" };

// ---------------------------------------------------------------------------
// oms_sync_embeddings
// ---------------------------------------------------------------------------

const STATUS_SNAPSHOT = {
  available: true as const,
  storage: "oms-native-json" as const,
  models: { embedding: "test-model" },
};

describe("syncOptionsToEngineArgs", () => {
  it("defaults to empty paths, force=false, and undefined collection-config fields", () => {
    expect(syncOptionsToEngineArgs(SYNC_OPTS)).toEqual({
      paths: [],
      collection: undefined,
      collectionPath: undefined,
      pattern: undefined,
      ignore: undefined,
      includeByDefault: undefined,
      updateCommand: undefined,
      context: undefined,
      force: false,
    });
  });

  it("passes collection and force through", () => {
    const opts: McpSemanticEmbeddingSyncOptions = {
      vault: "/v",
      collection: "main",
      force: true,
    };
    expect(syncOptionsToEngineArgs(opts)).toMatchObject({ collection: "main", force: true });
  });

  it("threads all 6 collection-config fields through", () => {
    const opts: McpSemanticEmbeddingSyncOptions = {
      vault: "/v",
      collectionPath: "/vault/notes",
      pattern: "**/*.md",
      ignore: ["private/**"],
      includeByDefault: false,
      updateCommand: "git pull",
      context: "My personal notes",
    };
    const args = syncOptionsToEngineArgs(opts);
    expect(args.collectionPath).toBe("/vault/notes");
    expect(args.pattern).toBe("**/*.md");
    expect(args.ignore).toEqual(["private/**"]);
    expect(args.includeByDefault).toBe(false);
    expect(args.updateCommand).toBe("git pull");
    expect(args.context).toBe("My personal notes");
  });
});

describe("engineSyncResultToMcp", () => {
  it("returns available=true with write-index step", () => {
    const result = engineSyncResultToMcp(
      { upserted: 10, skipped: 2, errors: 0 },
      SYNC_OPTS,
      STATUS_SNAPSHOT,
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.storage).toBe("oms-native-json");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.name).toBe("write-index");
    expect(result.steps[0]!.documents).toBe(10);
    expect(result.steps[0]!.status).toBe(0);
  });

  it("populates the mandatory status field from the snapshot", () => {
    const snap = {
      available: true as const,
      storage: "oms-native-json" as const,
      models: { embedding: "embed-v2" },
    };
    const result = engineSyncResultToMcp(
      { upserted: 5, skipped: 0, errors: 0 },
      SYNC_OPTS,
      snap,
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.status.available).toBe(true);
    expect(result.status.models.embedding).toBe("embed-v2");
  });

  it("uses opts.storage when provided", () => {
    const opts: McpSemanticEmbeddingSyncOptions = {
      vault: "/v",
      storage: "qmd-sqlite",
    };
    const result = engineSyncResultToMcp(
      { upserted: 0, skipped: 0, errors: 0 },
      opts,
      STATUS_SNAPSHOT,
    );
    if (!result.available) return;
    expect(result.storage).toBe("qmd-sqlite");
  });
});

describe("syncResultUnavailable", () => {
  it("returns available=false with reason and empty steps", () => {
    const result = syncResultUnavailable("provider missing", SYNC_OPTS);
    expect(result).toMatchObject({ available: false, reason: "provider missing", steps: [] });
  });
});

// ---------------------------------------------------------------------------
// oms_semantic_status
// ---------------------------------------------------------------------------

describe("capsToEngineStatusResult", () => {
  it("reflects embed model and dimensions", () => {
    const result = capsToEngineStatusResult(makeEmbed("my-model", 128), makeStore());
    expect(result).toEqual({ storeAvailable: true, model: "my-model", dimensions: 128 });
  });
});

describe("engineStatusResultToMcp", () => {
  it("available=true when store is available", () => {
    const result = engineStatusResultToMcp({
      storeAvailable: true,
      model: "embed-v1",
      dimensions: 64,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.models.embedding).toBe("embed-v1");
    expect(result.storage).toBe("oms-native-json");
  });

  it("available=false when store is unavailable", () => {
    const result = engineStatusResultToMcp({
      storeAvailable: false,
      model: "",
      dimensions: 0,
    });
    expect(result.available).toBe(false);
  });
});

describe("statusResultUnavailable", () => {
  it("returns available=false with reason", () => {
    expect(statusResultUnavailable("no store")).toEqual({
      available: false,
      reason: "no store",
    });
  });
});

// ---------------------------------------------------------------------------
// oms_semantic_collections
// ---------------------------------------------------------------------------

describe("engineStatusToCollectionResult", () => {
  it("returns synthetic default collection when store available", () => {
    const result = engineStatusToCollectionResult({
      storeAvailable: true,
      model: "m",
      dimensions: 4,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]!.name).toBe("default");
  });

  it("returns available=false when store unavailable", () => {
    const result = engineStatusToCollectionResult({
      storeAvailable: false,
      model: "",
      dimensions: 0,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.collections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// oms_semantic_contexts
// ---------------------------------------------------------------------------

describe("engineStatusToContextResult", () => {
  it("returns empty context list when store available", () => {
    const result = engineStatusToContextResult({
      storeAvailable: true,
      model: "m",
      dimensions: 4,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.contexts).toHaveLength(0);
  });

  it("returns available=false when store unavailable", () => {
    const result = engineStatusToContextResult({
      storeAvailable: false,
      model: "",
      dimensions: 0,
    });
    expect(result.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// oms_semantic_cleanup
// ---------------------------------------------------------------------------

describe("engineSyncResultToCleanupResult", () => {
  it("maps errors → removedDocuments, upserted → remainingDocuments", () => {
    const result = engineSyncResultToCleanupResult({ upserted: 50, skipped: 0, errors: 3 });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.removedDocuments).toBe(3);
    expect(result.remainingDocuments).toBe(50);
    expect(result.storage).toBe("oms-native-json");
  });
});

describe("cleanupResultUnavailable", () => {
  it("returns available=false with storage and reason", () => {
    const result = cleanupResultUnavailable("index locked");
    expect(result).toMatchObject({ available: false, reason: "index locked", storage: "oms-native-json" });
  });
});

// ---------------------------------------------------------------------------
// oms_graph_build / oms_graph_status
// ---------------------------------------------------------------------------

describe("graphBuildOptionsToEngineArgs", () => {
  it("defaults dryRun to false", () => {
    expect(graphBuildOptionsToEngineArgs({}, "/vault")).toEqual({
      vaultPath: "/vault",
      dryRun: false,
    });
  });

  it("passes dryRun=true through", () => {
    expect(graphBuildOptionsToEngineArgs({ dryRun: true }, "/v")).toEqual({
      vaultPath: "/v",
      dryRun: true,
    });
  });
});

describe("engineGraphBuildResultToMcp", () => {
  it("maps notes, edges, generatedAt", () => {
    const result = engineGraphBuildResultToMcp({
      notes: 42,
      edges: 100,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({
      available: true,
      notes: 42,
      edges: 100,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("engineGraphBuildToStatusResult", () => {
  it("null → available=false (cache not built)", () => {
    const result = engineGraphBuildToStatusResult(null);
    expect(result.available).toBe(false);
  });

  it("non-null → available=true with stats", () => {
    const result = engineGraphBuildToStatusResult({
      notes: 10,
      edges: 20,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.notes).toBe(10);
    expect(result.edges).toBe(20);
    expect(result.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
