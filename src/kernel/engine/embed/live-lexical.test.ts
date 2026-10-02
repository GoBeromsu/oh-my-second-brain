import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as source from "./source.js";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { LiveLexicalSession } from "./live-lexical.js";
import { assembleLiveLexicalEngine } from "../assemble.js";
import { openEngineStoreCore, openEngineStoreCoreReadOnly } from "./store.js";
import { chunkDocument } from "./chunker.js";
import { syncEngineStore } from "./sync.js";
import { readSearchTemplateSource } from "../retrieval/template-source.js";
import { indexSourcesUnchanged } from "./freshness.js";

vi.mock("./source.js", async importOriginal => {
  const original = await importOriginal<typeof import("./source.js")>();
  return { ...original, readDocumentSource: vi.fn(original.readDocumentSource) };
});

let root: string;
let vault: string;
let dbPath: string;
const sessions: LiveLexicalSession[] = [];
const OLD = "# Alpha\noldkeyword\n";
const NEW = "# Alpha\nnewkeyword\n";
beforeEach(async () => {
  const original = await vi.importActual<typeof import("./source.js")>("./source.js");
  vi.mocked(source.readDocumentSource).mockImplementation(original.readDocumentSource);
  root = await mkdtemp(path.join(tmpdir(), "oms-live-lex-test-"));
  vault = path.join(root, "vault");
  dbPath = path.join(root, "engine.sqlite");
  await mkdir(vault);
  await writeFile(path.join(vault, "alpha.md"), OLD);
  expect(await syncEngineStore({ vault, dbPath, embed: false })).toMatchObject({ available: true });
  vi.mocked(source.readDocumentSource).mockClear();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function session(maxMemoryBytes?: number) {
  const created = new LiveLexicalSession({ vault, dbPath, maxMemoryBytes });
  sessions.push(created);
  return created;
}
async function hits(selected: LiveLexicalSession, query: string, k = Number.MAX_SAFE_INTEGER, collection?: string) {
  const prepared = await selected.prepare(vault, [query], k, collection);
  expect(await indexSourcesUnchanged(prepared.snapshot)).toBe(true);
  return prepared.store.queryLex(query, k, collection);
}
async function persistentImage() {
  const names = (await readdir(root)).filter(name => name.startsWith("engine.sqlite"));
  const image: Array<[string, string]> = [];
  async function visit(name: string): Promise<void> {
    if ((await stat(path.join(root, name))).isDirectory()) {
      image.push([`${name}/`, ""]);
      for (const child of (await readdir(path.join(root, name))).sort()) await visit(path.join(name, child));
    } else image.push([name, (await readFile(path.join(root, name))).toString("base64")]);
  }
  for (const name of names.sort()) await visit(name);
  return image;
}

describe("live detached native lexical sessions", () => {
  it("matches native ranking/text and reuses witnessed note bodies on warm reads", async () => {
    await writeFile(path.join(vault, "beta.md"), "# Beta\noldkeyword oldkeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false });
    vi.mocked(source.readDocumentSource).mockClear();
    const selected = session();
    const original = openEngineStoreCoreReadOnly(dbPath)!;
    try { expect(await hits(selected, "oldkeyword")).toEqual(original.queryLex("oldkeyword", Number.MAX_SAFE_INTEGER)); }
    finally { original.close(); }
    vi.mocked(source.readDocumentSource).mockClear();
    await hits(selected, "oldkeyword");
    expect(source.readDocumentSource).not.toHaveBeenCalled();
  });

  it("refreshes an unsynced same-size restored-mtime edit without modifying persistent state", async () => {
    const selected = session();
    await hits(selected, "oldkeyword");
    const before = await persistentImage();
    const filename = path.join(vault, "alpha.md");
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    await hits(selected, "oldkeyword");
    vi.mocked(source.readDocumentSource).mockClear();
    const stamp = await stat(filename, { bigint: true });
    await writeFile(filename, NEW);
    await utimes(filename, 1700000000.123456, 1700000000.123456);
    const changed = await stat(filename, { bigint: true });
    expect(changed.size).toBe(stamp.size);
    expect(changed.mtimeNs).toBe(stamp.mtimeNs);
    expect(changed.ctimeNs).not.toBe(stamp.ctimeNs);
    expect((await hits(selected, "newkeyword")).map(hit => hit.docPath)).toEqual(["alpha.md"]);
    expect(await hits(selected, "oldkeyword")).toEqual([]);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    expect(await persistentImage()).toEqual(before);
  });

  it.each(["new", "delete", "rename", "replace", "empty"])("refreshes %s files without explicit sync", async change => {
    const selected = session();
    await hits(selected, "oldkeyword");
    const filename = path.join(vault, "alpha.md");
    if (change === "new") await writeFile(path.join(vault, "beta.md"), NEW);
    if (change === "delete") await rm(filename);
    if (change === "rename") await rename(filename, path.join(vault, "renamed.md"));
    if (change === "replace") {
      await writeFile(path.join(vault, "temporary.txt"), NEW);
      await rename(path.join(vault, "temporary.txt"), filename);
    }
    if (change === "empty") await writeFile(filename, "");
    const oldPaths = (await hits(selected, "oldkeyword")).map(hit => hit.docPath);
    expect(oldPaths).toEqual(change === "new" ? ["alpha.md"] : change === "rename" ? ["renamed.md"] : []);
    const newPaths = (await hits(selected, "newkeyword")).map(hit => hit.docPath);
    expect(newPaths).toEqual(change === "new" ? ["beta.md"] : change === "replace" ? ["alpha.md"] : []);
  });

  it("removes newly excluded notes and restores them when live template settings change", async () => {
    await mkdir(path.join(vault, "Templates"));
    await writeFile(path.join(vault, "Templates", "sample.md"), "# Example\nexclusionmarker\n");
    const selected = session();
    expect(await hits(selected, "exclusionmarker")).toHaveLength(1);
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
    expect(await hits(selected, "exclusionmarker")).toEqual([]);
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Other" }));
    expect(await hits(selected, "exclusionmarker")).toHaveLength(1);
  });

  it("reads legacy or invalidated evidence once, then retains metadata reuse", async () => {
    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE engine_document_source");
    legacy.close();
    const selected = session();
    expect(await hits(selected, "oldkeyword")).toHaveLength(1);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    await hits(selected, "oldkeyword");
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    const sourceDb = new Database(dbPath, { readonly: true });
    expect(sourceDb.prepare("SELECT name FROM sqlite_master WHERE name='engine_document_source'").get()).toBeUndefined();
    sourceDb.close();
  });

  it("rehashes weak metadata on every read rather than treating null fingerprints as equal", async () => {
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    vi.spyOn(source, "documentSourceFingerprint").mockResolvedValue(null);
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      const captured = await original.readDocumentSource(...args);
      return { ...captured, source: { ...captured.source, fingerprint: null } };
    });
    const selected = session();
    expect(await hits(selected, "oldkeyword")).toHaveLength(1);
    const reads = vi.mocked(source.readDocumentSource).mock.calls.length;
    expect(await hits(selected, "oldkeyword")).toHaveLength(1);
    // One stable byte capture for inventory, one for final revalidation; the
    // parsed-node/FTS fast path does not perform a redundant third capture.
    expect(vi.mocked(source.readDocumentSource).mock.calls.length - reads).toBe(2);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    expect(await hits(selected, "newkeyword")).toHaveLength(1);
    expect(await hits(selected, "oldkeyword")).toEqual([]);
  });

  it("rebuilds a noncanonical chunker and never trusts source evidence invalidated by a chunk mutation", async () => {
    await writeFile(path.join(vault, "alpha.md"), `${OLD}${"content words and sentences\n".repeat(50)}`);
    await syncEngineStore({ vault, dbPath, embed: false, chunkerOpts: { maxTokens: 10 } });
    const selected = session();
    const actual = await hits(selected, "content");
    expect(new Set(actual.map(hit => hit.chunkOrdinal)).size).toBe(chunkDocument("alpha.md", await readFile(path.join(vault, "alpha.md"), "utf8")).length);
    const writer = openEngineStoreCore(dbPath);
    writer.upsertLex(chunkDocument("alpha.md", "# Bogus\nnotfromvault\n"));
    writer.close();
    expect(await hits(selected, "notfromvault")).toEqual([]);
    expect(await hits(selected, "oldkeyword")).toHaveLength(1);
  });

  it("captures independent results before a later refresh mutates the detached corpus", async () => {
    const selected = session();
    const first = await selected.prepare(vault, ["oldkeyword"], 10);
    await writeFile(path.join(vault, "alpha.md"), NEW);
    const second = await selected.prepare(vault, ["newkeyword"], 10);
    expect(first.store.queryLex("oldkeyword", 10)[0]?.text).toContain("oldkeyword");
    expect(second.store.queryLex("newkeyword", 10)[0]?.text).toContain("newkeyword");
    expect(await indexSourcesUnchanged(first.snapshot)).toBe(false);
    await selected.dispose();
    expect(second.store.queryLex("newkeyword", 10)).toHaveLength(1);
    await expect(selected.prepare(vault, ["newkeyword"], 10)).rejects.toThrow(/closed/u);
  });

  it("filters collections before candidate limits and includes all uncapped matches", async () => {
    await mkdir(path.join(vault, "a%_!"));
    for (let i = 0; i < 65; i++) await writeFile(path.join(vault, "a%_!", `${i}.md`), `# ${i}\ncommonterm ${"extra ".repeat(i)}\n`);
    const selected = session();
    expect(await hits(selected, "commonterm", 1, "a%_!")).toHaveLength(1);
    expect(await hits(selected, "commonterm", Number.MAX_SAFE_INTEGER, "a%_!")).toHaveLength(65);
    expect(await hits(selected, "commonterm", 10, "a")).toEqual([]);
  });

  it("refreshes current sources across external WAL sync and atomic generation replacement", async () => {
    const selected = session();
    await hits(selected, "oldkeyword");
    await writeFile(path.join(vault, "alpha.md"), NEW);
    const writer = openEngineStoreCore(dbPath);
    await syncEngineStore({ vault, dbPath, embed: false, store: writer });
    expect(await hits(selected, "newkeyword")).toHaveLength(1);
    writer.close();
    await rename(dbPath, `${dbPath}.backup`);
    const replacement = openEngineStoreCore(dbPath);
    replacement.upsertLex(chunkDocument("ghost.md", "# Ghost\nghostmarker\n"));
    replacement.close();
    expect(await hits(selected, "newkeyword")).toHaveLength(1);
    expect(await hits(selected, "ghostmarker")).toEqual([]);
  });

  it("bounds compact projection retention without dropping facets or results", async () => {
    const selected = new LiveLexicalSession({ vault, dbPath, maxProjectionBytes: 0 });
    sessions.push(selected);
    const first = await selected.prepare(vault, ["oldkeyword"], 10);
    expect(first.store.queryLex("oldkeyword", 10)).toHaveLength(1);
    expect(await first.nodeProjection(await readSearchTemplateSource(vault))).toHaveLength(1);
    expect(selected.retainedStorage()).toMatchObject({ projectionBytes: 0, projectionDocuments: 0 });
    const before = vi.mocked(source.readDocumentSource).mock.calls.length;
    const second = await selected.prepare(vault, ["oldkeyword"], 10);
    expect(await second.nodeProjection(await readSearchTemplateSource(vault))).toHaveLength(1);
    expect(vi.mocked(source.readDocumentSource).mock.calls.length).toBe(before);
  });

  it("releases an oversized memory corpus after spill failure and actually spills on retry", async () => {
    await rm(dbPath);
    await writeFile(path.join(vault, "alpha.md"), "# Alpha\nneedle\n" + "word ".repeat(220_000));
    const limit = 512 * 1024;
    const selected = session(limit);
    const internal = selected as unknown as { tempPath(): string };
    const original = internal.tempPath.bind(selected);
    let failed = false;
    vi.spyOn(internal, "tempPath").mockImplementation(() => {
      if (!failed) { failed = true; throw new Error("temporary spill creation failed"); }
      return original();
    });
    await expect(selected.prepare(vault, ["needle"], 10)).rejects.toThrow(/temporary spill/u);
    expect(selected.retainedStorage().bytes).toBe(0);
    expect((await selected.prepare(vault, ["needle"], 10)).store.queryLex("needle", 10)).not.toHaveLength(0);
    expect(selected.retainedStorage().memory).toBe(false);
  });

  it("rejects source-copy temporary storage inside the vault even when the core fits in memory", async () => {
    const temporary = path.join(vault, "temporary");
    await mkdir(temporary);
    vi.stubEnv("TMPDIR", temporary);
    const selected = session();
    await expect(selected.prepare(vault, ["oldkeyword"], 10)).rejects.toThrow(/inside the vault/u);
    expect(await readdir(temporary)).toEqual([]);
    expect(selected.retainedStorage().bytes).toBe(0);
  });

  it("spills oversized cores to disposable external storage and closes idempotently", async () => {
    const selected = session(1);
    const before = await persistentImage();
    expect(await hits(selected, "oldkeyword")).toHaveLength(1);
    expect(selected.retainedStorage()).toMatchObject({ memory: false });
    expect(await persistentImage()).toEqual(before);
    await selected.dispose();
    await selected.dispose();
    expect(selected.retainedStorage().bytes).toBe(0);
  });

  it("builds an absent index in memory and rejects cross-vault or uncaptured queries", async () => {
    await rm(dbPath);
    const selected = session();
    const captured = await selected.prepare(vault, ["oldkeyword"], 5);
    expect(captured.store.queryLex("oldkeyword", 5)).toHaveLength(1);
    expect(() => captured.store.queryLex("different", 5)).toThrow(/not captured/u);
    expect(() => captured.store.queryVec(new Float32Array(2), 5)).toThrow(/cannot/u);
    await expect(selected.prepare(path.join(root, "other"), ["oldkeyword"], 5)).rejects.toThrow(/another vault/u);
    await expect(selected.prepare(vault, ["oldkeyword"], 5, "../outside")).rejects.toThrow(/inside the vault/u);
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers after a failed capture and does not retain a rejected refresh promise", async () => {
    const selected = session();
    await hits(selected, "oldkeyword");
    await writeFile(path.join(vault, "alpha.md"), NEW);
    vi.mocked(source.readDocumentSource).mockRejectedValueOnce(new Error("capture changed"));
    await expect(selected.prepare(vault, ["newkeyword"], 5)).rejects.toThrow(/capture changed/u);
    expect(await hits(selected, "newkeyword")).toHaveLength(1);
  });

  it("coalesces concurrent refreshes and drains active preparation before disposing", async () => {
    const selected = session();
    await writeFile(path.join(vault, "alpha.md"), NEW);
    const first = selected.prepare(vault, ["newkeyword"], 5);
    const second = selected.prepare(vault, ["oldkeyword"], 5);
    const disposal = selected.dispose();
    const [fresh, old] = await Promise.all([first, second]);
    expect(fresh.store.queryLex("newkeyword", 5)).toHaveLength(1);
    expect(old.store.queryLex("oldkeyword", 5)).toEqual([]);
    expect(source.readDocumentSource).toHaveBeenCalledTimes(1);
    await disposal;
    expect(selected.retainedStorage().bytes).toBe(0);
  });

  it("drains bounded readers after an error before allowing disposal", async () => {
    await writeFile(path.join(vault, "beta.md"), "# Beta\nothermarker\n");
    const selected = session();
    const original = await vi.importActual<typeof import("./source.js")>("./source.js");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
      if (args[1] === "alpha.md") throw new Error("capture failure");
      enter();
      await released;
      return original.readDocumentSource(...args);
    });
    let settled = false;
    const prepared = selected.prepare(vault, ["othermarker"], 10).catch(error => { settled = true; return error as Error; });
    await entered;
    const disposed = selected.dispose();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await prepared).toMatchObject({ message: "capture failure" });
    await disposed;
    expect(selected.retainedStorage().bytes).toBe(0);
  });

  it("returns an explicit retry instead of combining revisions when a note changes during reranking", async () => {
    const selected = session();
    const engine = assembleLiveLexicalEngine({
      vault, dbPath,
      reranker: { rerank: async (_query, candidates) => {
        await writeFile(path.join(vault, "alpha.md"), NEW);
        return candidates;
      } },
    }, selected);
    try {
      const result = await engine.adapter.semanticQuery({ query: "oldkeyword", rerank: true });
      expect(result).toMatchObject({ available: false, hits: [], receipt: { indexDrift: true } });
      if (!result.available) expect(result.reason).toMatch(/no index synchronization is needed/u);
      expect(await engine.adapter.semanticQuery({ query: "newkeyword" })).toMatchObject({ available: true, totalCount: 1 });
    } finally { await engine.dispose(); }
  });

  it("serves unsynced search through the facade with fresh previews and explicit vector failure", async () => {
    const selected = session();
    const engine = assembleLiveLexicalEngine({ vault, dbPath, modelEnv: {}, installedModelsReceipt: { version: 1, models: [] } }, selected);
    try {
      await writeFile(path.join(vault, "alpha.md"), "# Changed title\nnewkeyword\n");
      expect(await engine.adapter.semanticQuery({ query: "newkeyword" })).toMatchObject({
        available: true, totalCount: 1, receipt: { usedChannels: ["lex"], indexDrift: false },
        hits: [{ path: "alpha.md", title: "Changed title", snippet: expect.stringContaining("newkeyword") }],
      });
      expect(await engine.adapter.semanticQuery({ vec: "newkeyword" })).toMatchObject({ available: false, hits: [] });
    } finally { await engine.dispose(); }
  });
});
