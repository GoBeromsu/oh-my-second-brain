import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openEngineStore, openEngineStoreCore } from "./store.js";
import type { EngineStore } from "./store.js";
import { createHashProjectionProvider } from "./hash-stub.test-helper.js";

const DIMS = 64;
let dir: string;
let store: EngineStore;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oms-store-test-"));
  store = openEngineStore(path.join(dir, "test.db"), DIMS);
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function makeRow(docPath: string, ordinal: number, text: string) {
  const provider = createHashProjectionProvider(DIMS);
  const vector = await provider.embed(text);
  await provider.dispose();
  return {
    docPath,
    ordinal,
    text,
    headingPath: [] as string[],
    sha: "aabbcc",
    vector,
  };
}

function makeLexRow(docPath: string, text: string) {
  return {
    docPath,
    ordinal: 0,
    text,
    headingPath: [] as string[],
    sha: docPath,
  };
}

describe("openEngineStore — upsert + queryLex", () => {
  it("upserts rows without throwing", async () => {
    const rows = [
      await makeRow("notes/alpha.md", 0, "retrieval augmented generation"),
      await makeRow("notes/beta.md", 0, "graph neural network embedding"),
    ];
    expect(() => store.upsert(rows)).not.toThrow();
  });

  it("queryLex returns hits for a matching term", () => {
    const hits = store.queryLex("retrieval augmented", 5);
    const paths = hits.map((h) => h.docPath);
    expect(paths).toContain("notes/alpha.md");
  });

  it("queryLex returns empty for unmatched query", () => {
    const hits = store.queryLex("xyzzy_unmatched_term_12345", 5);
    expect(hits).toEqual([]);
  });

  it("queryLex hits have decreasing scores (rank-based)", () => {
    const hits = store.queryLex("retrieval", 5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("upsert on same docPath+ordinal updates without duplicate", async () => {
    const row = await makeRow("notes/gamma.md", 0, "first version");
    store.upsert([row]);
    const updated = await makeRow("notes/gamma.md", 0, "updated content knowledge graph");
    store.upsert([updated]);

    // Should find updated term, not old one
    const hits = store.queryLex("knowledge graph", 5);
    const paths = hits.map((h) => h.docPath);
    expect(paths).toContain("notes/gamma.md");
  });
});

describe("openEngineStore — queryVec", () => {
  it("queryVec returns an array (may be empty if sqlite-vec unavailable)", async () => {
    const provider = createHashProjectionProvider(DIMS);
    const vec = await provider.embed("retrieval graph embedding");
    await provider.dispose();
    const hits = store.queryVec(vec, 5);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("queryVec scores are in (0, 1] range", async () => {
    const provider = createHashProjectionProvider(DIMS);
    const vec = await provider.embed("retrieval augmented generation");
    await provider.dispose();
    const hits = store.queryVec(vec, 5);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });
});

describe.each([
  ["vector-capable store", (dbPath: string) => openEngineStore(dbPath, DIMS)],
  ["core-only store", (dbPath: string) => openEngineStoreCore(dbPath)],
])("collection-scoped lexical search (%s)", (_mode, openStore) => {
  let collectionDir: string;
  let collectionStore: EngineStore;

  beforeAll(() => {
    collectionDir = mkdtempSync(path.join(tmpdir(), "oms-store-collection-test-"));
    collectionStore = openStore(path.join(collectionDir, "test.db"));
  });

  afterAll(() => {
    collectionStore.close();
    rmSync(collectionDir, { recursive: true, force: true });
  });

  it("does not treat an underscore in a collection name as a wildcard", () => {
    collectionStore.upsertLex([
      makeLexRow("my_notes/kept.md", "collection underscore literal token"),
      makeLexRow("myXnotes/leaked.md", "collection underscore literal token"),
    ]);

    expect(collectionStore.queryLex("collection underscore literal", 10, "my_notes").map((hit) => hit.docPath))
      .toEqual(["my_notes/kept.md"]);
  });

  it("does not treat a percent sign in a collection name as a wildcard", () => {
    collectionStore.upsertLex([
      makeLexRow("my%notes/kept.md", "collection percent literal token"),
      makeLexRow("myZZnotes/leaked.md", "collection percent literal token"),
    ]);

    expect(collectionStore.queryLex("collection percent literal", 10, "my%notes").map((hit) => hit.docPath))
      .toEqual(["my%notes/kept.md"]);
  });

  it("keeps overlapping collection names separate while including descendants", () => {
    collectionStore.upsertLex([
      makeLexRow("notes/root.md", "collection overlap literal token"),
      makeLexRow("notes/sub/child.md", "collection overlap literal token"),
      makeLexRow("notes-archive/leaked.md", "collection overlap literal token"),
    ]);

    expect(collectionStore.queryLex("collection overlap literal", 10, "notes").map((hit) => hit.docPath).sort())
      .toEqual(["notes/root.md", "notes/sub/child.md"]);
    expect(collectionStore.queryLex("collection overlap literal", 10, "notes/sub").map((hit) => hit.docPath))
      .toEqual(["notes/sub/child.md"]);
  });

  it("returns documents from an ordinary collection", () => {
    collectionStore.upsertLex([
      makeLexRow("ordinary/document.md", "collection ordinary literal token"),
    ]);

    expect(collectionStore.queryLex("collection ordinary literal", 10, "ordinary").map((hit) => hit.docPath))
      .toEqual(["ordinary/document.md"]);
  });
});

// ---------------------------------------------------------------------------
// EngineStore extensions: getShas + clearDocument
// ---------------------------------------------------------------------------

describe("openEngineStore — getShas + clearDocument", () => {
  it("getShas returns empty Map for an unknown document", () => {
    const shas = store.getShas("notes/nonexistent.md");
    expect(shas.size).toBe(0);
  });

  it("getShas returns ordinal→sha map after upsert", async () => {
    const row = await makeRow("notes/sha-test.md", 0, "sha test content");
    const customRow = { ...row, sha: "deadbeef01234567" };
    store.upsert([customRow]);
    const shas = store.getShas("notes/sha-test.md");
    expect(shas.get(0)).toBe("deadbeef01234567");
  });

  it("getShas returns all ordinals for multi-chunk document", async () => {
    const rows = [
      { ...(await makeRow("notes/multi.md", 0, "first chunk")), sha: "sha-chunk-0" },
      { ...(await makeRow("notes/multi.md", 1, "second chunk")), sha: "sha-chunk-1" },
    ];
    store.upsert(rows);
    const shas = store.getShas("notes/multi.md");
    expect(shas.get(0)).toBe("sha-chunk-0");
    expect(shas.get(1)).toBe("sha-chunk-1");
    expect(shas.size).toBe(2);
  });

  it("clearDocument removes all chunks and getShas returns empty", async () => {
    const row = await makeRow("notes/to-clear.md", 0, "content to clear");
    store.upsert([row]);
    expect(store.getShas("notes/to-clear.md").size).toBe(1);

    store.clearDocument("notes/to-clear.md");

    expect(store.getShas("notes/to-clear.md").size).toBe(0);
    // Lexical index should also be gone
    const hits = store.queryLex("content to clear", 5);
    const paths = hits.map((h) => h.docPath);
    expect(paths).not.toContain("notes/to-clear.md");
  });

  it("clearDocument on unknown document does not throw", () => {
    expect(() => store.clearDocument("notes/ghost.md")).not.toThrow();
  });
});
