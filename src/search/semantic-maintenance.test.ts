import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  addSemanticContext,
  cleanupSemanticStore,
  initSemanticStore,
  listSemanticCollections,
  querySemanticStore,
  readSemanticDoctor,
  removeSemanticCollection,
  renameSemanticCollection,
  semanticIndexPath,
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

describe("OMS native semantic maintenance", () => {
  it("supports qmd-style query documents plus collection and context metadata natively", async () => {
    tmpVault = await writeSemanticFixtureVault();
    await syncSemanticEmbeddingStore({
      vault: tmpVault,
      collection: "references",
      collectionPath: "references",
      pattern: "**/*.md",
      includeByDefault: false,
      updateCommand: "git pull --ff-only",
    });
    await addSemanticContext({
      vault: tmpVault,
      collection: "references",
      pathPrefix: "references",
      context: "Human context: retrieval affordance notes should be preferred for agent workflows.",
    });

    expect(await listSemanticCollections({ vault: tmpVault })).toEqual({
      available: true,
      collections: [
        expect.objectContaining({
          name: "references",
          path: "references",
          pattern: "**/*.md",
          includeByDefault: false,
          updateCommand: "git pull --ff-only",
          documents: 2,
        }),
      ],
    });

    const query = await querySemanticStore({
      vault: tmpVault,
      collection: "references",
      query: [
        "intent: retrieve qmd-compatible semantic notes",
        "lex: agent retr",
        "vec: semantic memory evidence",
        "hyde: A note explains retrieval affordances for agent workflows.",
      ].join("\n"),
      limit: 1,
    });

    expect(query.available).toBe(true);
    if (!query.available) throw new Error(query.reason);
    expect(query.hits[0]).toEqual(
      expect.objectContaining({
        path: "references/Agent Retrieval.md",
        context: expect.stringContaining("Human context"),
        evidence: { lexical: true, vector: true },
      }),
    );
  });

  it("renames, removes, diagnoses, and cleans native collections without qmd", async () => {
    tmpVault = await writeSemanticFixtureVault();
    await syncSemanticEmbeddingStore({ vault: tmpVault, collection: "refs", collectionPath: "references" });

    const renamed = await renameSemanticCollection({ vault: tmpVault, from: "refs", to: "library" });
    expect(renamed).toEqual(expect.objectContaining({ available: true, renamed: true }));
    expect(await listSemanticCollections({ vault: tmpVault })).toEqual(
      expect.objectContaining({
        collections: [expect.objectContaining({ name: "library", documents: 2 })],
      }),
    );

    await rm(path.join(tmpVault, "references", "Graph Index.md"));
    const cleanup = await cleanupSemanticStore({ vault: tmpVault });
    expect(cleanup).toEqual(expect.objectContaining({ available: true, removedDocuments: 1 }));

    const doctor = await readSemanticDoctor({ vault: tmpVault });
    expect(doctor).toEqual(
      expect.objectContaining({
        available: true,
        storage: "qmd-sqlite",
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "better-sqlite3 FTS5", status: "pass" }),
          expect.objectContaining({ name: "sqlite-vec vector extension", status: "pass" }),
          expect.objectContaining({ name: "node-llama-cpp runtime", status: "pass" }),
          expect.objectContaining({ name: "native index", status: "pass" }),
        ]),
      }),
    );

    const removed = await removeSemanticCollection({ vault: tmpVault, collection: "library" });
    expect(removed).toEqual(expect.objectContaining({ available: true, removed: true }));
    expect(await listSemanticCollections({ vault: tmpVault })).toEqual({ available: true, collections: [] });
  });

  it("initializes the JSON fallback with JSON compatibility metadata", async () => {
    tmpVault = await writeSemanticFixtureVault();

    const initialized = await initSemanticStore({ vault: tmpVault, storage: "oms-native-json" });
    expect(initialized).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));

    const raw = JSON.parse(await readFile(semanticIndexPath({ vault: tmpVault, storage: "oms-native-json" }), "utf-8"));
    expect(raw.qmdCompatibility).toEqual(
      expect.objectContaining({
        storage: "metadata-compatible",
        unsupportedInternals: expect.arrayContaining(["sqlite-vec vector extension"]),
      }),
    );
  });
});
