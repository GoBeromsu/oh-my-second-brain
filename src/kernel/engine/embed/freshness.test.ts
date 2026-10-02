import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import * as fsSync from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { assembleCoreSemanticEngineReadOnly } from "../assemble.js";
import { openEngineStoreCoreReadOnly } from "./store.js";
import { syncEngineStore } from "./sync.js";
import { indexSourcesUnchanged, verifyIndexSources } from "./freshness.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile), open: vi.fn(original.open), stat: vi.fn(original.stat) };
});

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

let directory: string;
let vault: string;
let dbPath: string;
const ORIGINAL = "# Alpha\noldkeyword\n";
const EDITED = "# Alpha\nnewkeyword\n";
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oms-freshness-"));
  vault = path.join(directory, "vault");
  await mkdir(vault);
  dbPath = path.join(directory, "store.sqlite");
  await writeFile(path.join(vault, "alpha.md"), ORIGINAL);
  expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function query(text: string) {
  const engine = assembleCoreSemanticEngineReadOnly({ vault, dbPath })!;
  try { return await engine.adapter.semanticQuery({ query: text }); }
  finally { await engine.dispose(); }
}

describe("read-only source freshness", () => {
  it("reports manual edits as drift instead of combining stale matches with fresh previews", async () => {
    expect((await query("oldkeyword")).hits).toHaveLength(1);
    const before = await readFile(dbPath);
    await writeFile(path.join(vault, "alpha.md"), EDITED);
    for (const term of ["oldkeyword", "newkeyword"]) {
      const result = await query(term);
      expect(result).toMatchObject({ available: false, hits: [], receipt: { indexDrift: true, usedChannels: [] } });
      if (!result.available) expect(result.reason).toMatch(/INDEX_SOURCE_DRIFT.*doctor sync-embeddings --mode sync/u);
    }
    expect(await readFile(dbPath)).toEqual(before);
    expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
    expect((await query("oldkeyword")).hits).toHaveLength(0);
    expect((await query("newkeyword")).hits).toHaveLength(1);
  });

  it("detects same-size edits when mtime is restored", async () => {
    const filename = path.join(vault, "alpha.md");
    const before = await stat(filename);
    await writeFile(filename, EDITED);
    await utimes(filename, before.atime, before.mtime);
    expect((await stat(filename)).size).toBe(before.size);
    expect(await query("newkeyword")).toMatchObject({ available: false, receipt: { indexDrift: true } });
  });

  it("accepts a byte-identical touch using read-only hash verification", async () => {
    const filename = path.join(vault, "alpha.md");
    await utimes(filename, new Date(0), new Date(0));
    expect(await query("oldkeyword")).toMatchObject({ available: true, receipt: { indexDrift: false } });
  });

  it.each(["addition", "deletion", "rename", "replacement"])("detects %s and recovers after explicit full sync", async change => {
    const filename = path.join(vault, "alpha.md");
    if (change === "addition") await writeFile(path.join(vault, "beta.md"), EDITED);
    if (change === "deletion") await rm(filename);
    if (change === "rename") await rename(filename, path.join(vault, "renamed.md"));
    if (change === "replacement") {
      await writeFile(path.join(vault, "replacement.tmp"), EDITED);
      await rename(path.join(vault, "replacement.tmp"), filename);
    }
    expect(await query("keyword")).toMatchObject({ available: false, receipt: { indexDrift: true } });
    expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
    expect(await query("keyword")).toMatchObject({ available: true, receipt: { indexDrift: false } });
  });

  it("does not certify a partially indexed vault, and keeps one-note sync independent", async () => {
    await writeFile(path.join(vault, "beta.md"), "# Beta\notherkeyword\n");
    await syncEngineStore({ vault, dbPath, files: ["alpha.md"], embed: false });
    expect(await query("oldkeyword")).toMatchObject({ available: false, receipt: { indexDrift: true } });
    await syncEngineStore({ vault, dbPath, files: ["beta.md"], embed: false });
    expect((await query("oldkeyword")).hits).toHaveLength(1);
    expect((await query("otherkeyword")).hits).toHaveLength(1);
  });

  it("allows an independently fresh collection and scopes cleanup", async () => {
    await mkdir(path.join(vault, "Other"));
    await writeFile(path.join(vault, "Other", "beta.md"), "# Beta\notherkeyword\n");
    await syncEngineStore({ vault, dbPath, collectionPath: "Other", embed: false });
    await writeFile(path.join(vault, "alpha.md"), EDITED);
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      expect(await verifyIndexSources(store, vault, "Other")).toMatchObject({ available: true });
      expect(await verifyIndexSources(store, vault)).toMatchObject({ available: false });
      expect(store.listDocPaths()).toContain("alpha.md");
    } finally { store.close(); }
  });

  it("treats legacy evidence absence as unverified without changing the store", async () => {
    const db = new Database(dbPath);
    db.exec("DROP TABLE engine_document_source");
    db.close();
    const before = await readFile(dbPath);
    const result = await query("oldkeyword");
    expect(result).toMatchObject({ available: false, receipt: { indexDrift: true } });
    if (!result.available) expect(result.reason).toContain("INDEX_SOURCE_UNVERIFIED");
    expect(await readFile(dbPath)).toEqual(before);
  });

  it("detects changes after the initial verification snapshot", async () => {
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    try {
      const initial = await verifyIndexSources(store, vault);
      expect(initial.available).toBe(true);
      if (!initial.available) return;
      expect(await indexSourcesUnchanged(initial.snapshot)).toBe(true);
      await writeFile(path.join(vault, "alpha.md"), EDITED);
      expect(await indexSourcesUnchanged(initial.snapshot)).toBe(false);
    } finally { store.close(); }
  });

  it("validates unchanged sources without reading Markdown bodies", async () => {
    const store = openEngineStoreCoreReadOnly(dbPath)!;
    const read = vi.mocked(fsPromises.readFile);
    read.mockClear();
    vi.mocked(fsPromises.open).mockClear();
    try {
      const verified = await verifyIndexSources(store, vault);
      expect(verified.available).toBe(true);
      if (verified.available) expect(await indexSourcesUnchanged(verified.snapshot)).toBe(true);
      expect(read.mock.calls.filter(([filename]) => String(filename).endsWith(".md"))).toHaveLength(0);
      expect(vi.mocked(fsPromises.open).mock.calls.filter(([filename]) => String(filename).endsWith(".md"))).toHaveLength(0);
    } finally { store.close(); }
  });

  it("rejects a source edit during reranking rather than hydrating an inconsistent preview", async () => {
    const engine = assembleCoreSemanticEngineReadOnly({ vault, dbPath, reranker: {
      async rerank(_query, candidates) {
        await writeFile(path.join(vault, "alpha.md"), EDITED);
        return candidates;
      },
    } })!;
    try {
      expect(await engine.adapter.semanticQuery({ query: "oldkeyword", rerank: true })).toMatchObject({
        available: false, hits: [], receipt: { indexDrift: true },
      });
    } finally { await engine.dispose(); }
  });

  it("reconciles newly excluded notes only on explicit synchronization", async () => {
    await mkdir(path.join(vault, "Templates"));
    await writeFile(path.join(vault, "Templates", "note.md"), "# Template\ntemplatekeyword\n");
    await syncEngineStore({ vault, dbPath, embed: false });
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
    expect(await query("templatekeyword")).toMatchObject({ available: false, receipt: { indexDrift: true } });
    await syncEngineStore({ vault, dbPath, embed: false });
    expect((await query("templatekeyword")).hits).toHaveLength(0);
    expect((await query("oldkeyword")).hits).toHaveLength(1);
  });

  it("refuses foreign preview bytes even when pathname metadata returns to its original state", async () => {
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    const note = path.join(vault, "alpha.md");
    vi.mocked(fsSync.readFileSync).mockImplementation((...args: Parameters<typeof fsSync.readFileSync>) =>
      String(args[0]) === note ? Buffer.from(EDITED) : original.readFileSync(...args));
    try {
      expect(await query("oldkeyword")).toMatchObject({ available: false, hits: [], receipt: { indexDrift: true } });
      expect(await readFile(note, "utf8")).toBe(ORIGINAL);
    } finally { vi.mocked(fsSync.readFileSync).mockImplementation(original.readFileSync); }
  });

  it.each(["missing-ns", "zero-inode", "coarse-time"])("uses byte verification when metadata is weak: %s", async weakness => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.stat).mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
      const info = await original.stat(...args);
      if (String(args[0]).endsWith(".md")) {
        if (weakness === "missing-ns") Object.defineProperty(info, "mtimeNs", { value: undefined });
        if (weakness === "zero-inode") Object.defineProperty(info, "ino", { value: 0n });
        if (weakness === "coarse-time") {
          Object.defineProperty(info, "mtimeNs", { value: 1_000_000_000n });
          Object.defineProperty(info, "ctimeNs", { value: 1_000_000_000n });
        }
      }
      return info;
    });
    try {
      const store = openEngineStoreCoreReadOnly(dbPath)!;
      try {
        const verified = await verifyIndexSources(store, vault);
        expect(verified.available).toBe(true);
        if (!verified.available) return;
        expect([...verified.snapshot.files.values()][0]).toMatch(/^bytes:/u);
        await writeFile(path.join(vault, "alpha.md"), EDITED);
        expect(await indexSourcesUnchanged(verified.snapshot)).toBe(false);
      } finally { store.close(); }
    } finally { vi.mocked(fsPromises.stat).mockImplementation(original.stat); }
  });

  it("keeps byte mode when handle metadata is weaker than pathname metadata", async () => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]).endsWith(".md")) {
        const handleStat = handle.stat.bind(handle);
        handle.stat = async (...options: Parameters<typeof handle.stat>) => {
          const info = await handleStat(...options);
          Object.defineProperty(info, "mtimeNs", { value: undefined });
          return info;
        };
      }
      return handle;
    });
    try {
      expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
      const store = openEngineStoreCoreReadOnly(dbPath)!;
      try {
        expect(store.readDocumentSources()!.get("alpha.md")!.fingerprint).toBeNull();
        const verified = await verifyIndexSources(store, vault);
        expect(verified.available).toBe(true);
        if (!verified.available) return;
        expect([...verified.snapshot.files.values()][0]).toMatch(/^bytes:/u);
        expect(await indexSourcesUnchanged(verified.snapshot)).toBe(true);
        await writeFile(path.join(vault, "alpha.md"), EDITED);
        expect(await indexSourcesUnchanged(verified.snapshot)).toBe(false);
      } finally { store.close(); }
    } finally { vi.mocked(fsPromises.open).mockImplementation(original.open); }
  });
});
