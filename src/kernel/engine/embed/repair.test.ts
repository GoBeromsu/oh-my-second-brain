import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { engineStorePath } from "../paths.js";
import { ENGINE_EMBED_META_VERSION, openEngineStoreCoreReadOnly } from "./store.js";
import { repairEngineStore } from "./repair.js";
import { syncEngineStore } from "./sync.js";

const roots: string[] = [];

async function makeVault(): Promise<string> {
  const root = await (async () => {
    const directory = path.join(tmpdir(), `oms-repair-${crypto.randomUUID()}`);
    await mkdir(path.join(directory, ".oms"), { recursive: true });
    roots.push(directory);
    await writeFile(path.join(directory, "note.md"), "# Note\n", "utf8");
    await writeFile(path.join(directory, ".oms", "taxonomy.json"), "{}\n", "utf8");
    await writeFile(path.join(directory, ".oms", "template-policy.json"), '{"templates":{}}\n', "utf8");
    await writeFile(path.join(directory, ".oms", "types.json"), "{}\n", "utf8");
    await writeFile(path.join(directory, ".oms", "models.json"), "{}\n", "utf8");
    return directory;
  })();
  return root;
}

async function authorityHashes(vault: string): Promise<Map<string, string>> {
  const files = [
    "note.md",
    ".oms/taxonomy.json",
    ".oms/template-policy.json",
    ".oms/types.json",
    ".oms/models.json",
  ];
  return new Map(await Promise.all(files.map(async (file) => [
    file,
    createHash("sha256").update(await readFile(path.join(vault, file))).digest("hex"),
  ] as const)));
}

