import { linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTracer, type TracerConfig } from "./tracer.js";
import * as embeddingProvider from "./embed/provider.js";

const scratch: string[] = [];

function temp(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function image(root: string): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isSymbolicLink()) {
        entries.push([relative, "symlink"]);
        continue;
      }
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, "directory"]);
        visit(filename);
        continue;
      }
      entries.push([relative, readFileSync(filename).toString("base64")]);
    }
  };
  visit(root);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function config(vaultPath: string, overrides: Partial<TracerConfig> = {}): TracerConfig {
  return {
    vaultPath,
    dbPath: path.join(path.dirname(vaultPath), "outside", "engine-store.sqlite"),
    embeddingProvider: "gguf",
    embeddingModel: path.join(vaultPath, "must-not-load.gguf"),
    embeddingDimensions: 4,
    files: ["note.md"],
    ...overrides,
  };
}

describe("runTracer explicit cache confinement", () => {
  it("rejects direct and aliased inside-vault store or cache overrides before loading a model", async () => {
    const parent = temp("oms-tracer-confine-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    writeFileSync(path.join(vault, "note.md"), "# Note\n");
    const directStore = path.join(vault, "engine-store.sqlite");
    const storeAlias = path.join(outside, "store-alias");
    symlinkSync(directStore, storeAlias);
    const directCache = path.join(vault, "cache");
    const cacheAlias = path.join(outside, "cache-alias");
    symlinkSync(directCache, cacheAlias);
    const before = image(parent);
    const provider = vi.spyOn(embeddingProvider, "requireRealEmbeddingProvider");

    await expect(runTracer(config(vault, { dbPath: directStore }), [])).rejects.toThrow(/inside the vault/);
    await expect(runTracer(config(vault, { dbPath: storeAlias }), [])).rejects.toThrow(/inside the vault/);
    await expect(runTracer(config(vault, { cacheDir: directCache }), [])).rejects.toThrow(/inside the vault/);
    await expect(runTracer(config(vault, { cacheDir: cacheAlias }), [])).rejects.toThrow(/inside the vault/);

    expect(provider).not.toHaveBeenCalled();
    expect(image(parent)).toEqual(before);
    expect(exists(directStore)).toBe(false);
    expect(exists(path.join(directCache, "engine"))).toBe(false);
    expect(exists(path.join(outside, "engine"))).toBe(false);
  });

  it("rejects a symlink graph leaf that routes into the vault without creating the cache", async () => {
    const parent = temp("oms-tracer-leaf-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(path.join(outside, "engine"), { recursive: true });
    mkdirSync(vault);
    writeFileSync(path.join(vault, "note.md"), "# Note\n");
    const leaf = path.join(outside, "engine", "graph.json");
    symlinkSync(path.join(vault, "not-yet.json"), leaf);
    const before = image(parent);

    await expect(runTracer(config(vault, { cacheDir: outside }), [])).rejects.toThrow(/inside the vault/);

    expect(image(parent)).toEqual(before);
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(() => realpathSync(leaf)).toThrow();
    expect(exists(path.join(vault, "not-yet.json"))).toBe(false);
  });

  it("accepts a lexical external cache override without writing before an empty file set returns", async () => {
    const parent = temp("oms-tracer-valid-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const cache = path.join(outside, "missing", "..", "cache");
    const before = image(parent);

    await expect(runTracer(config(vault, { files: [], cacheDir: cache, dbPath: path.join(outside, "engine-store.sqlite") }), [])).resolves.toEqual([]);

    expect(image(parent)).toEqual(before);
    expect(exists(path.resolve(cache))).toBe(false);
  });

  it("rejects an aliased store hard-linked to a vault file before loading a model or creating the cache", async () => {
    const parent = temp("oms-tracer-hardlink-");
    const vault = path.join(parent, "vault");
    const outside = path.join(parent, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    const sentinel = path.join(vault, "sentinel.md");
    writeFileSync(sentinel, "tracer hardlink sentinel\n");
    const vaultFile = path.join(vault, "linked.sqlite");
    writeFileSync(vaultFile, "vault inode\n");
    const dbPath = path.join(outside, "engine-store.sqlite");
    linkSync(vaultFile, dbPath);
    const alias = path.join(outside, "store-alias");
    symlinkSync(dbPath, alias);
    const before = image(parent);
    const provider = vi.spyOn(embeddingProvider, "requireRealEmbeddingProvider");

    await expect(runTracer(config(vault, { dbPath: alias }), [])).rejects.toThrow(/hard-linked/);

    expect(provider).not.toHaveBeenCalled();
    expect(image(parent)).toEqual(before);
    expect(lstatSync(dbPath).nlink).toBeGreaterThan(1);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel).toString()).toBe("tracer hardlink sentinel\n");
    expect(readFileSync(vaultFile).toString()).toBe("vault inode\n");
    expect(exists(path.join(outside, "engine"))).toBe(false);
    expect(exists(`${dbPath}.lock`)).toBe(false);
  });
});

function exists(filename: string): boolean {
  try {
    lstatSync(filename);
    return true;
  } catch {
    return false;
  }
}
