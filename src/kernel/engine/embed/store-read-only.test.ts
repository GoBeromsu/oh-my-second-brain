/**
 * Write protection for the read-only engine store.
 *
 * The read-only opener deliberately uses a WRITABLE SQLite connection with
 * `fileMustExist: true` rather than SQLite's `readonly: true`. The reason is in
 * `openExistingCoreStore`: a read-only connection to a WAL database needs the
 * `-shm` sidecar, creates it, and then cannot remove it on close, so every
 * search left files behind in the user's vault.
 *
 * That trade means SQLite is no longer the thing stopping a write. These tests
 * cover the guarantee that replaced it: the store refuses to create anything
 * that is not already there, and every mutator on the returned handle throws.
 * If someone later "simplifies" a mutator into a real statement, this fails.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openEngineStoreCore,
  openEngineStoreCoreReadOnly,
} from "./store.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oms-store-ro-"));
  roots.push(root);
  return root;
}

describe("read-only engine store", () => {
  it("creates nothing when the store is absent", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");

    expect(openEngineStoreCoreReadOnly(dbPath)).toBeNull();

    // Not just the database: the enclosing directory must not be conjured
    // either. Creating `.oms/` on a read is the original defect.
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports an existing but foreign database as absent instead of adopting it", () => {
    const root = scratch();
    const dir = path.join(root, ".oms");
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "engine-store.sqlite");

    // A real SQLite database that is not ours: it exists, it opens, and it has
    // none of the engine tables. The opener must decline it rather than adopt
    // it, and must not try to add the missing schema to someone else's file.
    const foreign = new Database(dbPath);
    foreign.exec("CREATE TABLE unrelated (a TEXT);");
    foreign.close();
    const before = readdirSync(dir).sort();

    expect(openEngineStoreCoreReadOnly(dbPath)).toBeNull();
    expect(readdirSync(dir).sort()).toEqual(before);

    // Declining must be about the schema, not about the path: a genuine store
    // at the same location still opens.
    const real = openEngineStoreCore(path.join(dir, "real.sqlite"));
    real.close();
    const opened = openEngineStoreCoreReadOnly(path.join(dir, "real.sqlite"));
    expect(opened).not.toBeNull();
    // Close it: an open connection legitimately holds `-shm`/`-wal` on disk.
    opened!.close();
  });

  it("rejects every mutation on a store that does exist", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");

    // Build a real store through the creating path, then reopen it read-only.
    const writable = openEngineStoreCore(dbPath);
    writable.upsertLex([
      { docPath: "notes/alpha.md", ordinal: 0, text: "alpha mentions retrieval", sha: "sha-alpha" },
    ]);
    writable.close();

    const store = openEngineStoreCoreReadOnly(dbPath);
    expect(store).not.toBeNull();

    try {
      // Reads still work, otherwise this proves nothing about writes.
      expect(store!.queryLex("retrieval", 5).length).toBeGreaterThan(0);

      expect(() =>
        store!.upsertLex([
          { docPath: "notes/beta.md", ordinal: 0, text: "beta", sha: "sha-beta" },
        ]),
      ).toThrow(/reading only/i);
      expect(() => store!.clearDocument("notes/alpha.md")).toThrow(/reading only/i);
      expect(() =>
        store!.writeEmbeddingIdentity({
          provider: "gguf",
          model: "fake",
          dimensions: 8,
          fingerprint: "fp",
        }),
      ).toThrow(/reading only/i);
    } finally {
      store!.close();
    }

    // The rejected writes must not have landed by another route.
    const reopened = openEngineStoreCoreReadOnly(dbPath);
    try {
      expect(reopened!.listDocPaths()).toEqual(["notes/alpha.md"]);
    } finally {
      reopened!.close();
    }
  });

  it("leaves no WAL sidecars behind after a read", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");

    const writable = openEngineStoreCore(dbPath);
    writable.upsertLex([
      { docPath: "notes/alpha.md", ordinal: 0, text: "alpha", sha: "sha-alpha" },
    ]);
    writable.close();

    const before = readdirSync(path.join(root, ".oms")).sort();

    const store = openEngineStoreCoreReadOnly(dbPath);
    store!.queryLex("alpha", 5);
    store!.close();

    // This is the concrete reason `readonly: true` was rejected. A read-only
    // connection creates `-shm`/`-wal` and cannot clean them up; if someone
    // reintroduces it, these appear here.
    expect(readdirSync(path.join(root, ".oms")).sort()).toEqual(before);
  });
});
