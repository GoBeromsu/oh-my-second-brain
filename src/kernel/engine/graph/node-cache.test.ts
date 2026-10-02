import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraphSnapshot, loadNodeIndexForVault, nodeSourceSignature, saveNodeIndex } from "./builder.js";
import { McpEngineAdapter } from "../mcp/facade.js";
import { engineGraphCachePath, engineNodeCachePath } from "../paths.js";
import { readSearchTemplateSource } from "../retrieval/template-source.js";

const observed = vi.hoisted(() => ({
  reads: [] as string[],
  activeHandles: 0,
  peakHandles: 0,
  afterRead: undefined as ((file: string) => Promise<void>) | undefined,
  weak: undefined as "missing-ns" | "handle-missing-ns" | "after-handle-missing-ns" | "zero-inode" | "zero-device" | "coarse" | "path-zero-inode" | "path-coarse" | "path-weak" | undefined,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const platformStat = (info: Awaited<ReturnType<typeof actual.stat>>, handle = false) => {
    if (typeof info.size !== "bigint") return info;
    if (observed.weak === "missing-ns" || (handle && observed.weak === "handle-missing-ns")) Reflect.deleteProperty(info, "mtimeNs");
    if (observed.weak === "zero-device") Object.assign(info, { dev: 0n });
    if (!handle && observed.weak === "path-weak") Object.assign(info, { dev: 0n, ino: 0n, mtimeNs: 1_000_000n, ctimeNs: 1_000_000n });
    if (observed.weak === "zero-inode" || (!handle && observed.weak === "path-zero-inode")) Object.assign(info, { ino: 0n });
    if (observed.weak === "coarse" || (!handle && observed.weak === "path-coarse")) Object.assign(info, { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n });
    return info;
  };
  return { ...actual, readFile: vi.fn(actual.readFile),
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => platformStat(await actual.stat(...args))),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const ordinaryNote = String(args[0]).endsWith(".md");
      const originalClose = handle.close.bind(handle);
      if (ordinaryNote) {
        observed.activeHandles++;
        observed.peakHandles = Math.max(observed.peakHandles, observed.activeHandles);
      }
      handle.close = async () => {
        try { await originalClose(); }
        finally { if (ordinaryNote) observed.activeHandles--; }
      };
      const originalRead = handle.readFile.bind(handle);
      const originalStat = handle.stat.bind(handle);
      let handleStats = 0;
      handle.stat = (async (...options: Parameters<typeof handle.stat>) => {
        const info = platformStat(await originalStat(...options), true);
        if (observed.weak === "after-handle-missing-ns" && ++handleStats > 1) Reflect.deleteProperty(info, "ctimeNs");
        return info;
      }) as typeof handle.stat;
      handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
        const bytes = await originalRead(...options);
        const file = String(args[0]);
        if (file.endsWith(".md")) observed.reads.push(file);
        await observed.afterRead?.(file);
        return bytes;
      }) as typeof handle.readFile;
      return handle;
    }),
  };
});

let vault: string;
let cache: string;
let note: string;
const readFile = vi.mocked(fs.readFile);
const bodyReads = () => [...observed.reads, ...readFile.mock.calls.filter(([file]) => String(file).endsWith(".md"))];
const clearReads = () => { observed.reads = []; readFile.mockClear(); };

beforeEach(async () => {
  observed.reads = []; observed.afterRead = undefined; observed.weak = undefined;
  observed.activeHandles = 0; observed.peakHandles = 0;
  // Capture hooks compare the canonical paths used by confined source reads.
  vault = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "oms-node-witness-")));
  cache = path.join(vault, ".cache", "nodes.json");
  note = path.join(vault, "a.md");
  await fs.writeFile(note, "alpha");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(vault, { recursive: true, force: true }); });

async function buildCache() {
  const snapshot = await buildGraphSnapshot(vault);
  await saveNodeIndex(cache, snapshot.nodes, snapshot.sourceSignature, snapshot.meta.digest, snapshot.metadataSignature);
  clearReads();
  return snapshot;
}

