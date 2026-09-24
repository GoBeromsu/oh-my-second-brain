import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineAxisCachePath } from "../paths.js";
import { axisStorePath, collectVaultAxisObservations, openVaultAxisStore } from "./store.js";

const roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-axis-store-"));
  roots.push(vault);
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "note.md"), "---\ntitle: Indexed note\n---\nSee [[other]]\n");
  return vault;
}

async function relativeTree(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else found.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  await visit(root);
  return found.sort();
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("axis store cache owner", () => {
  it("routes the default axis database through the external cache owner", () => {
    const vault = path.join(tmpdir(), "oms-axis-uncreated");
    expect(axisStorePath(vault)).toBe(engineAxisCachePath(vault));
    expect(contained(vault, axisStorePath(vault))).toBe(false);
  });

  it("does not create external or vault artifacts on a read miss", async () => {
    const vault = await makeVault();
    const databasePath = axisStorePath(vault);
    const before = await relativeTree(vault);
    const externalBefore = await relativeTree(path.dirname(databasePath));

    expect(() => openVaultAxisStore(vault, { readonly: true })).toThrow();

    expect(await relativeTree(vault)).toEqual(before);
    expect(await relativeTree(path.dirname(databasePath))).toEqual(externalBefore);
    await expect(access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(vault, ".oms", "cache", "axes.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates only the external derived database on explicit synchronization", async () => {
    const vault = await makeVault();
    const databasePath = axisStorePath(vault);
    const before = await relativeTree(vault);
    const store = await collectVaultAxisObservations(vault);
    try {
      expect(store.dbPath).toBe(databasePath);
      expect(contained(vault, store.dbPath)).toBe(false);
      expect(store.list({ notePath: "notes/note.md" }).map((observation) => observation.axisKind).sort()).toEqual(["field", "folder", "link"]);
      expect(store.sourceSignature()).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      store.close();
    }

    expect(await access(databasePath).then(() => true, () => false)).toBe(true);
    expect(await relativeTree(vault)).toEqual(before);
    await expect(access(path.join(vault, ".oms", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
