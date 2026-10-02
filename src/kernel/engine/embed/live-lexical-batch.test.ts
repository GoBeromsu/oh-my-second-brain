import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { LiveLexicalSession } from "./live-lexical.js";
import { openDetachedLexicalStore, type DetachedLexicalStore } from "./store.js";
import { chunkDocument } from "./chunker.js";
import { indexSourcesUnchanged } from "./freshness.js";
import { type CapturedLexicalDocument, LexicalDocumentBatch } from "./lexical-batch.js";
import * as source from "./source.js";

vi.mock("./source.js", async original => {
  const actual = await original<typeof import("./source.js")>();
  return { ...actual, readDocumentSource: vi.fn(actual.readDocumentSource) };
});

let root: string; let vault: string; let temporary: string;
const sessions: LiveLexicalSession[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-lexical-batch-")));
  vault = path.join(root, "vault"); temporary = path.join(root, "temporary");
  await mkdir(vault); await mkdir(temporary); vi.stubEnv("TMPDIR", temporary);
  const actual = await vi.importActual<typeof import("./source.js")>("./source.js");
  vi.mocked(source.readDocumentSource).mockImplementation(actual.readDocumentSource);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});
function selected(maxMemoryBytes?: number) {
  const session = new LiveLexicalSession({ vault, dbPath: path.join(root, "absent.sqlite"), maxMemoryBytes });
  sessions.push(session); return session;
}
function captured(index: number, text = "oldmarker"): CapturedLexicalDocument {
  const docPath = `note-${index}.md`; const content = `# Note ${index}\n${text}\n`;
  return { docPath, chunks: chunkDocument(docPath, content), source: { fingerprint: null,
    contentSha256: createHash("sha256").update(content).digest("hex"), chunker: "canonical-test" } };
}

it.each(["memory", "disk"])("rolls back all documents in a failed %s transaction and supports retry", kind => {
  const store = openDetachedLexicalStore(path.join(root, "absent.sqlite"), kind === "disk" ? path.join(root, "scratch.sqlite") : ":memory:");
  try {
    const old = [captured(0), captured(1), captured(2)];
    store.reconcileDocuments(old);
    const hits = store.store.queryLex("oldmarker", 100); const sources = store.store.readDocumentSources();
    const replacements = old.map((_, index) => captured(index, "newmarker"));
    const invalid = replacements.map((row, index) => index === 1 ? { ...row, source: { ...row.source, contentSha256: "invalid" } } : row);
    expect(() => store.reconcileDocuments(invalid)).toThrow(/source evidence is invalid/u);
    expect(store.store.queryLex("oldmarker", 100)).toEqual(hits);
    expect(store.store.queryLex("newmarker", 100)).toEqual([]);
    expect(store.store.readDocumentSources()).toEqual(sources);
    store.reconcileDocuments(replacements);
    expect(store.store.queryLex("newmarker", 100)).toHaveLength(3);
  } finally { store.close(); }
});

it("continues bounded writes on a copied handle with complete source evidence", () => {
  const store = openDetachedLexicalStore(path.join(root, "absent.sqlite"));
  let disk: DetachedLexicalStore | undefined;
  try {
    const records = [captured(0), captured(1), captured(2)];
    store.reconcileDocument(records[0]!.docPath, records[0]!.source, records[0]!.chunks);
    expect([...store.store.readDocumentSources()!.keys()]).toEqual(["note-0.md"]);
    disk = store.copyTo(path.join(root, "scratch.sqlite"));
    disk.reconcileDocuments(records.slice(1));
    expect(disk.store.queryLex("oldmarker", 100)).toHaveLength(3);
    disk.reconcileDocuments([]);
  } finally { disk?.close(); store.close(); }
});

it("rolls back a real mid-batch SQLite constraint failure with native integrity intact", () => {
  const filename = path.join(root, "scratch.sqlite");
  const store = openDetachedLexicalStore(path.join(root, "absent.sqlite"), filename);
  const inspect = new Database(filename);
  try {
    inspect.exec("CREATE TRIGGER refuse_second BEFORE INSERT ON engine_chunk_meta WHEN NEW.doc_path = 'note-1.md' BEGIN SELECT RAISE(ABORT, 'injected constraint'); END");
    expect(() => store.reconcileDocuments([captured(0), captured(1), captured(2)])).toThrow(/injected constraint/u);
    expect(store.store.queryLex("oldmarker", 100)).toEqual([]);
    expect(store.store.readDocumentSources()!.size).toBe(0);
    expect(inspect.pragma("integrity_check", { simple: true })).toBe("ok");
    inspect.exec("DROP TRIGGER refuse_second");
    store.reconcileDocuments([captured(0), captured(1), captured(2)]);
  } finally { inspect.close(); store.close(); }
});

