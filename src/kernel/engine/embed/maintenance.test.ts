import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../types.js";
import { updateKeywordIndex, completeDirtyDrain } from "../index-update.js";
import { makeEmbeddingIdentity } from "./identity.js";
import { embedQueuedDocument, listPendingDocumentRevisions, maintainDocumentIndex, readMaintenanceState } from "./maintenance.js";
import { openEngineStore, openEngineStoreCore } from "./store.js";
import { acquireEngineStoreWriterLock, syncEngineStore } from "./sync.js";

let root: string;
let vault: string;
let dbPath: string;
const identity = makeEmbeddingIdentity({ provider: "gguf", model: "test-model", revision: "r1", sha256: "a".repeat(64), dimensions: 2, contextLength: 2048, mrlDim: 0, normalization: "l2", prefixScheme: "test-prefix" });
const defaultProvider: EmbeddingProvider = { model: "test-model", dimensions: 2, embed: async () => new Float32Array([1, 0]), dispose: async () => {} };
const options = () => ({ vault, dbPath, relPath: "a.md" });
const write = (content: string, filename = "a.md") => writeFileSync(path.join(vault, filename), content);
function sql(action: (db: Database.Database) => void): void { const db = new Database(dbPath); try { action(db); } finally { db.close(); } }
function snapshot() {
  const store = openEngineStore(dbPath, 2);
  try { return { state: readMaintenanceState(dbPath), text: store.getChunkText("a.md", 0), vectors: [...store.vectorOrdinals!("a.md")], shas: store.getShas("a.md") }; }
  finally { store.close(); }
}
function persistentImage(directory = root): unknown {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => directory !== root || entry.name.startsWith("engine.sqlite"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? persistentImage(path.join(directory, entry.name)) : readFileSync(path.join(directory, entry.name))]);
}
function storedSchema() {
  // Fixtures close all handles before this copy; inspection cannot touch the
  // replacement's WAL/SHM (a serialized WAL-mode image cannot open in memory).
  const copy = path.join(root, "schema-copy.sqlite");
  writeFileSync(copy, readFileSync(dbPath));
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(); }
  finally { db.close(); }
}
async function seed(content = "# A\noriginalkeyword"): Promise<void> {
  write(content);
  const store = openEngineStore(dbPath, 2);
  store.writeEmbeddingIdentity(identity);
  store.close();
  await sync();
}
async function sync(provider: EmbeddingProvider = defaultProvider, embed = true) {
  return syncEngineStore({ vault, dbPath, embed, embeddingProvider: identity.provider, embeddingModel: identity.model, embeddingRevision: identity.revision, embeddingSha256: identity.sha256, embeddingDimensions: identity.dimensions, embeddingContext: identity.contextLength, embeddingMrlDim: identity.mrlDim, embeddingNormalization: identity.normalization, embeddingPrefixScheme: identity.prefixScheme, embeddingProviderInstance: provider });
}
async function queue(content = "---\ntitle: Explicit title\nprivate-tag: raw-frontmatter\n---\n# A\nupdatedkeyword"): Promise<void> {
  write(content);
  expect(await maintainDocumentIndex(options())).toBe("updated");
}
function suspendedProvider() {
  let resolve!: (vector: Float32Array) => void;
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const provider: EmbeddingProvider = { ...defaultProvider, embed: vi.fn(async () => { entered(); return new Promise<Float32Array>(done => { resolve = done; }); }) };
  return { provider, started, finish: () => resolve(new Float32Array([0, 1])) };
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "oms-maintenance-"));
  vault = path.join(root, "vault");
  mkdirSync(vault);
  dbPath = path.join(root, "engine.sqlite");
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("atomic document maintenance", () => {
  it("publishes raw chunks, source evidence and revision together, and embeds their raw input", async () => {
    await seed();
    await queue();
    const queued = snapshot();
    expect(queued.state.pending).toMatchObject([{ docPath: "a.md", revision: expect.any(String) }]);
    expect(queued.text).toContain("private-tag: raw-frontmatter");
    expect(queued.vectors).toEqual([]);
    expect([...queued.shas.values()].every(sha => sha.startsWith("dirty:"))).toBe(true);
    const provider = { ...defaultProvider, embed: vi.fn(defaultProvider.embed) };
    expect(await embedQueuedDocument({ ...options(), provider, identity })).toBe("updated");
    expect(provider.embed).toHaveBeenCalledWith(expect.stringContaining("private-tag: raw-frontmatter"), "Explicit title");
    expect(snapshot().vectors).toEqual([0]);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
    expect(await maintainDocumentIndex(options())).toBe("skipped");
  });

  it("rolls back lexical, vectors, source and queue when the queue publication crashes", async () => {
    await seed();
    const before = snapshot();
    sql(db => db.exec("CREATE TRIGGER queue_crash BEFORE INSERT ON engine_dirty BEGIN SELECT RAISE(ABORT, 'injected queue crash'); END"));
    write("replacementkeyword");
    await expect(maintainDocumentIndex(options())).rejects.toThrow("injected queue crash");
    expect(snapshot()).toEqual(before);
    // The write pipeline now uses the same per-document transaction.
    expect(await updateKeywordIndex(options())).toBe("failed");
    expect(snapshot()).toEqual(before);
  });

  it("revisions two rapid writes and rejects late A without touching pending B", async () => {
    await seed();
    await queue("revision A");
    const a = listPendingDocumentRevisions(dbPath)[0]!.revision;
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    // The cooperative writer lock is free while inference is running.
    await queue("revision B");
    const b = snapshot();
    expect(b.state.pending[0]!.revision).not.toBe(a);
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(b);
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).toBe("updated");
  });

  it("rejects late A after B already committed its vectors", async () => {
    await seed(); await queue("revision A");
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    await queue("revision B");
    await embedQueuedDocument({ ...options(), provider: defaultProvider, identity });
    const b = snapshot();
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(b);
  });

  it.each(["delete", "rename", "recreate"])("rejects late inference after %s", async action => {
    await seed(); await queue("same bytes");
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    if (action === "rename") renameSync(path.join(vault, "a.md"), path.join(vault, "b.md"));
    else rmSync(path.join(vault, "a.md"));
    expect(await maintainDocumentIndex(options())).toBe("deleted");
    if (action === "rename") expect(await maintainDocumentIndex({ ...options(), relPath: "b.md" })).toBe("updated");
    if (action === "recreate") await queue("same bytes");
    const after = snapshot();
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(after);
  });

  it("retains pending work when Markdown changes without a newer index write", async () => {
    await seed(); await queue();
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    const before = snapshot();
    write("external editor changed this");
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(before);
  });

  it.each(["signal", "owner", "throw"])("prevents a late native result committing after %s cancellation", async cancellation => {
    await seed(); await queue();
    const abort = new AbortController();
    let owner = true;
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity, signal: abort.signal, isCurrent: () => {
      if (!owner && cancellation === "throw") throw new Error("owner lost");
      return owner;
    } });
    await blocked.started;
    const before = snapshot();
    if (cancellation === "signal") abort.abort(); else owner = false;
    blocked.finish();
    if (cancellation === "throw") await expect(job).rejects.toThrow("owner lost");
    else expect(await job).toBe("stale");
    expect(snapshot()).toEqual(before);
  });

  it("rolls back vector initialization when the epoch fails inside the final transaction", async () => {
    const store = openEngineStoreCore(dbPath); store.writeEmbeddingIdentity(identity); store.close();
    await queue();
    let inferred = false;
    let checksAfterInference = 0;
    const before = persistentImage();
    const schema = storedSchema();
    const provider = { ...defaultProvider, embed: async () => { inferred = true; return new Float32Array([1, 0]); } };
    expect(await embedQueuedDocument({ ...options(), provider, identity, isCurrent: () => !inferred || ++checksAfterInference < 4 })).toBe("stale");
    expect(checksAfterInference).toBe(4);
    expect(storedSchema()).toEqual(schema);
    expect(persistentImage()).toEqual(before);
  });

  it("initializes vectors for a current queued document in an existing core store", async () => {
    const store = openEngineStoreCore(dbPath); store.writeEmbeddingIdentity(identity); store.close();
    await queue();
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).toBe("updated");
    expect(snapshot().vectors).toEqual([0]);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
  });

  it.each(["changed", "removed"])("refuses %s chunks before vector initialization without changing the queue", async change => {
    const store = openEngineStoreCore(dbPath); store.writeEmbeddingIdentity(identity); store.close();
    await queue();
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    sql(db => db.exec(change === "changed" ? "UPDATE engine_chunk_meta SET sha = 'different'" : "DELETE FROM engine_chunk_meta"));
    const before = persistentImage();
    const schema = storedSchema();
    blocked.finish();
    expect(await job).toBe("stale");
    expect(storedSchema()).toEqual(schema);
    expect(persistentImage()).toEqual(before);
  });

  it.each(["fresh lexical", "legacy queue", "different model dimensions"])("does not initialize a %s replacement after late inference", async replacement => {
    await seed(); await queue();
    const revision = listPendingDocumentRevisions(dbPath)[0]!.revision;
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    renameSync(dbPath, `${dbPath}.previous`);
    const store = openEngineStoreCore(dbPath);
    if (replacement === "different model dimensions") store.writeEmbeddingIdentity(makeEmbeddingIdentity({ ...identity, dimensions: 3 }));
    store.close();
    if (replacement === "legacy queue") sql(db => db.exec("DROP TABLE engine_dirty; CREATE TABLE engine_dirty(doc_path TEXT PRIMARY KEY, queued_at TEXT NOT NULL); INSERT INTO engine_dirty VALUES ('a.md', 'legacy')"));
    if (replacement === "different model dimensions") {
      await maintainDocumentIndex(options());
      // Keep every captured document token identical to isolate model checking.
      sql(db => db.prepare("UPDATE engine_dirty SET revision = ? WHERE doc_path = 'a.md'").run(revision));
    }
    const before = persistentImage();
    const schema = storedSchema();
    expect(schema.some(row => (row as { name: string }).name === "engine_chunk_vec")).toBe(false);
    blocked.finish();
    expect(await job).toBe("stale");
    expect(storedSchema()).toEqual(schema);
    expect(persistentImage()).toEqual(before);
  });

  it("rechecks model identity after inference and preserves the new configuration", async () => {
    await seed(); await queue();
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity });
    await blocked.started;
    const different = makeEmbeddingIdentity({ ...identity, revision: "r2" });
    const store = openEngineStore(dbPath, 2); store.writeEmbeddingIdentity(different); store.close();
    const before = snapshot();
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(before);
    await expect(embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).rejects.toThrow(/identity differs/);
  });

  it("captures the model identity even when a caller mutates its input object", async () => {
    await seed(); await queue();
    const mutableIdentity = { ...identity };
    const blocked = suspendedProvider();
    const job = embedQueuedDocument({ ...options(), provider: blocked.provider, identity: mutableIdentity });
    await blocked.started;
    const different = makeEmbeddingIdentity({ ...identity, revision: "r2" });
    Object.assign(mutableIdentity, different);
    const store = openEngineStore(dbPath, 2); store.writeEmbeddingIdentity(different); store.close();
    const before = snapshot();
    blocked.finish();
    expect(await job).toBe("stale");
    expect(snapshot()).toEqual(before);
  });

  it("does not embed under a different chunker or provider width", async () => {
    await seed(); await queue();
    const provider = { ...defaultProvider, embed: vi.fn(defaultProvider.embed) };
    expect(await embedQueuedDocument({ ...options(), provider, identity, chunkerOpts: { maxTokens: 30 } })).toBe("stale");
    expect(provider.embed).not.toHaveBeenCalled();
    await expect(embedQueuedDocument({ ...options(), provider: { ...provider, dimensions: 3 }, identity })).rejects.toThrow(/dimensions/);
  });

  it("keeps empty notes in the source inventory and safely completes their queue", async () => {
    await seed(); await queue("");
    expect(readMaintenanceState(dbPath).documents.has("a.md")).toBe(true);
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).toBe("updated");
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
    rmSync(path.join(vault, "a.md"));
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).toBe("deleted");
    expect(readMaintenanceState(dbPath).documents.has("a.md")).toBe(false);
  });

  it("skips missing stores, excluded notes, and already-cancelled work without writes", async () => {
    expect(await maintainDocumentIndex(options())).toBe("skipped");
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity })).toBe("skipped");
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
    expect(existsSync(dbPath)).toBe(false);
    await seed();
    mkdirSync(path.join(vault, "notes"));
    write("ignored", "notes/SKILL.md");
    expect(await maintainDocumentIndex({ ...options(), relPath: "notes/SKILL.md" })).toBe("skipped");
    expect(await embedQueuedDocument({ ...options(), relPath: "notes/SKILL.md", provider: defaultProvider, identity })).toBe("skipped");
    const before = readFileSync(dbPath);
    expect(await maintainDocumentIndex({ ...options(), isCurrent: () => false })).toBe("stale");
    expect(await embedQueuedDocument({ ...options(), provider: defaultProvider, identity, signal: AbortSignal.abort() })).toBe("stale");
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it.each(["../a.md", "/a.md", "C:/a.md", "a.txt", ".hidden/a.md", "node_modules/a.md", "./a.md", "x//a.md"])("rejects unsafe path %s", async relPath => {
    await expect(maintainDocumentIndex({ ...options(), relPath })).rejects.toThrow(/inside the vault/);
  });

  it("normalizes Windows separators and rejects a store within the vault", async () => {
    await seed(); mkdirSync(path.join(vault, "notes")); write("nested", "notes/a.md");
    expect(await maintainDocumentIndex({ ...options(), relPath: "notes\\a.md" })).toBe("updated");
    await expect(maintainDocumentIndex({ ...options(), dbPath: path.join(vault, "engine.sqlite") })).rejects.toThrow();
  });

  it("fails closed for symlinks, missing roots, and non-directory parent errors", async () => {
    await seed();
    symlinkSync(path.join(vault, "a.md"), path.join(vault, "alias.md"));
    await expect(maintainDocumentIndex({ ...options(), relPath: "alias.md" })).rejects.toThrow(/symbolic links/);
    write("file", "parent");
    await expect(maintainDocumentIndex({ ...options(), relPath: "parent/a.md" })).rejects.toMatchObject({ code: "ENOTDIR" });
    renameSync(vault, `${vault}-moved`);
    await expect(maintainDocumentIndex(options())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not migrate a legacy store after ownership is lost during source capture", async () => {
    await seed();
    sql(db => db.exec("DROP TABLE engine_dirty"));
    write("new content");
    const before = readFileSync(dbPath);
    let checks = 0;
    expect(await maintainDocumentIndex({ ...options(), isCurrent: () => ++checks < 2 })).toBe("stale");
    expect(readFileSync(dbPath)).toEqual(before);
    sql(db => expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'engine_dirty'").get()).toBeUndefined());
  });

  it.each([3, 4])("leaves legacy schema and files unchanged when ownership fails at writer check %s", async rejectedCheck => {
    await seed();
    sql(db => db.exec("DROP TABLE engine_dirty; CREATE TABLE engine_dirty(doc_path TEXT PRIMARY KEY, queued_at TEXT NOT NULL)"));
    write("new content");
    const before = persistentImage();
    const schema = storedSchema();
    let checks = 0;
    expect(await maintainDocumentIndex({ ...options(), isCurrent: () => ++checks < rejectedCheck })).toBe("stale");
    expect(checks).toBe(rejectedCheck);
    expect(storedSchema()).toEqual(schema);
    expect(persistentImage()).toEqual(before);
  });

  it("rejects a busy writer and does not recreate a database removed after the existence check", async () => {
    await seed();
    const release = acquireEngineStoreWriterLock(dbPath);
    try { await expect(maintainDocumentIndex(options())).rejects.toThrow(/already in progress/); }
    finally { release(); }
    let calls = 0;
    await expect(maintainDocumentIndex({ ...options(), isCurrent: () => { if (++calls === 1) rmSync(dbPath); return true; } })).rejects.toThrow();
    expect(existsSync(dbPath)).toBe(false);
  });

  it("keeps a failed provider or invalid vector queued and preserves the lexical revision", async () => {
    await seed(); await queue();
    const before = snapshot();
    await expect(embedQueuedDocument({ ...options(), identity, provider: { ...defaultProvider, embed: async () => { throw new Error("provider failed"); } } })).rejects.toThrow("provider failed");
    expect(snapshot()).toEqual(before);
    await expect(embedQueuedDocument({ ...options(), identity, provider: { ...defaultProvider, embed: async () => new Float32Array([Number.NaN, 1]) } })).rejects.toThrow(/non-finite/);
    expect(snapshot()).toEqual(before);
  });

  it("reads legacy queues without migration and upgrades their revision on a write", async () => {
    await seed();
    sql(db => { db.exec("DROP TABLE engine_dirty; CREATE TABLE engine_dirty(doc_path TEXT PRIMARY KEY, queued_at TEXT NOT NULL)"); db.prepare("INSERT INTO engine_dirty VALUES (?, ?)").run("a.md", "2026-01-01"); });
    const before = readFileSync(dbPath);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([{ docPath: "a.md", queuedAt: "2026-01-01", revision: null }]);
    expect(readMaintenanceState(dbPath).pending[0]!.revision).toBeNull();
    expect(readFileSync(dbPath)).toEqual(before);
    expect(await maintainDocumentIndex(options())).toBe("updated");
    expect(listPendingDocumentRevisions(dbPath)[0]!.revision).toEqual(expect.any(String));
    sql(db => db.exec("DROP TABLE engine_dirty; DROP TABLE engine_document_source"));
    expect(readMaintenanceState(dbPath)).toMatchObject({ documents: new Map([["a.md", null]]), pending: [] });
  });

  it("reports validated stored identity and actual SQLite version without writes", async () => {
    await seed();
    const before = readFileSync(dbPath);
    const state = readMaintenanceState(dbPath);
    expect(state.embeddingIdentity).toEqual(identity);
    expect(state.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it.each([false, true])("purges newly excluded indexed notes only on complete-scan admission (missing=%s)", async missing => {
    await seed();
    mkdirSync(path.join(vault, "notes"));
    write("excluded later", "notes/a.md");
    const opts = { ...options(), relPath: "notes/a.md" };
    expect(await maintainDocumentIndex(opts)).toBe("updated");
    mkdirSync(path.join(vault, ".obsidian"));
    write('{"folder":"notes"}', ".obsidian/templates.json");
    if (missing) rmSync(path.join(vault, "notes/a.md"));
    expect(await maintainDocumentIndex(opts)).toBe("skipped");
    expect(readMaintenanceState(dbPath).documents.has("notes/a.md")).toBe(true);
    expect(await maintainDocumentIndex({ ...opts, purgeExcluded: true })).toBe("deleted");
    expect(readMaintenanceState(dbPath).documents.has("notes/a.md")).toBe(false);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
  });

  it("keeps pending-only paths visible to complete-scan deletion after an interrupted clear", async () => {
    await seed();
    mkdirSync(path.join(vault, "notes")); write("excluded later", "notes/a.md");
    const opts = { ...options(), relPath: "notes/a.md" };
    await maintainDocumentIndex(opts);
    const store = openEngineStoreCore(dbPath); store.clearDocument("notes/a.md"); store.close();
    expect(readMaintenanceState(dbPath).documents.get("notes/a.md")).toBeNull();
    mkdirSync(path.join(vault, ".obsidian")); write('{"folder":"notes"}', ".obsidian/templates.json");
    expect(await maintainDocumentIndex({ ...opts, purgeExcluded: true })).toBe("deleted");
    expect(readMaintenanceState(dbPath).documents.has("notes/a.md")).toBe(false);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
  });

  it("returns stale and requests reconciliation if exclusion policy changes across deletion", async () => {
    await seed();
    mkdirSync(path.join(vault, "notes")); write("excluded later", "notes/a.md");
    const opts = { ...options(), relPath: "notes/a.md" };
    await maintainDocumentIndex(opts);
    mkdirSync(path.join(vault, ".obsidian")); write('{"folder":"notes"}', ".obsidian/templates.json");
    let calls = 0;
    expect(await maintainDocumentIndex({ ...opts, purgeExcluded: true, isCurrent: () => {
      if (++calls === 2) write('{}', ".obsidian/templates.json");
      return true;
    } })).toBe("stale");
    expect(readMaintenanceState(dbPath).documents.has("notes/a.md")).toBe(false);
    expect(await maintainDocumentIndex({ ...opts, purgeExcluded: true })).toBe("updated");
  });

  it("refuses an exclusion purge if the current source changes before its transaction", async () => {
    await seed();
    mkdirSync(path.join(vault, "notes")); write("excluded later", "notes/a.md");
    const opts = { ...options(), relPath: "notes/a.md" };
    await maintainDocumentIndex(opts);
    mkdirSync(path.join(vault, ".obsidian")); write('{"folder":"notes"}', ".obsidian/templates.json");
    let calls = 0;
    expect(await maintainDocumentIndex({ ...opts, purgeExcluded: true, isCurrent: () => {
      if (++calls === 2) write("new source revision", "notes/a.md");
      return true;
    } })).toBe("stale");
    expect(readMaintenanceState(dbPath).documents.has("notes/a.md")).toBe(true);
  });

  it("checks source and owner immediately before lexical and deletion commits", async () => {
    await seed();
    const before = snapshot();
    write("new content");
    let calls = 0;
    expect(await maintainDocumentIndex({ ...options(), isCurrent: () => ++calls < 2 })).toBe("stale");
    expect(snapshot()).toEqual(before);
    rmSync(path.join(vault, "a.md")); calls = 0;
    expect(await maintainDocumentIndex({ ...options(), isCurrent: () => { if (++calls === 2) write("recreated"); return true; } })).toBe("stale");
    expect(snapshot()).toEqual(before);
  });
});

describe("ordinary sync compatibility", () => {
  it("repairs the historical lexical-before-queue crash by checking actual vector coverage", async () => {
    await seed();
    write("replacementkeyword");
    expect((await sync(defaultProvider, false)).available).toBe(true);
    expect(snapshot().vectors).toEqual([]);
    expect(snapshot().state.pending).toEqual([]);
    const provider = { ...defaultProvider, embed: vi.fn(defaultProvider.embed) };
    expect((await sync(provider)).available).toBe(true);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(snapshot().vectors).toEqual([0]);
  });

  it("retains queued revisions through lexical passes and drains after an actual embedding sync", async () => {
    await seed(); await queue();
    expect((await sync(defaultProvider, false)).available).toBe(true);
    expect(completeDirtyDrain(dbPath)).toEqual({ drained: [], pending: ["a.md"] });
    expect((await sync()).available).toBe(true);
    expect(completeDirtyDrain(dbPath)).toEqual({ drained: ["a.md"], pending: [] });
  });

  it("finishes a raw embedding sync's clean queue without regenerating current vectors", async () => {
    await seed(); await queue();
    expect((await sync()).available).toBe(true);
    expect(listPendingDocumentRevisions(dbPath)).toHaveLength(1);
    const provider = { ...defaultProvider, embed: vi.fn(defaultProvider.embed) };
    expect(await embedQueuedDocument({ ...options(), provider, identity })).toBe("updated");
    expect(provider.embed).not.toHaveBeenCalled();
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
    expect(snapshot().vectors).toEqual([0]);
  });

  it("repairs clean queued chunks with missing vectors and legacy null revisions", async () => {
    await seed(); await queue();
    // Reproduce the older lexical pass that cleared dirty SHA without vectors.
    sql(db => db.exec("UPDATE engine_chunk_meta SET sha = substr(sha, 7); UPDATE engine_dirty SET revision = NULL"));
    const provider = { ...defaultProvider, embed: vi.fn(defaultProvider.embed) };
    expect(await embedQueuedDocument({ ...options(), provider, identity })).toBe("updated");
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(listPendingDocumentRevisions(dbPath)).toEqual([]);
    expect(snapshot().vectors).toEqual([0]);
  });

  it("keeps the prior document intact when inference fails during a full rewrite", async () => {
    await seed(); const before = snapshot();
    write(`${"new words ".repeat(2000)}\n`);
    const result = await sync({ ...defaultProvider, embed: async () => { throw new Error("failed native inference"); } });
    expect(result.available).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("refuses sync publication when the source changes during embedding", async () => {
    await seed(); const before = snapshot(); write("new words");
    const result = await sync({ ...defaultProvider, embed: async () => { write("even newer words"); return new Float32Array([1, 0]); } });
    expect(result).toMatchObject({ available: false, reason: expect.stringMatching(/changed before index synchronization/) });
    expect(snapshot()).toEqual(before);
  });
});
