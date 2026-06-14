import { afterEach, describe, expect, it } from "vitest";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSemanticStatus, syncSemanticEmbeddingStore } from "./semantic.js";
import { writeSemanticFixtureVault } from "./semantic-test-fixtures.js";

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("OMS native semantic provider status", () => {
  it("reports missing native index without requiring a qmd binary", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const status = await readSemanticStatus({ vault: tmpVault });

    expect(status).toEqual({
      available: false,
      reason: expect.stringContaining("OMS SQLite semantic store not found"),
    });
  });

  it("syncs markdown into a native OMS index and reports storage freshness", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const sync = await syncSemanticEmbeddingStore({
      vault: tmpVault,
      collection: "obsidian",
      ensureCollection: true,
      force: true,
    });

    expect(sync.available).toBe(true);
    if (!sync.available) throw new Error(sync.reason);
    expect(sync.storage).toBe("qmd-sqlite");
    expect(sync.collection).toBe("obsidian");
    expect(sync.status.index?.path).toBe(path.join(tmpVault, ".oms", "semantic-store.sqlite"));
    expect(sync.status.index?.documents).toEqual(expect.objectContaining({ total: 3, vectors: 3, pending: 0 }));
    expect(sync.steps.map((step) => step.name)).toEqual(["scan", "write-index", "status"]);

    await expect(stat(path.join(tmpVault, ".oms", "semantic-store.sqlite"))).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }));
  });

  it("rejects semantic index writes outside the vault", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const absolute = await syncSemanticEmbeddingStore({
      vault: tmpVault,
      index: path.join(tmpdir(), "oms-outside-index.json"),
    });
    expect(absolute).toEqual(
      expect.objectContaining({
        available: false,
        reason: expect.stringContaining("relative to the vault"),
      }),
    );

    const escaped = await syncSemanticEmbeddingStore({ vault: tmpVault, index: "../outside-index.json" });
    expect(escaped).toEqual(
      expect.objectContaining({
        available: false,
        reason: expect.stringContaining("stay inside the vault"),
      }),
    );
  });

  it("accepts qmd-style sync batch controls with the SQLite backend", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const result = await syncSemanticEmbeddingStore({
      vault: tmpVault,
      collection: "obsidian",
      pull: true,
      maxDocsPerBatch: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({
        available: true,
        storage: "qmd-sqlite",
      }),
    );
    expect(result.steps.map((step) => step.name)).toEqual(["pull", "scan", "write-index", "status"]);
  });
});