it("flushes a residual batch and spills before continuing without omitting empty notes", async () => {
  for (let index = 0; index < 45; index++) await writeFile(path.join(vault, `note-${index}.md`), index === 44 ? "" : `# Note\nmarker ${index}\n${"word ".repeat(1500)}`);
  const session = selected(100_000);
  const add = LexicalDocumentBatch.prototype.add;
  const queued = vi.spyOn(LexicalDocumentBatch.prototype, "add").mockImplementation(function (...args) {
    expect(session.retainedStorage().memory).toBe(false);
    return add.apply(this, args);
  });
  const result = await session.prepare(vault, ["marker"], 1000);
  expect(new Set(result.store.queryLex("marker", 1000).map(hit => hit.docPath)).size).toBe(44);
  expect(result.snapshot.contentSha256.size).toBe(45);
  expect(await indexSourcesUnchanged(result.snapshot)).toBe(true);
  expect(session.retainedStorage().memory).toBe(false);
  expect(queued.mock.calls.length).toBeGreaterThan(0);
  expect(queued.mock.calls.length).toBeLessThan(45);
  const store = (session as unknown as { current: DetachedLexicalStore }).current;
  expect(store.store.readDocumentSources()!.size).toBe(45);
  await session.dispose(); expect(await readdir(temporary)).toEqual([]);
  await expect(readFile(path.join(root, "absent.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("publishes no partial source map after a residual batch fails", async () => {
  for (let index = 0; index < 12; index++) await writeFile(path.join(vault, `note-${index}.md`), "oldmarker");
  const session = selected(1); await session.prepare(vault, ["oldmarker"], 100);
  const store = (session as unknown as { current: DetachedLexicalStore }).current;
  const before = store.store.readDocumentSources();
  for (let index = 0; index < 12; index++) await writeFile(path.join(vault, `note-${index}.md`), "newmarker");
  const original = store.store.recordDocumentSource; const failure = new Error("late batch refusal");
  vi.spyOn(store.store, "recordDocumentSource").mockImplementation((docPath, evidence, chunks) => {
    original(docPath, evidence, chunks);
    if (docPath === "note-6.md") throw failure;
  });
  await expect(session.prepare(vault, ["newmarker"], 100)).rejects.toBe(failure);
  expect(store.store.readDocumentSources()).toEqual(before);
  expect(store.store.queryLex("oldmarker", 100)).toHaveLength(12);
  expect(store.store.queryLex("newmarker", 100)).toEqual([]);
  vi.mocked(store.store.recordDocumentSource).mockRestore();
  const retry = await session.prepare(vault, ["newmarker"], 100);
  expect(retry.store.queryLex("newmarker", 100)).toHaveLength(12);
  expect(await indexSourcesUnchanged(retry.snapshot)).toBe(true);
});

it("drains captures and discards queued records on failure before disposal", async () => {
  await writeFile(path.join(vault, "a.md"), "marker"); await writeFile(path.join(vault, "b.md"), "marker");
  const session = selected(1);
  const actual = await vi.importActual<typeof import("./source.js")>("./source.js");
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error("source changed");
  vi.mocked(source.readDocumentSource).mockImplementation(async (...args) => {
    if (args[1] === "a.md") { const read = await actual.readDocumentSource(...args); enter(); await gate; return read; }
    throw failure;
  });
  const flush = vi.spyOn(LexicalDocumentBatch.prototype, "flush");
  const prepare = session.prepare(vault, ["marker"], 100).catch(error => error);
  await entered; let disposed = false;
  const disposal = session.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false); release();
  expect(await prepare).toBe(failure); await disposal;
  expect(flush).not.toHaveBeenCalled();
  expect(session.retainedStorage().bytes).toBe(0); expect(await readdir(temporary)).toEqual([]);
});

it("keeps entirely in-memory capture on individual committed budget checks", async () => {
  for (let index = 0; index < 40; index++) await writeFile(path.join(vault, `note-${index}.md`), "marker");
  const queued = vi.spyOn(LexicalDocumentBatch.prototype, "add");
  const session = selected();
  const first = await session.prepare(vault, ["marker"], 100);
  expect(first.store.queryLex("marker", 100)).toHaveLength(40);
  expect(session.retainedStorage().memory).toBe(true);
  expect(queued).not.toHaveBeenCalled();
  const store = (session as unknown as { current: DetachedLexicalStore }).current;
  const multiple = vi.spyOn(store, "reconcileDocuments");
  await writeFile(path.join(vault, "note-0.md"), "freshmarker");
  const changed = await session.prepare(vault, ["freshmarker"], 100);
  expect(changed.store.queryLex("freshmarker", 100)).toHaveLength(1);
  expect(multiple).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
});

it("retains ordinary method savepoints when a revision transaction catches an inner failure", () => {
  const filename = path.join(root, "scratch.sqlite");
  const store = openDetachedLexicalStore(path.join(root, "absent.sqlite"), filename);
  const inspect = new Database(filename);
  try {
    inspect.exec("CREATE TRIGGER refuse_second BEFORE INSERT ON engine_chunk_meta WHEN NEW.doc_path = 'note-1.md' BEGIN SELECT RAISE(ABORT, 'caught inner failure'); END");
    expect(() => store.reconcileDocuments([captured(0), captured(1)])).toThrow(/caught inner failure/u);
    store.store.documentRevisions!.transaction(() => {
      expect(() => store.store.upsertLex([...captured(0).chunks, ...captured(1).chunks])).toThrow(/caught inner failure/u);
    });
    expect(store.store.queryLex("oldmarker", 100)).toEqual([]);
    expect(store.store.listDocPaths()).toEqual([]);
    inspect.exec("DROP TRIGGER refuse_second");
    store.reconcileDocuments([captured(0), captured(1)]);
    expect(store.store.queryLex("oldmarker", 100)).toHaveLength(2);
    inspect.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON engine_chunk_meta BEGIN SELECT RAISE(ABORT, 'caught clear failure'); END");
    store.store.documentRevisions!.transaction(() => {
      expect(() => store.store.clearDocument("note-0.md")).toThrow(/caught clear failure/u);
    });
    expect(store.store.queryLex("oldmarker", 100)).toHaveLength(2);
    expect(store.store.readDocumentSources()!.size).toBe(2);
  } finally { inspect.close(); store.close(); }
});
