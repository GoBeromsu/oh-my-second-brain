import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openEngineStoreCore, openEngineStoreCoreReadOnly } from "./store.js";
import { syncEngineStore } from "./sync.js";
import { chunkDocument } from "./chunker.js";
import { documentSourceMatches, documentSourceMissing, readDocumentSource } from "./source.js";
import { indexSourcesUnchanged, verifyIndexSources } from "./freshness.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile), open: vi.fn(original.open) };
});

let directory: string;
let vault: string;
let dbPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oms-source-"));
  vault = await mkdtemp(path.join(tmpdir(), "oms-source-vault-"));
  dbPath = path.join(directory, "store.sqlite");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(vault, { recursive: true, force: true });
});

describe("indexed source evidence", () => {
  it("records stable source evidence for every synced note, including empty notes", async () => {
    await writeFile(path.join(vault, "alpha.md"), "# Alpha\noriginalkeyword\n");
    await writeFile(path.join(vault, "empty.md"), "");
    expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      const sources = store.readDocumentSources();
      expect([...sources!.keys()].sort()).toEqual(["alpha.md", "empty.md"]);
      expect(sources!.get("alpha.md")).toMatchObject({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    } finally { store.close(); }
  });

  it("invalidates source evidence when chunks change outside sync", async () => {
    await writeFile(path.join(vault, "alpha.md"), "# Alpha\noriginalkeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false });
    const store = openEngineStoreCore(dbPath);
    try {
      expect(store.readDocumentSources()!.has("alpha.md")).toBe(true);
      store.upsertLex(chunkDocument("alpha.md", "# Alpha\notherkeyword\n"));
      expect(store.readDocumentSources()!.has("alpha.md")).toBe(false);
    } finally { store.close(); }
  });

  it("refuses to certify a document if another writer changed its chunks", async () => {
    const original = "# Alpha\noriginalkeyword\n";
    await writeFile(path.join(vault, "alpha.md"), original);
    await syncEngineStore({ vault, dbPath, embed: false });
    const store = openEngineStoreCore(dbPath);
    try {
      const source = store.readDocumentSources()!.get("alpha.md")!;
      store.upsertLex(chunkDocument("alpha.md", "# Alpha\notherkeyword\n"));
      expect(() => store.recordDocumentSource("alpha.md", source, chunkDocument("alpha.md", original)))
        .toThrow(/changed before source evidence/u);
      expect(store.readDocumentSources()!.has("alpha.md")).toBe(false);
    } finally { store.close(); }
  });

  it("reads legacy stores as unverified without creating a source table", async () => {
    const created = openEngineStoreCore(dbPath);
    created.close();
    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE IF EXISTS engine_document_source");
    legacy.close();
    const before = await readFile(dbPath);
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      expect(store.readDocumentSources()).toBeNull();
      expect(store.readDocumentSource!("alpha.md")).toBeNull();
      expect(() => store.recordDocumentSource("alpha.md", { fingerprint: "a".repeat(64), contentSha256: "b".repeat(64), chunker: "default" }, []))
        .toThrow(/reading only/u);
    } finally { store.close(); }
    expect(await readFile(dbPath)).toEqual(before);
  });

  it.each(["file", "directory"])("rejects an explicit %s symlink that whole-vault lexical scans omit", async kind => {
    await mkdir(path.join(vault, "notes"));
    await writeFile(path.join(vault, "notes", "alpha.md"), "# Alpha\noriginalkeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false });
    const before = openEngineStoreCoreReadOnly(dbPath)!;
    const originalSources = before.readDocumentSources();
    before.close();
    if (kind === "file") await symlink(path.join(vault, "notes", "alpha.md"), path.join(vault, "alias.md"));
    else await symlink(path.join(vault, "notes"), path.join(vault, "alias"));
    const result = await syncEngineStore({
      vault, dbPath, embed: false,
      ...(kind === "file" ? { files: ["alias.md"] } : { collectionPath: "alias" }),
    });
    expect(result).toMatchObject({ available: false, reason: expect.stringMatching(/symbolic links/u) });
    const after = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      expect(after.listDocPaths()).toEqual(["notes/alpha.md"]);
      expect(after.readDocumentSources()).toEqual(originalSources);
    } finally { after.close(); }
  });

  it("rejects a source that changes during the exact byte read", async () => {
    const filename = path.join(vault, "alpha.md");
    await writeFile(filename, "# Alpha\noriginalkeyword\n");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original.open(...args);
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs: Parameters<typeof handle.readFile>) => {
        const bytes = await read(...readArgs);
        await writeFile(filename, "# Alpha\nchangedkeyword\n");
        return bytes;
      };
      return handle;
    });
    await expect(readDocumentSource(vault, "alpha.md")).rejects.toThrow(/changed while being read/u);
  });

  it("keeps custom chunker settings and clears evidence with its document", async () => {
    await writeFile(path.join(vault, "alpha.md"), "# Alpha\noriginalkeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false, chunkerOpts: { maxTokens: 30, overlapRatio: 0 } });
    const store = openEngineStoreCore(dbPath);
    try {
      expect(JSON.parse(store.readDocumentSources()!.get("alpha.md")!.chunker)).toEqual({ version: 1, maxTokens: 30, overlapRatio: 0 });
      store.clearDocument("alpha.md");
      expect(store.readDocumentSources()!.has("alpha.md")).toBe(false);
    } finally { store.close(); }
  });

  it("rejects a parent-directory swap restored around the file open", async () => {
    await mkdir(path.join(vault, "notes"));
    await mkdir(path.join(vault, ".replacement"));
    await writeFile(path.join(vault, "notes", "alpha.md"), "originalkeyword");
    await writeFile(path.join(vault, ".replacement", "alpha.md"), "differentkeyword");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args: Parameters<typeof fsPromises.open>) => {
      await rename(path.join(vault, "notes"), path.join(vault, ".holding"));
      await rename(path.join(vault, ".replacement"), path.join(vault, "notes"));
      const handle = await original.open(...args);
      await rename(path.join(vault, "notes"), path.join(vault, ".replacement"));
      await rename(path.join(vault, ".holding"), path.join(vault, "notes"));
      return handle;
    });
    await expect(readDocumentSource(vault, "notes/alpha.md")).rejects.toThrow(/changed while being read/u);
    expect(await readFile(path.join(vault, "notes", "alpha.md"), "utf8")).toBe("originalkeyword");
  });

  it("does not treat malformed source evidence as a fresh store", async () => {
    await writeFile(path.join(vault, "alpha.md"), "# Alpha\noriginalkeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false });
    const db = new Database(dbPath);
    db.exec("UPDATE engine_document_source SET version = 999");
    db.close();
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try { expect(() => store.readDocumentSources()).toThrow(/invalid or unsupported/u); }
    finally { store.close(); }
  });

  it("validates commit witnesses with weak-byte fallback and refuses missing, escaped or non-file sources", async () => {
    const filename = path.join(vault, "alpha.md");
    await writeFile(filename, "originalkeyword");
    const { source } = await readDocumentSource(vault, "alpha.md");
    expect(documentSourceMatches(vault, "alpha.md", source)).toBe(true);
    expect(documentSourceMatches(vault, "alpha.md", { ...source, fingerprint: null })).toBe(true);
    await writeFile(filename, "modifiedkeyword");
    expect(documentSourceMatches(vault, "alpha.md", source)).toBe(false);
    expect(documentSourceMatches(vault, "alpha.md", { ...source, fingerprint: null })).toBe(false);
    await symlink(filename, path.join(vault, "alias.md"));
    expect(documentSourceMatches(vault, "alias.md", source)).toBe(false);
    expect(documentSourceMatches(vault, path.relative(vault, directory), source)).toBe(false);
    await mkdir(path.join(vault, "folder.md"));
    expect(documentSourceMatches(vault, "folder.md", source)).toBe(false);
    await rm(filename);
    expect(documentSourceMatches(vault, "alpha.md", source)).toBe(false);
    expect(documentSourceMissing(vault, "alpha.md")).toBe(true);
  });

  it("keeps handle-weak/path-strong sources usable through byte verification", async () => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original.open(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = async (...options: Parameters<typeof handle.stat>) => {
        const info = await originalStat(...options);
        if (typeof info.size === "bigint") Reflect.deleteProperty(info, "mtimeNs");
        return info;
      };
      return handle;
    });
    try {
      const filename = path.join(vault, "alpha.md");
      await writeFile(filename, "originalkeyword");
      expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
      const store = openEngineStoreCoreReadOnly(dbPath)!;
      try {
        expect(store.readDocumentSources()!.get("alpha.md")!.fingerprint).toBeNull();
        const verified = await verifyIndexSources(store, vault);
        expect(verified.available).toBe(true);
        if (!verified.available) return;
        expect(await indexSourcesUnchanged(verified.snapshot)).toBe(true);
        await writeFile(filename, "modifiedkeyword");
        expect(await indexSourcesUnchanged(verified.snapshot)).toBe(false);
        expect(await verifyIndexSources(store, vault)).toMatchObject({ available: false });
      } finally { store.close(); }
    } finally { vi.mocked(fsPromises.open).mockImplementation(original.open); }
  });
});
