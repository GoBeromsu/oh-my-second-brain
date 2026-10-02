import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as stores from "./store.js";
import * as source from "./source.js";
import { chunkDocument } from "./chunker.js";
import { LiveLexicalSession } from "./live-lexical.js";
import { indexSourcesUnchanged, verifyIndexSources } from "./freshness.js";
import { syncEngineStore } from "./sync.js";
import { listDirtyQueue, updateKeywordIndex } from "../index-update.js";
import type { EmbeddingProvider } from "../types.js";

vi.mock("./store.js", async importOriginal => {
  const original = await importOriginal<typeof import("./store.js")>();
  return { ...original, openDetachedLexicalStore: vi.fn(original.openDetachedLexicalStore) };
});
vi.mock("./source.js", async importOriginal => {
  const original = await importOriginal<typeof import("./source.js")>();
  return { ...original, readDocumentSource: vi.fn(original.readDocumentSource) };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statSync: vi.fn(original.statSync) };
});

let root: string;
let vault: string;
let dbPath: string;
const sessions: LiveLexicalSession[] = [];
const OLD = "# Alpha\noldkeyword\n";
const NEW = "# Alpha\nnewkeyword\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-live-generation-"));
  vault = path.join(root, "vault");
  dbPath = path.join(root, "engine.sqlite");
  await mkdir(vault);
  await writeFile(path.join(vault, "alpha.md"), OLD);
  await writeFile(path.join(vault, "beta.md"), "# Beta\noldkeyword oldkeyword\n");
  expect(await syncEngineStore({ vault, dbPath, embed: false })).toMatchObject({ available: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function session(options: { maxMemoryBytes?: number; maxProjectionBytes?: number } = {}) {
  const selected = new LiveLexicalSession({ vault, dbPath, ...options });
  sessions.push(selected);
  return selected;
}
async function query(selected: LiveLexicalSession, term = "oldkeyword") {
  const prepared = await selected.prepare(vault, [term], 20);
  expect(await indexSourcesUnchanged(prepared.snapshot)).toBe(true);
  return prepared.store.queryLex(term, 20);
}
async function persistentImage() {
  const image: Array<[string, string]> = [];
  async function visit(name: string): Promise<void> {
    if ((await stat(path.join(root, name))).isDirectory()) {
      image.push([`${name}/`, ""]);
      for (const child of (await readdir(path.join(root, name))).sort()) await visit(path.join(name, child));
    } else image.push([name, (await readFile(path.join(root, name))).toString("base64")]);
  }
  for (const name of (await readdir(root)).filter(name => name.startsWith("engine.sqlite")).sort()) await visit(name);
  return image;
}
async function embed(model = "test.gguf", force = false) {
  const provider: EmbeddingProvider = {
    model: "test:offline", dimensions: 4,
    embed: async () => new Float32Array([1, 0, 0, 0]), dispose: async () => undefined,
  };
  const result = await syncEngineStore({
    vault, dbPath, embed: true, force, embeddingProvider: "gguf", embeddingModel: model,
    embeddingRevision: "v1", embeddingSha256: "a".repeat(64), embeddingDimensions: 4,
    embeddingContext: 2048, embeddingMrlDim: 0, embeddingNormalization: "l2",
    embeddingPrefixScheme: "embeddinggemma-v1", embeddingProviderInstance: provider,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ available: true });
}

describe("complete private lexical corpora across persistent maintenance", () => {
  it.each([{}, { maxMemoryBytes: 1, maxProjectionBytes: 0 }])("keeps managed writes incremental with storage options %j", async options => {
    const selected = session(options);
    await query(selected);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    expect(await updateKeywordIndex({ vault, dbPath, relPath: "alpha.md" })).toBe("updated");
    expect(listDirtyQueue(dbPath)).toEqual(["alpha.md"]);
    const before = await persistentImage();
    vi.mocked(source.readDocumentSource).mockClear();
    expect((await query(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    expect((await query(selected)).map(hit => hit.docPath)).toEqual(["beta.md"]);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(vi.mocked(source.readDocumentSource).mock.calls.map(call => call[1])).toEqual(["alpha.md"]);
    expect(await persistentImage()).toEqual(before);
    expect(listDirtyQueue(dbPath)).toEqual(["alpha.md"]);
  });

  it("keeps native ranking and reads no bodies after vector synchronization and forced rebuild", async () => {
    await embed("test.gguf", true);
    const selected = session();
    const expected = await query(selected);
    await embed();
    vi.mocked(source.readDocumentSource).mockClear();
    expect(await query(selected)).toEqual(expected);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    await embed("replacement.gguf", true);
    const before = await persistentImage();
    vi.mocked(source.readDocumentSource).mockClear();
    expect(await query(selected)).toEqual(expected);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(await persistentImage()).toEqual(before);
  });

  it.each(["remove", "replace", "schema", "corrupt"])("keeps the captured corpus after persistent %s", async change => {
    const selected = session();
    const expected = await query(selected);
    if (change === "remove") await rm(dbPath);
    if (change === "replace") {
      await rename(dbPath, `${dbPath}.backup`);
      const writer = stores.openEngineStoreCore(dbPath);
      writer.upsertLex(chunkDocument("ghost.md", "# Ghost\nghostkeyword\n"));
      writer.close();
    }
    if (change === "schema") {
      const db = new Database(dbPath);
      db.exec("DROP TABLE engine_document_source");
      db.close();
    }
    if (change === "corrupt") await writeFile(dbPath, "not a database");
    const before = await persistentImage();
    vi.mocked(source.readDocumentSource).mockClear();
    expect(await query(selected)).toEqual(expected);
    expect(await query(selected, "ghostkeyword")).toEqual([]);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(await persistentImage()).toEqual(before);
  });

  it("does not reseed when an index appears after an absent-index bootstrap", async () => {
    await rm(dbPath);
    const absentImage = await persistentImage();
    const selected = session();
    const expected = await query(selected);
    expect(await persistentImage()).toEqual(absentImage);
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await syncEngineStore({ vault, dbPath, embed: false });
    const before = await persistentImage();
    vi.mocked(source.readDocumentSource).mockClear();
    expect(await query(selected)).toEqual(expected);
    expect(source.readDocumentSource).not.toHaveBeenCalled();
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(await persistentImage()).toEqual(before);
  });

  it("refreshes edit, delete, rename and recreate after persistent removal", async () => {
    const selected = session();
    await query(selected);
    await rm(dbPath);
    const absentImage = await persistentImage();
    const filename = path.join(vault, "alpha.md");
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    await query(selected);
    const before = await stat(filename, { bigint: true });
    await writeFile(filename, NEW);
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    const after = await stat(filename, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect((await query(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    await rename(filename, path.join(vault, "renamed.md"));
    expect((await query(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["renamed.md"]);
    await rm(path.join(vault, "renamed.md"));
    expect(await query(selected, "newkeyword")).toEqual([]);
    await writeFile(filename, NEW);
    expect((await query(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
    expect(await persistentImage()).toEqual(absentImage);
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps incomplete and failed captures on generation-checked bootstrap", async () => {
    const selected = session();
    vi.mocked(source.readDocumentSource).mockRejectedValueOnce(new Error("incomplete capture"));
    await expect(selected.prepare(vault, ["oldkeyword"], 20)).rejects.toThrow("incomplete capture");
    await rm(dbPath);
    expect(await query(selected)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    vi.mocked(source.readDocumentSource).mockRejectedValueOnce(new Error("later capture failed"));
    await expect(selected.prepare(vault, ["newkeyword"], 20)).rejects.toThrow("later capture failed");
    await syncEngineStore({ vault, dbPath, embed: false });
    expect(await query(selected, "newkeyword")).toHaveLength(1);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(3);
  });

  it("retries a failed seed without treating it as a complete corpus", async () => {
    const selected = session();
    vi.mocked(stores.openDetachedLexicalStore).mockImplementationOnce(() => { throw new Error("seed failed"); });
    await expect(selected.prepare(vault, ["oldkeyword"], 20)).rejects.toThrow("seed failed");
    expect(selected.retainedStorage().bytes).toBe(0);
    expect(await query(selected)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
  });

  it.each(["schema", "chunker"])("does not promote an unsupported bootstrap %s", async kind => {
    const db = new Database(dbPath);
    if (kind === "schema") db.exec("UPDATE engine_document_source SET version = 99");
    else db.exec("UPDATE engine_document_source SET chunker = ''");
    db.close();
    const selected = session();
    await expect(selected.prepare(vault, ["oldkeyword"], 20)).rejects.toThrow(/invalid or unsupported/u);
    await rm(dbPath);
    expect(await query(selected)).toHaveLength(2);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
  });

  it("falls back to generation checks when the vault identity is unavailable", async () => {
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    const spy = vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof original.statSync>) => {
      const result = original.statSync(...args);
      return args[0] === vault ? Object.assign(result, { ino: 0n }) : result;
    });
    try {
      const selected = session();
      await query(selected);
      await rm(dbPath);
      expect(await query(selected)).toHaveLength(2);
      expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });

  it("reseeds when a vault is replaced at the same pathname", async () => {
    const selected = session();
    await query(selected);
    await rename(vault, `${vault}.backup`);
    await mkdir(vault);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    expect(await query(selected)).toEqual([]);
    expect((await query(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
  });

  it("rejects a vault identity change during capture and retries conservatively", async () => {
    const selected = session();
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readSource = await vi.importActual<typeof import("./source.js")>("./source.js");
    let changed = false;
    const spy = vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof original.statSync>) => {
      const result = original.statSync(...args);
      return changed && args[0] === vault ? Object.assign(result, { ino: BigInt(result.ino) + 1n }) : result;
    });
    vi.mocked(source.readDocumentSource).mockImplementationOnce(async (...args) => {
      const captured = await readSource.readDocumentSource(...args);
      changed = true;
      return captured;
    });
    try {
      await expect(selected.prepare(vault, ["oldkeyword"], 20)).rejects.toThrow(/vault identity changed/u);
      expect(await query(selected)).toHaveLength(2);
      expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });

  it("retains confinement checks after a warm database path is redirected inside the vault", async () => {
    const selected = session();
    await query(selected);
    const forbidden = path.join(vault, "forbidden.sqlite");
    await rename(dbPath, forbidden);
    await symlink(forbidden, dbPath);
    const before = await readFile(forbidden);
    await expect(selected.prepare(vault, ["oldkeyword"], 20)).rejects.toThrow(/inside the vault/u);
    expect(await readFile(forbidden)).toEqual(before);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
  });

  it("rejects a capture from a different canonical root even when the configured alias is restored", async () => {
    const originalVault = vault;
    const otherVault = path.join(root, "other-vault");
    await mkdir(otherVault);
    await writeFile(path.join(otherVault, "different.md"), "wrongvaultkeyword");
    vault = path.join(root, "vault-alias");
    await symlink(originalVault, vault);
    const selected = session();
    await query(selected);
    // Switch only after seed's root check, then restore after the other root's
    // captured bytes. The ordinary final snapshot check alone sees a stable
    // other root, so completion also has to bind it to the configured vault.
    const internal = selected as unknown as { seed(): string | undefined };
    const seed = internal.seed.bind(selected);
    vi.spyOn(internal, "seed").mockImplementationOnce(() => {
      const identity = seed();
      fs.unlinkSync(vault);
      fs.symlinkSync(otherVault, vault);
      return identity;
    });
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    vi.mocked(source.readDocumentSource).mockImplementationOnce(async (...args) => {
      const captured = await original.readDocumentSource(...args);
      await rm(vault);
      await symlink(originalVault, vault);
      return captured;
    });
    await expect(selected.prepare(vault, ["wrongvaultkeyword"], 20)).rejects.toThrow(/vault identity changed/u);
    expect(await query(selected, "wrongvaultkeyword")).toEqual([]);
    expect(await query(selected)).toHaveLength(2);
  });

  it("joins concurrent warm prepares without a maintenance-triggered seed", async () => {
    const selected = session();
    await query(selected);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    await updateKeywordIndex({ vault, dbPath, relPath: "alpha.md" });
    vi.mocked(source.readDocumentSource).mockClear();
    const [fresh, previous] = await Promise.all([
      selected.prepare(vault, ["newkeyword"], 20), selected.prepare(vault, ["oldkeyword"], 20),
    ]);
    expect(fresh.store.queryLex("newkeyword", 20).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    expect(previous.store.queryLex("oldkeyword", 20).map(hit => hit.docPath)).toEqual(["beta.md"]);
    expect(await indexSourcesUnchanged(fresh.snapshot)).toBe(true);
    expect(fresh.snapshot).toBe(previous.snapshot);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    expect(stores.openDetachedLexicalStore).toHaveBeenCalledTimes(1);
  });

  it("never certifies or changes stale persistent/vector source evidence", async () => {
    await embed("test.gguf", true);
    const selected = session();
    await query(selected);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    const before = await persistentImage();
    const fresh = await selected.prepare(vault, ["newkeyword"], 20);
    expect(fresh.store.queryLex("newkeyword", 20)).toHaveLength(1);
    expect(await indexSourcesUnchanged(fresh.snapshot)).toBe(true);
    expect(() => fresh.store.queryVec(new Float32Array(4), 20)).toThrow(/cannot/u);
    expect(selected.store.readEmbeddingIdentity()).toBeNull();
    const persistent = stores.openEngineStoreCoreReadOnly(dbPath)!;
    try {
      expect(await verifyIndexSources(persistent, vault)).toMatchObject({ available: false, reason: expect.stringContaining("INDEX_SOURCE_DRIFT") });
      expect(persistent.readEmbeddingIdentity()).not.toBeNull();
    } finally { persistent.close(); }
    expect(await persistentImage()).toEqual(before);
  });
});
