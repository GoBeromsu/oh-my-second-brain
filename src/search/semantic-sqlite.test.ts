import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  querySemanticStore,
  readSemanticDoctor,
  readSemanticStatus,
  syncSemanticEmbeddingStore,
} from "./semantic.js";
import { writeSemanticFixtureVault } from "./semantic-test-fixtures.js";

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("OMS qmd-compatible SQLite semantic backend", () => {
  it("syncs markdown into SQLite FTS/vector storage and reports qmd internals as implemented", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const sync = await syncSemanticEmbeddingStore({
      vault: tmpVault,
      collection: "obsidian",
      storage: "qmd-sqlite",
      pull: true,
      maxDocsPerBatch: 2,
      maxBatchMb: 1,
    });

    expect(sync.available).toBe(true);
    if (!sync.available) throw new Error(sync.reason);
    expect(sync.storage).toBe("qmd-sqlite");
    expect(sync.index).toBe(path.join(tmpVault, ".oms", "semantic-store.sqlite"));
    expect(sync.status.index?.documents).toEqual(expect.objectContaining({ total: 3, vectors: 3, pending: 0 }));
    expect(sync.status.qmdCompatibility?.unsupportedInternals).toEqual([]);

    const status = await readSemanticStatus({ vault: tmpVault, storage: "qmd-sqlite" });
    expect(status).toEqual(
      expect.objectContaining({
        available: true,
        storage: "qmd-sqlite",
        models: expect.objectContaining({
          embedding: "oms-sqlite-vec-hash-v1",
          reranking: "oms-sqlite-rrf-v1",
        }),
      }),
    );

    const vector = await querySemanticStore({
      vault: tmpVault,
      storage: "qmd-sqlite",
      collection: "obsidian",
      query: "native semantic index refresh",
      mode: "vsearch",
      limit: 1,
    });
    expect(vector.available).toBe(true);
    if (!vector.available) throw new Error(vector.reason);
    expect(vector.hits[0]).toEqual(
      expect.objectContaining({
        path: "projects/Embedding Sync.md",
        evidence: { lexical: false, vector: true },
      }),
    );

    const doctor = await readSemanticDoctor({ vault: tmpVault, storage: "qmd-sqlite" });
    expect(doctor).toEqual(
      expect.objectContaining({
        available: true,
        storage: "qmd-sqlite",
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "better-sqlite3 FTS5", status: "pass" }),
          expect.objectContaining({ name: "sqlite-vec vector extension", status: "pass" }),
          expect.objectContaining({ name: "node-llama-cpp runtime", status: "pass" }),
          expect.objectContaining({ name: "GGUF embedding model", status: "warn" }),
        ]),
      }),
    );
  });
});