function legacyStore(vault: string, kind: "missing-tables" | "missing-meta-column" | "normal"): void {
  const db = new Database(engineStorePath(vault));
  try {
    if (kind === "missing-tables") {
      db.exec("CREATE TABLE engine_meta (id INTEGER PRIMARY KEY);");
    } else if (kind === "missing-meta-column") {
      db.exec(`
        CREATE TABLE engine_meta (id INTEGER PRIMARY KEY, embedding_schema_version TEXT NOT NULL);
        INSERT INTO engine_meta (id, embedding_schema_version) VALUES (1, '${ENGINE_EMBED_META_VERSION}');
        CREATE TABLE engine_chunk_meta (id INTEGER PRIMARY KEY);
        CREATE VIRTUAL TABLE engine_chunk_fts USING fts5(text);
      `);
    } else {
      db.exec(`
        CREATE TABLE engine_meta (
          id INTEGER PRIMARY KEY,
          embedding_provider TEXT,
          embedding_model TEXT,
          embedding_revision TEXT,
          embedding_sha256 TEXT,
          embedding_dimensions INTEGER,
          embedding_context_length INTEGER,
          embedding_mrl_dim INTEGER,
          embedding_normalization TEXT,
          embedding_prefix_scheme TEXT,
          embedding_fingerprint TEXT,
          embedding_schema_version TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO engine_meta (id, embedding_schema_version, updated_at)
        VALUES (1, '${ENGINE_EMBED_META_VERSION}', '2020-01-01T00:00:00.000Z');
        CREATE TABLE engine_chunk_meta (rowid INTEGER PRIMARY KEY, doc_path TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, sha TEXT NOT NULL);
        CREATE VIRTUAL TABLE engine_chunk_fts USING fts5(doc_path UNINDEXED, ordinal UNINDEXED, text);
      `);
    }
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repairEngineStore", () => {
  it.each(["missing-tables", "missing-meta-column", "normal"] as const)(
    "%s dry-run is non-mutating and rebuild preserves vault authority",
    async (kind) => {
      const vault = await makeVault();
      legacyStore(vault, kind);
      const before = await authorityHashes(vault);
      const storePath = engineStorePath(vault);

      const dryRun = repairEngineStore({
        vault,
        mode: "rebuild",
        dryRun: true,
        now: () => new Date("2026-09-01T10:00:00.000Z"),
      });
      expect(dryRun).toMatchObject({
        storePath,
        backupPath: `${storePath}.backup-20260901T100000000Z`,
        reindexRequired: true,
        dryRun: true,
      });
      await expect(stat(storePath)).resolves.toBeDefined();
      expect(await authorityHashes(vault)).toEqual(before);

      const rebuilt = repairEngineStore({
        vault,
        mode: "rebuild",
        now: () => new Date("2026-09-01T10:00:00.000Z"),
      });
      expect(rebuilt.backupPath).not.toBeNull();
      await expect(stat(rebuilt.backupPath!)).resolves.toBeDefined();
      const store = openEngineStoreCoreReadOnly(storePath);
      expect(store).not.toBeNull();
      store?.close();
      const db = new Database(storePath, { readonly: true });
      try {
        expect(db.prepare("SELECT embedding_schema_version FROM engine_meta WHERE id = 1").get())
          .toEqual({ embedding_schema_version: ENGINE_EMBED_META_VERSION });
      } finally {
        db.close();
      }
      await syncEngineStore({ vault, embed: false });
      const reindexed = openEngineStoreCoreReadOnly(storePath);
      expect(reindexed?.listDocPaths()).toEqual(["note.md"]);
      reindexed?.close();
      expect(await authorityHashes(vault)).toEqual(before);
    },
  );

  it("drop moves the store aside without creating a replacement or touching vault authority", async () => {
    const vault = await makeVault();
    legacyStore(vault, "normal");
    const before = await authorityHashes(vault);
    const storePath = engineStorePath(vault);
    await Promise.all([
      writeFile(`${storePath}-wal`, "wal"),
      writeFile(`${storePath}-shm`, "shm"),
    ]);
    const result = repairEngineStore({
      vault,
      mode: "drop",
      now: () => new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({ reindexRequired: true, dryRun: false });
    await expect(stat(result.backupPath!)).resolves.toBeDefined();
    await expect(stat(`${result.backupPath!}-wal`)).resolves.toBeDefined();
    await expect(stat(`${result.backupPath!}-shm`)).resolves.toBeDefined();
    await expect(stat(storePath)).rejects.toThrow();
    await expect(stat(`${storePath}-wal`)).rejects.toThrow();
    await expect(stat(`${storePath}-shm`)).rejects.toThrow();
    expect(openEngineStoreCoreReadOnly(storePath)).toBeNull();
    expect(await authorityHashes(vault)).toEqual(before);
  });

  it("does not overwrite a prior backup with the same timestamp", async () => {
    const vault = await makeVault();
    const storePath = engineStorePath(vault);
    legacyStore(vault, "normal");
    const now = () => new Date("2026-09-01T10:00:00.000Z");

    const first = repairEngineStore({ vault, mode: "rebuild", now });
    const firstBackup = await readFile(first.backupPath!);
    const second = repairEngineStore({ vault, mode: "drop", now });

    expect(second.backupPath).toBe(`${first.backupPath!}-1`);
    expect(await readFile(first.backupPath!)).toEqual(firstBackup);
    await expect(stat(second.backupPath!)).resolves.toBeDefined();
    await expect(stat(storePath)).rejects.toThrow();
  });

  it("preserves orphan SQLite sidecars and removes them from the source paths", async () => {
    const vault = await makeVault();
    const storePath = engineStorePath(vault);
    await Promise.all([
      writeFile(`${storePath}-wal`, "orphan wal"),
      writeFile(`${storePath}-shm`, "orphan shm"),
    ]);

    const result = repairEngineStore({
      vault,
      mode: "drop",
      now: () => new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(result.backupPath).not.toBeNull();
    await expect(stat(`${result.backupPath!}-wal`)).resolves.toBeDefined();
    await expect(stat(`${result.backupPath!}-shm`)).resolves.toBeDefined();
    await expect(stat(`${storePath}-wal`)).rejects.toThrow();
    await expect(stat(`${storePath}-shm`)).rejects.toThrow();
  });
});
