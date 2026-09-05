import { afterAll, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openEngineStoreCore,
  openEngineStoreCoreReadOnly,
  openEngineStoreReadOnly,
  type EngineStore,
} from "./store.js";
import { createEngineStoreReadSnapshot } from "./read-snapshot.js";

const roots: string[] = [];
const SNAPSHOT_PREFIX = "oms-engine-read-";

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oms-store-ro-"));
  roots.push(root);
  return root;
}

function directoryImage(root: string): ReadonlyArray<readonly [string, string]> {
  if (!existsSync(root)) return [];
  const image: Array<readonly [string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isDirectory()) {
        image.push([`${relative}/`, "directory"]);
        visit(filename);
      } else {
        image.push([relative, readFileSync(filename).toString("base64")]);
      }
    }
  };
  visit(root);
  return image.sort(([left], [right]) => left.localeCompare(right));
}

function snapshotDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(SNAPSHOT_PREFIX)).sort();
}

const readonlyOpeners: ReadonlyArray<readonly [string, (dbPath: string) => EngineStore | null]> = [
  ["core", openEngineStoreCoreReadOnly],
  ["vector", (dbPath) => openEngineStoreReadOnly(dbPath, 8)],
];

describe("read-only engine store", () => {
  it("creates no source or snapshot files when the store is absent", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");
    const snapshotsBefore = snapshotDirectories();

    expect(openEngineStoreCoreReadOnly(dbPath)).toBeNull();

    expect(directoryImage(root)).toEqual([]);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });

  it("rejects a foreign database without changing it and cleans its snapshot", () => {
    const root = scratch();
    const dir = path.join(root, ".oms");
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "engine-store.sqlite");
    const foreign = new Database(dbPath);
    foreign.exec("CREATE TABLE unrelated (a TEXT);");
    foreign.close();
    const sourceBefore = directoryImage(root);
    const snapshotsBefore = snapshotDirectories();

    expect(() => openEngineStoreCoreReadOnly(dbPath)).toThrow(/corrupt or incompatible/i);

    expect(directoryImage(root)).toEqual(sourceBefore);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });

  it("fails loudly when WAL metadata changes during every capture boundary", () => {
    const root = scratch();
    const dbPath = path.join(root, "direct.sqlite");
    writeFileSync(dbPath, "main");
    writeFileSync(`${dbPath}-wal`, "wal");
    const snapshotsBefore = snapshotDirectories();
    let mutations = 0;

    expect(() => createEngineStoreReadSnapshot(dbPath, {
      afterRead: (filename) => {
        if (filename === `${dbPath}-wal`) {
          appendFileSync(filename, Buffer.from([mutations]));
          mutations += 1;
        }
      },
    })).toThrow(/changed while capturing/i);

    expect(mutations).toBeGreaterThanOrEqual(3);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });

  it("rejects a TMPDIR inside the source vault before creating anything", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");
    const writable = openEngineStoreCore(dbPath);
    writable.close();
    const inside = path.join(root, "tmp");
    mkdirSync(inside);
    const sourceBefore = directoryImage(root);
    const previousTmpdir = process.env.TMPDIR;

    try {
      process.env.TMPDIR = inside;
      expect(() => openEngineStoreCoreReadOnly(dbPath)).toThrow(
        /temporary directory .* is inside source vault/i,
      );
      expect(directoryImage(root)).toEqual(sourceBefore);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  describe.each(readonlyOpeners)("%s opener", (_name, openReadOnly) => {
    it("does not change any source directory byte while a closed store is open or after close", () => {
      const root = scratch();
      const dbPath = path.join(root, ".oms", "engine-store.sqlite");
      const writable = openEngineStoreCore(dbPath);
      writable.upsertLex([
        { docPath: "notes/alpha.md", ordinal: 0, text: "alpha mentions retrieval", sha: "sha-alpha" },
      ]);
      writable.close();
      const sourceBefore = directoryImage(root);
      const snapshotsBefore = snapshotDirectories();

      const store = openReadOnly(dbPath);
      expect(store).not.toBeNull();
      expect(store!.queryLex("retrieval", 5)).toHaveLength(1);
      expect(directoryImage(root)).toEqual(sourceBefore);
      expect(snapshotDirectories()).not.toEqual(snapshotsBefore);

      store!.close();
      expect(directoryImage(root)).toEqual(sourceBefore);
      expect(snapshotDirectories()).toEqual(snapshotsBefore);
    });

    it("reads WAL-only committed content without changing the active writer tree", () => {
      const root = scratch();
      const dbPath = path.join(root, ".oms", "engine-store.sqlite");
      const writable = openEngineStoreCore(dbPath);
      const mainBeforeWrite = readFileSync(dbPath);
      writable.upsertLex([
        { docPath: "notes/wal.md", ordinal: 0, text: "committed wal sentinel", sha: "sha-wal" },
      ]);
      expect(readFileSync(dbPath)).toEqual(mainBeforeWrite);
      expect(readFileSync(`${dbPath}-wal`).byteLength).toBeGreaterThan(0);
      const sourceBefore = directoryImage(root);
      const snapshotsBefore = snapshotDirectories();

      const store = openReadOnly(dbPath);
      expect(store).not.toBeNull();
      expect(store!.queryLex("sentinel", 5).map((hit) => hit.docPath)).toEqual(["notes/wal.md"]);
      expect(directoryImage(root)).toEqual(sourceBefore);

      store!.close();
      expect(directoryImage(root)).toEqual(sourceBefore);
      expect(snapshotDirectories()).toEqual(snapshotsBefore);
      writable.close();
    });
  });

  it("rejects every mutation on an existing store", () => {
    const root = scratch();
    const dbPath = path.join(root, ".oms", "engine-store.sqlite");
    const writable = openEngineStoreCore(dbPath);
    writable.upsertLex([
      { docPath: "notes/alpha.md", ordinal: 0, text: "alpha", sha: "sha-alpha" },
    ]);
    writable.close();

    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      expect(() => store.upsertLex([
        { docPath: "notes/beta.md", ordinal: 0, text: "beta", sha: "sha-beta" },
      ])).toThrow(/reading only/i);
      expect(() => store.clearDocument("notes/alpha.md")).toThrow(/reading only/i);
      expect(() => store.writeEmbeddingIdentity({
        provider: "gguf",
        model: "fake",
        dimensions: 8,
        fingerprint: "fp",
      })).toThrow(/reading only/i);
    } finally {
      store.close();
    }
  });
});
