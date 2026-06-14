import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  getSemanticDocument,
  multiGetSemanticDocuments,
  querySemanticStore,
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

describe("OMS native semantic query and document retrieval", () => {
  it("runs hybrid, lexical, and vector searches over the native index", async () => {
    tmpVault = await writeSemanticFixtureVault();
    await syncSemanticEmbeddingStore({ vault: tmpVault, collection: "obsidian" });

    const hybrid = await querySemanticStore({
      vault: tmpVault,
      collection: "obsidian",
      query: "agent retrieval memory",
      intent: "find the OMS retrieve note",
      lex: "agent retrieval",
      vec: "semantic memory evidence",
      hyde: "A note explains how retrieval combines graph and semantic memory.",
      limit: 2,
      minScore: 0.01,
    });
    expect(hybrid.available).toBe(true);
    if (!hybrid.available) throw new Error(hybrid.reason);
    expect(hybrid.hits[0]).toEqual(
      expect.objectContaining({
        path: "references/Agent Retrieval.md",
        title: "Agent Retrieval",
        uri: expect.stringMatching(/^oms:\/\/obsidian\//u),
        evidence: { lexical: true, vector: true },
      }),
    );
    expect(hybrid.hits[0]?.score).toBeGreaterThan(0);

    const lexical = await querySemanticStore({
      vault: tmpVault,
      collection: "obsidian",
      query: "wikilink neighborhoods",
      mode: "search",
      limit: 1,
    });
    expect(lexical.available).toBe(true);
    if (!lexical.available) throw new Error(lexical.reason);
    expect(lexical.hits[0]).toEqual(
      expect.objectContaining({
        path: "references/Graph Index.md",
        evidence: { lexical: true, vector: false },
      }),
    );

    const vector = await querySemanticStore({
      vault: tmpVault,
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
  });

  it("retrieves single and multiple documents by docid, path, and glob target", async () => {
    tmpVault = await writeSemanticFixtureVault();
    await syncSemanticEmbeddingStore({ vault: tmpVault, collection: "obsidian" });
    const result = await querySemanticStore({ vault: tmpVault, collection: "obsidian", query: "agent retrieval", limit: 1 });
    if (!result.available) throw new Error(result.reason);
    const docid = result.hits[0]?.docid;
    if (!docid) throw new Error("Expected a semantic docid.");

    const single = await getSemanticDocument({
      vault: tmpVault,
      collection: "obsidian",
      target: `${docid}:6:3`,
      lineNumbers: true,
    });
    expect(single).toEqual({
      available: true,
      documents: [
        expect.objectContaining({
          target: `${docid}:6:3`,
          path: "references/Agent Retrieval.md",
          docid,
          title: "Agent Retrieval",
          content: expect.stringContaining("6: # Agent Retrieval"),
        }),
      ],
    });

    const byPath = await getSemanticDocument({ vault: tmpVault, target: "projects/Embedding Sync.md", lineNumbers: false });
    expect(byPath.available).toBe(true);
    if (!byPath.available) throw new Error(byPath.reason);
    expect(byPath.documents[0]?.content).toContain("Embedding sync refreshes");

    const batch = await multiGetSemanticDocuments({
      vault: tmpVault,
      collection: "obsidian",
      targets: ["references/*.md", docid],
      lineLimit: 2,
      maxBytes: 600,
      lineNumbers: true,
    });
    expect(batch.available).toBe(true);
    if (!batch.available) throw new Error(batch.reason);
    expect(batch.documents.map((document) => document.path)).toEqual([
      "references/Agent Retrieval.md",
      "references/Graph Index.md",
    ]);
    expect(batch.documents[0]?.content).toContain("1: ---");

    const recursiveBatch = await multiGetSemanticDocuments({ vault: tmpVault, collection: "obsidian", targets: ["**/*.md"], lineLimit: 1 });
    expect(recursiveBatch.available).toBe(true);
    if (!recursiveBatch.available) throw new Error(recursiveBatch.reason);
    expect(recursiveBatch.documents.map((document) => document.path)).toEqual([
      "projects/Embedding Sync.md",
      "references/Agent Retrieval.md",
      "references/Graph Index.md",
    ]);
  });
});
