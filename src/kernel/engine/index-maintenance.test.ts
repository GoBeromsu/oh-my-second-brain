import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIndexMaintenance, sqliteMaintenanceSupported, maintenanceMode, maintenanceWatchHint, type IndexMaintenance, type IndexMaintenanceDeps, type IndexMaintenanceOptions } from "./index-maintenance.js";
import { syncEngineStore, acquireEngineStoreWriterLock } from "./embed/sync.js";
import { readMaintenanceState } from "./embed/maintenance.js";
import { openEngineStoreCoreReadOnly } from "./embed/store.js";
import { makeEmbeddingIdentity } from "./embed/identity.js";
import type { MaintenanceEmbedding } from "./maintenance-model.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

let root: string; let vault: string; let dbPath: string;
const running: IndexMaintenance[] = [];
const watched = () => ({ close: vi.fn() });
const identity = makeEmbeddingIdentity({ provider: "gguf", model: "synthetic.gguf", revision: "test-v1", sha256: "a".repeat(64), dimensions: 2,
  contextLength: 2048, mrlDim: 0, normalization: "l2", prefixScheme: "embeddinggemma-v1" });
function embedding(): MaintenanceEmbedding {
  return { identity, isCurrent: () => true, provider: { model: "deterministic-test-only", dimensions: 2, embed: vi.fn(async () => new Float32Array([1, 0])), dispose: vi.fn(async () => {}) } };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-index-maintenance-"))); vault = path.join(root, "vault"); dbPath = path.join(root, "cache", "index.sqlite");
  await mkdir(vault); await writeFile(path.join(vault, "a.md"), "---\nsubject: science\n---\noldmarker\n");
});
afterEach(async () => { await Promise.allSettled(running.splice(0).map(item => item.stop())); vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function sync(vector?: MaintenanceEmbedding) {
  const result = await syncEngineStore({ vault, dbPath, embed: vector !== undefined,
    ...(vector === undefined ? {} : { embeddingProviderInstance: vector.provider, embeddingProvider: "gguf", embeddingModel: identity.model,
      embeddingRevision: identity.revision, embeddingSha256: identity.sha256, embeddingDimensions: 2, embeddingContext: 2048,
      embeddingMrlDim: 0, embeddingNormalization: "l2", embeddingPrefixScheme: "embeddinggemma-v1" }) });
  expect(result.available).toBe(true);
}
async function start(options: Partial<IndexMaintenanceOptions> = {}, vector?: MaintenanceEmbedding, deps: IndexMaintenanceDeps = {}) {
  const result = await startIndexMaintenance({ vault, dbPath, source: "explicit", mode: "lexical", ...options }, {
    watch: watched,
    ...deps,
    ...(vector === undefined ? {} : { createEmbedding: () => vector }),
  });
  expect(result).toBeDefined(); running.push(result!); return result!;
}
function controlledWatcher() {
  const watcher = new EventEmitter() as fs.FSWatcher;
  watcher.close = vi.fn(() => { watcher.emit("close"); });
  vi.mocked(fs.watch).mockClear().mockImplementationOnce((...args: Parameters<typeof fs.watch>) => {
    const listener = args.find(arg => typeof arg === "function") as fs.WatchListener<string>;
    watcher.on("change", listener);
    return watcher;
  });
  return watcher;
}
function hits(query: string): string[] { const db = openEngineStoreCoreReadOnly(dbPath)!; try { return db.queryLex(query, 100).map(hit => hit.docPath); } finally { db.close(); } }

describe("production automatic maintenance binding", () => {
  it("is a strict no-op unless explicitly enabled, including missing/unverified targets", async () => {
    const before = await readdir(root);
    expect(await startIndexMaintenance({ vault: path.join(root, "absent"), source: "cwd" })).toBeUndefined();
    expect(await readdir(root)).toEqual(before);
    expect(await readdir(vault)).toEqual(["a.md"]);
  });
  it.each([undefined, "cwd", "legacy-bridge"] as const)("rejects target source %s without creating an index", async source => {
    await expect(startIndexMaintenance({ vault, dbPath, mode: "lexical", source })).rejects.toThrow("TARGET_UNVERIFIED");
    await expect(stat(path.dirname(dbPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires an existing store and confines the owner/database outside the vault", async () => {
    await expect(start()).rejects.toThrow("INDEX_UNAVAILABLE");
    await expect(start({ dbPath: path.join(vault, "cache.sqlite") })).rejects.toThrow("inside the vault");
    expect(await readdir(vault)).toEqual(["a.md"]);
  });
  it("catches up a saved source after an interrupted pre-index write", async () => {
    await sync(); await writeFile(path.join(vault, "a.md"), "---\nsubject: changed\n---\nfreshmarker\n");
    const before = await readFile(path.join(vault, "a.md"));
    const owner = await start(); await owner.controller.flush();
    expect(hits("freshmarker")).toEqual(["a.md"]); expect(hits("oldmarker")).toEqual([]);
    expect(readMaintenanceState(dbPath).pending).toHaveLength(1);
    expect(await readFile(path.join(vault, "a.md"))).toEqual(before);
    expect(owner.status()).toMatchObject({ phase: "idle", updated: 1, pendingVectors: 1, sqliteVersion: expect.any(String) });
  });
  it("applies a delivered watch hint after debounce without waiting for reconciliation", async () => {
    await sync();
    const watcher = controlledWatcher();
    // Undefined selects the production fs.watch adapter, with controlled delivery below.
    const owner = await start({}, undefined, { watch: undefined });
    await owner.controller.flush();
    expect(owner.status()).toMatchObject({ phase: "idle", watching: true, scans: 1 });
    const flush = owner.controller.flush.bind(owner.controller);
    let cycle: Promise<void> | undefined;
    const scheduled = vi.spyOn(owner.controller, "flush").mockImplementation(() => { cycle = flush(); return cycle; });

    await writeFile(path.join(vault, "a.md"), "watchmarker\n");
    expect(fs.watch).toHaveBeenCalledWith(vault, { recursive: true }, expect.any(Function));
    watcher.emit("change", "change", "a.md");
    await vi.advanceTimersByTimeAsync(149);
    expect(scheduled).not.toHaveBeenCalled();
    expect(hits("watchmarker")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(scheduled).toHaveBeenCalledOnce();
    await cycle;
    expect(hits("watchmarker")).toEqual(["a.md"]);
    expect(hits("oldmarker")).toEqual([]);
    expect(owner.status()).toMatchObject({ phase: "idle", scans: 1, updated: 1 });
    await owner.stop();
    expect(watcher.close).toHaveBeenCalledOnce();
  });
  it("reconciles a silent registered watcher at the default periodic deadline", async () => {
    await sync();
    controlledWatcher(); // Native registration succeeds but no change event fires.
    const owner = await start({}, undefined, { watch: undefined });
    await owner.controller.flush();
    expect(fs.watch).toHaveBeenCalledOnce();
    expect(owner.status()).toMatchObject({ phase: "idle", watching: true, scans: 1 });
    const flush = owner.controller.flush.bind(owner.controller);
    let cycle: Promise<void> | undefined;
    const scheduled = vi.spyOn(owner.controller, "flush").mockImplementation(() => { cycle = flush(); return cycle; });

    await writeFile(path.join(vault, "a.md"), "missedmarker\n");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(scheduled).not.toHaveBeenCalled();
    expect(hits("missedmarker")).toEqual([]);
    // The interval schedules a zero-delay task; fake timers run that on the next tick.
    await vi.advanceTimersByTimeAsync(2);
    expect(scheduled).toHaveBeenCalledOnce();
    await cycle; // Await the timer-started scan, never manually flush or notify.
    expect(hits("missedmarker")).toEqual(["a.md"]);
    expect(hits("oldmarker")).toEqual([]);
    expect(owner.status()).toMatchObject({ phase: "idle", watching: true, scans: 2, updated: 1 });
    expect(fs.watch).toHaveBeenCalledOnce();
  });
  it("coalesces edits and repairs missed rename/delete/recreate events", async () => {
    await sync(); const owner = await start(); await owner.controller.flush();
    for (let index = 0; index < 20; index++) { await writeFile(path.join(vault, "a.md"), `latest${index} marker\n`); owner.notify("a.md"); }
    await owner.controller.flush(); expect(hits("latest19")).toEqual(["a.md"]);
    await rename(path.join(vault, "a.md"), path.join(vault, "b.md")); owner.notify(); await owner.controller.flush();
    expect(hits("latest19")).toEqual(["b.md"]);
    await rm(path.join(vault, "b.md")); owner.notify(); await owner.controller.flush(); expect(hits("latest19")).toEqual([]);
    await writeFile(path.join(vault, "b.md"), "recreatedmarker\n"); owner.notify(); await owner.controller.flush();
    expect(hits("recreatedmarker")).toEqual(["b.md"]);
  });
  it("detects same-length writes with restored mtime", async () => {
    await sync(); const owner = await start(); await owner.controller.flush();
    const filename = path.join(vault, "a.md"); const before = await stat(filename);
    await writeFile(filename, (await readFile(filename, "utf8")).replace("oldmarker", "newmarker"));
    await utimes(filename, before.atime, before.mtime);
    owner.notify(); await owner.controller.flush(); expect(hits("newmarker")).toEqual(["a.md"]);
  });
  it("removes newly excluded rows only after successful full reconciliation", async () => {
    await mkdir(path.join(vault, "Templates")); await writeFile(path.join(vault, "Templates", "source.md"), "templateprobe\n");
    await sync(); const owner = await start(); await owner.controller.flush(); expect(hits("templateprobe")).toEqual(["Templates/source.md"]);
    await mkdir(path.join(vault, ".oms")); await writeFile(path.join(vault, ".oms/settings.json"), JSON.stringify({ version: 1, vaultId: "11111111-2222-4333-8444-555555555555", templateFolder: "Templates" }));
    owner.notify(); await owner.controller.flush(); expect(hits("templateprobe")).toEqual([]);
    expect(await readFile(path.join(vault, "Templates/source.md"), "utf8")).toBe("templateprobe\n");
  });
  it("retains pending work on a busy writer and catches up after release", async () => {
    await sync(); const owner = await start(); await owner.controller.flush();
    const release = acquireEngineStoreWriterLock(dbPath);
    try { await writeFile(path.join(vault, "a.md"), "busyprobe\n"); owner.notify("a.md"); await owner.controller.flush(); expect(owner.status().phase).toBe("backoff"); }
    finally { release(); }
    await owner.controller.flush(); expect(hits("busyprobe")).toEqual(["a.md"]);
  });
  it("refuses a second owner, then permits a new owner after drained shutdown", async () => {
    await sync(); const first = await start(); await first.controller.flush();
    await expect(start()).rejects.toThrow("OWNER_BUSY");
    await first.stop(); const next = await start(); await next.controller.flush(); expect(next.status().phase).toBe("idle");
  });
  it("cancels when the canonical vault is replaced", async () => {
    await sync(); const owner = await start(); await owner.controller.flush();
    await rename(vault, `${vault}-original`); await mkdir(vault); await writeFile(path.join(vault, "a.md"), "replacement\n");
    owner.notify("a.md"); await owner.controller.flush(); expect(owner.status().phase).toBe("failed");
    expect(hits("replacement")).toEqual([]);
  });
  it("requires an initialized matching model identity and disposes failed startup providers", async () => {
    await sync(); const vector = embedding();
    await expect(start({ mode: "full" }, vector)).rejects.toThrow("MODEL_UNVERIFIED");
    expect(vector.provider.dispose).toHaveBeenCalledOnce();
    const owner = await start(); await owner.controller.flush(); expect(owner.status().phase).toBe("idle");
  });
  it("upgrades legacy pending revisions, embeds current raw frontmatter, and drains conditionally", async () => {
    const vector = embedding(); await sync(vector); vi.mocked(vector.provider.embed).mockClear();
    const db = new Database(dbPath); db.exec("DROP TABLE IF EXISTS engine_dirty; CREATE TABLE engine_dirty(doc_path TEXT PRIMARY KEY,queued_at TEXT NOT NULL); INSERT INTO engine_dirty VALUES ('a.md','old');"); db.close();
    const owner = await start({ mode: "full" }, vector); await owner.controller.flush();
    expect(readMaintenanceState(dbPath).pending).toEqual([]);
    expect(vector.provider.embed).toHaveBeenCalledWith(expect.stringContaining("subject: science"), expect.any(String));
    expect(owner.status().embedded).toBe(1);
    await owner.stop(); expect(vector.provider.dispose).toHaveBeenCalledOnce();
  });
  it("stops rather than silently using a changed model selection", async () => {
    const vector = embedding(); await sync(vector); const owner = await start({ mode: "full" }, vector); await owner.controller.flush();
    vi.spyOn(vector, "isCurrent").mockReturnValue(false);
    owner.notify("a.md"); await owner.controller.flush(); expect(owner.status().phase).toBe("failed");
    expect(vector.provider.dispose).toHaveBeenCalledOnce();
  });
});

describe("maintenance startup settings", () => {
  it.each([undefined, "note.md", "Note.MD", "folder", ".oms", ".oms/settings.json", ".obsidian", ".obsidian/templates.json", ".obsidian/plugins/templater-obsidian/data.json", "./.oms/settings.json", "../outside.md", "C:\\outside.md"])("retains note, control, directory or uncertain hint %s", hint => expect(maintenanceWatchHint(hint)).toBe(true));
  it.each([".obsidian/workspace.json", ".obsidian/types.json", ".obsidian\\workspace.json", ".git/index", "node_modules/package/a.md", "folder/.hidden/note.md", "_attachments", "_attachments/image.png"])("does not rescan notes for excluded housekeeping %s", hint => expect(maintenanceWatchHint(hint)).toBe(false));
  it.each(["3.51.3", "3.52.0", "3.53.1", "3.50.7", "3.44.6"])("recognizes fixed SQLite %s", version => expect(sqliteMaintenanceSupported(version)).toBe(true));
  it.each(["3.51.2", "3.50.6", "3.44.5", "3.49.9", "vendor-backport", "3.51"])("does not assume a fix in %s", version => expect(sqliteMaintenanceSupported(version)).toBe(false));
  it("accepts only explicit modes", () => { expect(maintenanceMode("lexical")).toBe("lexical"); expect(maintenanceMode("full")).toBe("full"); expect(() => maintenanceMode("true")).toThrow(); });
});
