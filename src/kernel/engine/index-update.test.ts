import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncEngineStore, type EngineSyncResult } from "./embed/sync.js";
import { completeDirtyDrain, listDirtyQueue, prepareDirtyDrain, updateKeywordIndex } from "./index-update.js";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function vaultWithStore(notes: Record<string, string>, withStore = true): Promise<{ vault: string; dbPath: string }> {
  const vault = await tempDir("oms-index-update-vault-");
  const dbPath = path.join(await tempDir("oms-index-update-store-"), "engine.sqlite");
  for (const [relPath, content] of Object.entries(notes)) {
    await mkdir(path.dirname(path.join(vault, relPath)), { recursive: true });
    await writeFile(path.join(vault, relPath), content);
  }
  if (withStore) {
    const result = await syncEngineStore({ vault, dbPath, embed: false });
    expect(result.available).toBe(true);
  }
  return { vault, dbPath };
}

function shas(dbPath: string, docPath: string): string[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return (database.prepare("SELECT sha FROM engine_chunk_meta WHERE doc_path = ?").all(docPath) as { sha: string }[]).map(row => row.sha);
  } finally {
    database.close();
  }
}

function clearDirty(dbPath: string, docPath: string): void {
  const database = new Database(dbPath);
  try {
    database.prepare("UPDATE engine_chunk_meta SET sha = substr(sha, 7) WHERE doc_path = ? AND sha LIKE 'dirty:%'").run(docPath);
  } finally {
    database.close();
  }
}

function removeDoc(dbPath: string, docPath: string): void {
  const database = new Database(dbPath);
  try {
    database.prepare("DELETE FROM engine_chunk_meta WHERE doc_path = ?").run(docPath);
  } finally {
    database.close();
  }
}

function syncResult(overrides: Partial<EngineSyncResult>): EngineSyncResult {
  return { available: true, collection: "vault", dbPath: "", scanned: 1, added: 0, updated: 1, skipped: 0, ...overrides };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("updateKeywordIndex", () => {
  it("skips a vault without an engine store and never creates one", async () => {
    const { vault, dbPath } = await vaultWithStore({ "a.md": "# A\n" }, false);
    const sync = vi.fn(syncEngineStore);
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { sync })).toBe("skipped");
    expect(sync).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(false);
    expect(await readdir(path.dirname(dbPath))).toEqual([]);
  });

  it("fails on a store path inside the vault", async () => {
    const { vault } = await vaultWithStore({ "a.md": "# A\n" }, false);
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath: path.join(vault, "engine.sqlite") })).toBe("failed");
  });

  it("replaces the note's keyword rows and queues its vectors", async () => {
    const { vault, dbPath } = await vaultWithStore({ "a.md": "# A\nfirst\n", "b.md": "# B\n" });
    await writeFile(path.join(vault, "a.md"), "# A\nzeppelinword\n");
    const now = () => new Date("2026-09-28T00:00:00Z");
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { now })).toBe("updated");
    expect(listDirtyQueue(dbPath)).toEqual(["a.md"]);
    expect(shas(dbPath, "a.md").every(sha => sha.startsWith("dirty:"))).toBe(true);
    expect(shas(dbPath, "b.md").some(sha => sha.startsWith("dirty:"))).toBe(false);
    const database = new Database(dbPath, { readonly: true });
    try {
      const hit = database.prepare("SELECT COUNT(*) AS count FROM engine_chunk_meta WHERE doc_path = 'a.md' AND text LIKE '%zeppelinword%'").get() as { count: number } | undefined;
      expect(hit?.count ?? 0).toBeGreaterThan(0);
    } finally {
      database.close();
    }
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { now })).toBe("updated");
    expect(shas(dbPath, "a.md").every(sha => sha.startsWith("dirty:") && !sha.startsWith("dirty:dirty:"))).toBe(true);
  });

  it("skips a note the sync did not scan", async () => {
    const { vault, dbPath } = await vaultWithStore({ "a.md": "# A\n" });
    const sync = vi.fn(async () => syncResult({ scanned: 0 }));
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { sync })).toBe("skipped");
    expect(listDirtyQueue(dbPath)).toEqual([]);
  });

  it("fails when the store is unavailable or the sync throws", async () => {
    const { vault, dbPath } = await vaultWithStore({ "a.md": "# A\n" });
    const unavailable = vi.fn(async () => syncResult({ available: false }));
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { sync: unavailable })).toBe("failed");
    const throws = vi.fn(async (): Promise<EngineSyncResult> => { throw new Error("locked"); });
    expect(await updateKeywordIndex({ vault, relPath: "a.md", dbPath }, { sync: throws })).toBe("failed");
    expect(listDirtyQueue(dbPath)).toEqual([]);
  });

  it("uses the default external store path when none is given", async () => {
    const { vault } = await vaultWithStore({ "a.md": "# A\n" }, false);
    const exists = vi.fn(() => false);
    expect(await updateKeywordIndex({ vault, relPath: "a.md" }, { exists })).toBe("skipped");
    expect(exists).toHaveBeenCalledWith(expect.stringContaining(path.join("oms", "vaults")));
  });
});

describe("dirty queue drain", () => {
  it("is empty for a missing store or a store without a queue", async () => {
    const { dbPath } = await vaultWithStore({ "a.md": "# A\n" });
    const missing = path.join(path.dirname(dbPath), "none.sqlite");
    expect(listDirtyQueue(missing)).toEqual([]);
    expect(prepareDirtyDrain(missing)).toEqual([]);
    expect(completeDirtyDrain(missing)).toEqual({ drained: [], pending: [] });
    expect(listDirtyQueue(dbPath)).toEqual([]);
    expect(prepareDirtyDrain(dbPath)).toEqual([]);
    expect(completeDirtyDrain(dbPath)).toEqual({ drained: [], pending: [] });
  });

  it("re-marks queued notes a lexical sync cleared and dequeues only re-embedded or removed ones", async () => {
    const { vault, dbPath } = await vaultWithStore({ "a.md": "# A\n", "b.md": "# B\n", "c.md": "# C\n" });
    for (const [relPath, at] of [["a.md", 1], ["b.md", 2], ["c.md", 3]] as const) {
      expect(await updateKeywordIndex({ vault, relPath, dbPath }, { now: () => new Date(at * 1000) })).toBe("updated");
    }
    clearDirty(dbPath, "a.md");
    expect(prepareDirtyDrain(dbPath)).toEqual(["a.md", "b.md", "c.md"]);
    expect(shas(dbPath, "a.md").every(sha => sha.startsWith("dirty:"))).toBe(true);

    clearDirty(dbPath, "a.md");
    removeDoc(dbPath, "c.md");
    expect(completeDirtyDrain(dbPath)).toEqual({ drained: ["a.md", "c.md"], pending: ["b.md"] });
    expect(listDirtyQueue(dbPath)).toEqual(["b.md"]);
  });
});