async function load() { return loadNodeIndexForVault(cache, vault, await readSearchTemplateSource(vault)); }

describe("metadata-validated node caches", () => {
  it("bounds note handles to 32 while building a larger document snapshot", async () => {
    for (let index = 0; index < 128; index++) await fs.writeFile(path.join(vault, `note-${index}.md`), "alpha");
    const built = await buildGraphSnapshot(vault);
    expect(built.nodes).toHaveLength(129);
    expect(built.nodes.map(node => node.path)).toEqual(["a.md", ...Array.from({ length: 128 }, (_, index) => `note-${index}.md`)].sort((left, right) => left.localeCompare(right)));
    expect(built.sourceSignature).toBe(await nodeSourceSignature(vault, built.meta));
    expect(observed.peakHandles).toBeGreaterThan(1);
    expect(observed.peakHandles).toBeLessThanOrEqual(32);
    expect(observed.activeHandles).toBe(0);
  });

  it("stops new note reads and drains in-flight handles before rethrowing the first error", async () => {
    for (let index = 0; index < 128; index++) await fs.writeFile(path.join(vault, `note-${index}.md`), "alpha");
    const failure = new Error("injected note read failure");
    observed.afterRead = async file => {
      if (file === note) throw failure;
      await new Promise(resolve => setTimeout(resolve, 5));
    };
    let caught: unknown;
    let handlesAtRejection = -1;
    try { await buildGraphSnapshot(vault); }
    catch (error) { caught = error; handlesAtRejection = observed.activeHandles; }
    // Drain an unsafe implementation too, so a red regression cannot leak work
    // into the next test or delete its fixture while handles are still active.
    while (observed.activeHandles > 0) await new Promise(resolve => setTimeout(resolve, 5));
    expect(caught).toBe(failure);
    expect(handlesAtRejection).toBe(0);
    expect(observed.reads.length).toBeLessThanOrEqual(32);
    expect(observed.peakHandles).toBeLessThanOrEqual(32);
  });

  it("builds edges, nodes, and the exact byte signature from one note read", async () => {
    await fs.writeFile(note, Buffer.from([0x61, 0x80, 0xff]));
    clearReads();
    const built = await buildGraphSnapshot(vault);
    expect(bodyReads()).toHaveLength(1);
    expect(built.sourceSignature).toBe(await nodeSourceSignature(vault, built.meta));
    expect(built.nodes).toHaveLength(1);
  });

  it("reads no note bodies and never changes a warm cache or vault", async () => {
    const built = await buildCache();
    const before = await fs.stat(cache, { bigint: true });
    expect(await load()).toEqual(built.nodes);
    expect(await load()).toEqual(built.nodes);
    expect(bodyReads()).toEqual([]);
    expect(await fs.stat(cache, { bigint: true })).toMatchObject({ mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs, size: before.size });
    expect(await fs.readdir(vault)).toEqual([".cache", "a.md"]);
  });

  it.each(["missing-ns", "handle-missing-ns", "after-handle-missing-ns", "zero-inode", "zero-device", "coarse", "path-zero-inode", "path-coarse"] as const)("byte-validates %s metadata instead of trusting unknown stamps", async weak => {
    observed.weak = weak;
    const built = await buildCache();
    expect(built.metadataSignature).toBeNull();
    expect(await load()).toEqual(built.nodes);
    expect(bodyReads().length).toBeGreaterThan(0);
    await fs.writeFile(note, "bravo");
    await expect(load()).rejects.toThrow(/signature is stale/);
  });

  it.each([false, true])("rejects transient parent replacement with weak metadata=%s", async weak => {
    if (weak) observed.weak = "path-weak";
    await fs.mkdir(path.join(vault, "notes"));
    await fs.mkdir(path.join(vault, ".replacement"));
    await fs.rename(note, path.join(vault, "notes", "a.md"));
    note = path.join(vault, "notes", "a.md");
    await fs.writeFile(path.join(vault, ".replacement", "a.md"), "bravo");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let swapped = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) !== note || swapped) return original.open(...args);
      swapped = true;
      await fs.rename(path.join(vault, "notes"), path.join(vault, ".hold"));
      await fs.rename(path.join(vault, ".replacement"), path.join(vault, "notes"));
      const handle = await original.open(...args);
      await fs.rename(path.join(vault, "notes"), path.join(vault, ".replacement"));
      await fs.rename(path.join(vault, ".hold"), path.join(vault, "notes"));
      return handle;
    });
    await expect(buildGraphSnapshot(vault)).rejects.toThrow(/changed while being read/);
    expect(swapped).toBe(true);
    expect(await fs.readFile(note, "utf8")).toBe("alpha");
  });

  it("misses absent and old caches before walking notes, even with an invalid vault", async () => {
    const meta = await readSearchTemplateSource(vault);
    expect(await loadNodeIndexForVault(cache, path.join(vault, "missing"), meta)).toBeNull();
    await fs.mkdir(path.dirname(cache));
    await fs.writeFile(cache, JSON.stringify({ version: 4 }));
    expect(await loadNodeIndexForVault(cache, path.join(vault, "missing"), meta)).toBeNull();
    expect(bodyReads()).toEqual([]);
  });

  it("reuses byte-identical touches via the full hash without changing persisted state", async () => {
    const built = await buildCache();
    const before = await fs.readFile(cache, "utf8");
    await fs.utimes(note, new Date(0), new Date(0));
    expect(await load()).toEqual(built.nodes);
    expect(bodyReads().length).toBeGreaterThan(0);
    expect(await fs.readFile(cache, "utf8")).toBe(before);
  });

  it("detects a same-size edit with a restored mtime through ctime", async () => {
    await buildCache();
    const before = await fs.stat(note);
    await fs.writeFile(note, "bravo");
    await fs.utimes(note, before.atime, before.mtime);
    await expect(load()).rejects.toThrow(/signature is stale/);
    expect(bodyReads().length).toBeGreaterThan(0);
  });

  it.each(["rename", "add", "delete", "replace"])("rejects %s changes", async change => {
    await buildCache();
    if (change === "rename") await fs.rename(note, path.join(vault, "b.md"));
    if (change === "add") await fs.writeFile(path.join(vault, "b.md"), "bravo");
    if (change === "delete") await fs.unlink(note);
    if (change === "replace") {
      const before = await fs.stat(note);
      const replacement = path.join(vault, "replacement");
      await fs.writeFile(replacement, "bravo");
      await fs.utimes(replacement, before.atime, before.mtime);
      await fs.rename(replacement, note);
    }
    await expect(load()).rejects.toThrow(/signature is stale/);
  });

  it("checks projection and exclusions and preserves confined symlink handling", async () => {
    await buildCache();
    const meta = await readSearchTemplateSource(vault);
    await expect(loadNodeIndexForVault(cache, vault, { ...meta, digest: "sha256:other" })).rejects.toThrow(/stale/);
    await fs.mkdir(path.join(vault, ".oms"));
    await fs.writeFile(path.join(vault, ".oms", "settings.json"), JSON.stringify({ version: 1, vaultId: "11111111-1111-4111-8111-111111111111", templateFolder: "Templates" }));
    await fs.mkdir(path.join(vault, "Templates"));
    await fs.writeFile(path.join(vault, "Templates", "template.md"), "template");
    await expect(load()).rejects.toThrow(/stale/);
    await buildCache();
    await fs.writeFile(path.join(vault, "Templates", "template.md"), "changed excluded bytes");
    await fs.symlink(path.join(vault, "Templates", "template.md"), path.join(vault, "alias.md"));
    const updated = await readSearchTemplateSource(vault);
    clearReads();
    expect(await loadNodeIndexForVault(cache, vault, updated)).toHaveLength(1);
    expect(bodyReads()).toEqual([]);
    await fs.symlink(path.dirname(vault), path.join(vault, "escape"));
    await expect(load()).rejects.toThrow(/escapes the configured vault root/);
  });

  it.each(["witness", "nodes", "source", "json"])("keeps malformed current %s caches loud", async field => {
    await buildCache();
    const parsed = JSON.parse(await fs.readFile(cache, "utf8"));
    if (field === "witness") parsed.metadataSignature = 42;
    if (field === "nodes") parsed.nodes = [{}];
    if (field === "source") delete parsed.sourceSignature;
    await fs.writeFile(cache, field === "json" ? "{" : JSON.stringify(parsed));
    await expect(load()).rejects.toThrow(/invalid format|stale/);
    expect(bodyReads()).toEqual([]);
  });

  it("falls back to byte validation when a low-level writer has no witness", async () => {
    const built = await buildCache();
    await saveNodeIndex(cache, built.nodes, built.sourceSignature, built.meta.digest);
    expect(await load()).toEqual(built.nodes);
    expect(bodyReads()).toHaveLength(1);
  });

  it.each(["membership", "exclusions"])("rejects %s changing during a build", async change => {
    let changed = false;
    observed.afterRead = async file => {
      if (file === note && !changed) {
        changed = true;
        if (change === "membership") await fs.writeFile(path.join(vault, "b.md"), "bravo");
        else {
          await fs.mkdir(path.join(vault, ".obsidian"));
          await fs.writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
        }
      }
    };
    await expect(buildGraphSnapshot(vault)).rejects.toThrow(/changed (during graph build|while being read)/);
  });

  it("does not attest a partial document set when an exclusion control changes and reverts", async () => {
    await fs.mkdir(path.join(vault, "Notes"));
    await fs.writeFile(path.join(vault, "Notes", "b.md"), "bravo");
    await fs.mkdir(path.join(vault, ".obsidian"));
    const control = path.join(vault, ".obsidian", "templates.json");
    await fs.writeFile(control, "{}");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let controlReads = 0;
    readFile.mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === control && ++controlReads === 4) {
        await fs.writeFile(control, JSON.stringify({ folder: "Notes" }));
        const bytes = await original.readFile(...args);
        await fs.writeFile(control, "{}");
        return bytes;
      }
      return original.readFile(...args);
    });
    await expect(buildGraphSnapshot(vault)).rejects.toThrow(/changed (during graph build|while being read)/);
    expect(await fs.readFile(control, "utf8")).toBe("{}");
  });

  it("does not publish either cache when graphBuild detects a concurrent edit", async () => {
    const unused = vi.fn(() => { throw new Error("graphBuild must not need a model or store"); });
    const adapter = new McpEngineAdapter({
      store: { upsert: unused, queryLex: unused, queryVec: unused, close: unused },
      embed: { model: "unused", dimensions: 1, embed: unused, dispose: unused },
    }, vault);
    await adapter.graphBuild({}, vault);
    const graphCache = engineGraphCachePath(vault);
    const nodeCache = engineNodeCachePath(vault);
    const previousGraph = await fs.readFile(graphCache, "utf8");
    const previousNodes = await fs.readFile(nodeCache, "utf8");
    let changed = false;
    observed.afterRead = async file => {
      if (file === note && !changed) {
        changed = true;
        await fs.writeFile(note, "bravo");
      }
    };
    await expect(adapter.graphBuild({}, vault)).rejects.toThrow(/changed (during graph build|while being read)/);
    expect(await fs.readFile(graphCache, "utf8")).toBe(previousGraph);
    expect(await fs.readFile(nodeCache, "utf8")).toBe(previousNodes);
  });

  it("propagates note-read and broken-symlink failures during validation", async () => {
    await buildCache();
    await fs.utimes(note, new Date(0), new Date(0));
    observed.afterRead = async file => { if (file === note) throw new Error("note read failed"); };
    await expect(load()).rejects.toThrow("note read failed");
    await fs.symlink(path.join(vault, "missing"), path.join(vault, "broken.md"));
    await expect(load()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a build if a note changes after its captured body was read", async () => {
    let reads = 0;
    observed.afterRead = async file => {
      if (file === note && ++reads === 1) {
        await fs.writeFile(note, "bravo");
      }
    };
    await expect(buildGraphSnapshot(vault)).rejects.toThrow(/changed (during graph build|while being read)/);
    await expect(fs.access(cache)).rejects.toThrow();
  });
});
