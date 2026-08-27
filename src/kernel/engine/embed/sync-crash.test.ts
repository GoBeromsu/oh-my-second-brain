import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeEmbeddingIdentity } from "./identity.js";
import { openEngineStore } from "./store.js";
import { syncEngineStore } from "./sync.js";

vi.mock("./provider.js", () => ({
  requireRealEmbeddingProvider: ({ model }: { model: string }) => ({
    model: `stub:${model}`,
    dimensions: 3,
    contextLength: 128,
    mrlDim: 3,
    normalization: "l2",
    prefixScheme: "none",
    async embed(text: string): Promise<Float32Array> {
      return new Float32Array([text.length, 1, 0]);
    },
    async dispose(): Promise<void> {},
  }),
}));

let vault: string;
let dbPath: string;

function writeDoc(content: string): void {
  mkdirSync(path.join(vault, "notes"), { recursive: true });
  writeFileSync(path.join(vault, "notes", "topic.md"), content, "utf8");
}

async function seed(model: string, content: string): Promise<void> {
  writeDoc(content);
  const result = await syncEngineStore({
    vault,
    dbPath,
    embeddingProvider: "stub",
    embeddingModel: model,
  });
  expect(result.available).toBe(true);
}

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), "oms-sync-crash-vault-"));
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "oms-sync-crash-db-")), "engine-store.sqlite");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("generation swap crash boundaries", () => {
  for (const crashPoint of ["after-build", "after-validation", "before-swap"] as const) {
    it(`preserves the old generation at ${crashPoint}`, async () => {
      await seed("old", "# Topic\nlegacy marker");
      writeDoc("# Topic\nfresh marker");

      const result = await syncEngineStore({
        vault,
        dbPath,
        force: true,
        embeddingProvider: "stub",
        embeddingModel: "new",
        crashPoint,
      });
      expect(result.available).toBe(false);

      const active = openEngineStore(dbPath, 3);
      try {
        expect(active.readEmbeddingIdentity()?.model).toBe("old");
        expect(active.queryLex("legacy", 5)).not.toHaveLength(0);
        expect(active.queryLex("fresh", 5)).toHaveLength(0);
      } finally {
        active.close();
      }
    });
  }

  it("exposes the complete new generation after a post-swap crash", async () => {
    await seed("old", "# Topic\nlegacy marker");
    writeDoc("# Topic\nfresh marker");

    const result = await syncEngineStore({
      vault,
      dbPath,
      force: true,
      embeddingProvider: "stub",
      embeddingModel: "new",
      crashPoint: "after-swap",
    });
    expect(result.available).toBe(false);

    const active = openEngineStore(dbPath, 3);
    try {
      expect(active.readEmbeddingIdentity()?.model).toBe("new");
      expect(active.queryLex("fresh", 5)).not.toHaveLength(0);
      expect(active.queryLex("legacy", 5)).toHaveLength(0);
    } finally {
      active.close();
    }
  });

  it("closes active sidecars before swapping and rebinds a long-lived handle", async () => {
    await seed("old", "# Topic\nlegacy marker");
    writeDoc("# Topic\nfresh marker");

    const active = openEngineStore(dbPath, 3);
    active.queryLex("legacy", 5);
    let rebound: ReturnType<typeof openEngineStore> | undefined;
    let activeClosed = false;
    try {
      const result = await syncEngineStore({
        vault,
        dbPath,
        force: true,
        embeddingProvider: "stub",
        embeddingModel: "new",
        onGenerationSwapPrepare: () => {
          activeClosed = true;
          active.close();
        },
        onGenerationSwapComplete: () => {
          if (activeClosed) rebound = openEngineStore(dbPath, 3);
        },
      });

      expect(result.available).toBe(true);
      expect(result.generationSwapped).toBe(true);
      expect(rebound?.readEmbeddingIdentity()?.model).toBe("new");
      expect(rebound?.queryLex("fresh", 5)).not.toHaveLength(0);
    } finally {
      rebound?.close();
      if (!activeClosed) active.close();
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("generation writer lock", () => {
  it("rejects a concurrent writer and recovers after a stale owner", async () => {
    await seed("old", "# Topic\nlegacy marker");
    const lockPath = `${dbPath}.lock`;
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");

    const blocked = await syncEngineStore({
      vault,
      dbPath,
      embeddingProvider: "stub",
      embeddingModel: "new",
    });
    expect(blocked.available).toBe(false);
    expect(blocked.reason).toMatch(/already in progress|lock/i);

    // A dead owner must not strand all future syncs.
    writeFileSync(lockPath, "999999999\n", "utf8");
    const recovered = await syncEngineStore({
      vault,
      dbPath,
      embeddingProvider: "stub",
      embeddingModel: "old",
    });
    expect(recovered.available).toBe(true);
  });

  it("admits only one writer when concurrent syncs clean a stale lock", async () => {
    await seed("old", "# Topic\nlegacy marker");
    writeFileSync(`${dbPath}.lock`, "999999999\n", "utf8");

    const results = await Promise.all([
      syncEngineStore({
        vault,
        dbPath,
        embeddingProvider: "stub",
        embeddingModel: "old",
      }),
      syncEngineStore({
        vault,
        dbPath,
        embeddingProvider: "stub",
        embeddingModel: "old",
      }),
    ]);

    expect(results.filter((result) => result.available)).toHaveLength(1);
    expect(results.filter((result) => !result.available).map((result) => result.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/already in progress|lock/i)]),
    );
  });

  it("never closes a caller-owned handle when force reindex is rejected", async () => {
    await seed("old", "# Topic\nlegacy marker");
    const callerStore = openEngineStore(dbPath, 3);
    const close = vi.spyOn(callerStore, "close");
    try {
      const result = await syncEngineStore({
        vault,
        dbPath,
        store: callerStore,
        force: true,
        embeddingProvider: "stub",
        embeddingModel: "new",
      });
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/caller-owned|internally-owned/i);
      expect(close).not.toHaveBeenCalled();
    } finally {
      callerStore.close();
    }
  });
});

it("removes stale vectors when lex-only sync changes chunk text", async () => {
  const oldText = "# Topic\nlegacy marker";
  await seed("old", oldText);

  const before = openEngineStore(dbPath, 3);
  try {
    expect(before.queryVec(new Float32Array([oldText.length, 1, 0]), 5)).not.toHaveLength(0);
  } finally {
    before.close();
  }

  writeDoc("# Topic\nfresh marker");
  const lexical = await syncEngineStore({ vault, dbPath, embed: false });
  expect(lexical.available).toBe(true);
  expect(lexical.updated).toBeGreaterThan(0);

  const after = openEngineStore(dbPath, 3);
  try {
    expect(after.queryLex("fresh", 5).map((hit) => hit.docPath)).toContain("notes/topic.md");
    expect(after.queryVec(new Float32Array([oldText.length, 1, 0]), 5)).toHaveLength(0);
  } finally {
    after.close();
  }
});

it("removes stale vectors when a vector-capable store receives lexical metadata", () => {
  const oldText = "# Topic\nlegacy marker";
  const updatedText = "# Topic\nfresh marker";
  const store = openEngineStore(dbPath, 3);
  try {
    store.upsert([{
      docPath: "notes/topic.md",
      ordinal: 0,
      text: oldText,
      headingPath: ["Topic"],
      sha: "old",
      vector: new Float32Array([oldText.length, 1, 0]),
    }]);
    expect(store.queryVec(new Float32Array([oldText.length, 1, 0]), 5)).not.toHaveLength(0);

    store.upsertLex([{
      docPath: "notes/topic.md",
      ordinal: 0,
      text: updatedText,
      headingPath: ["Topic"],
      sha: "new",
    }]);
    expect(store.queryLex("fresh", 5).map((hit) => hit.docPath)).toContain("notes/topic.md");
    expect(store.queryVec(new Float32Array([oldText.length, 1, 0]), 5)).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("keeps the identity fingerprint in the old generation until swap", async () => {
  const old = makeEmbeddingIdentity({
    provider: "stub",
    model: "old",
    dimensions: 3,
    contextLength: 128,
    mrlDim: 3,
    normalization: "l2",
    prefixScheme: "none",
  });
  await seed("old", "# Topic\nlegacy marker");
  const active = openEngineStore(dbPath, 3);
  try {
    expect(active.readEmbeddingIdentity()?.fingerprint).toBe(old.fingerprint);
  } finally {
    active.close();
  }
});
