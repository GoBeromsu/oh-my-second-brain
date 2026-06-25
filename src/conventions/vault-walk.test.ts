import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  VAULT_SKIP_DIRS,
  walkVaultMarkdown,
  mapWithConcurrency,
} from "./vault-walk.js";

async function makeVault(
  files: Record<string, string>,
): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "oms-walk-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(vaultPath, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return { vaultPath, cleanup: () => rm(vaultPath, { recursive: true, force: true }) };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of gen) out.push(p);
  return out.sort();
}

describe("walkVaultMarkdown", () => {
  it("yields nested markdown as POSIX relative paths", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "a.md": "x",
      "sub/b.md": "x",
      "sub/deep/c.md": "x",
      "not-a-note.txt": "x",
    });
    try {
      expect(await collect(walkVaultMarkdown(vaultPath))).toEqual([
        "a.md",
        "sub/b.md",
        "sub/deep/c.md",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("skips VAULT_SKIP_DIRS and dotfiles by default", async () => {
    const files: Record<string, string> = { "keep.md": "x" };
    for (const dir of VAULT_SKIP_DIRS) files[`${dir}/buried.md`] = "x";
    files[".hidden/secret.md"] = "x";
    const { vaultPath, cleanup } = await makeVault(files);
    try {
      expect(await collect(walkVaultMarkdown(vaultPath))).toEqual(["keep.md"]);
    } finally {
      await cleanup();
    }
  });

  it("matches .md case-insensitively", async () => {
    const { vaultPath, cleanup } = await makeVault({ "Upper.MD": "x", "lower.md": "x" });
    try {
      expect(await collect(walkVaultMarkdown(vaultPath))).toEqual(["Upper.MD", "lower.md"]);
    } finally {
      await cleanup();
    }
  });

  it("honors a custom skip set", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "keep.md": "x",
      "node_modules/dep.md": "x",
      "_archive/old.md": "x",
    });
    try {
      // Only skip node_modules → _archive is now included.
      const result = await collect(
        walkVaultMarkdown(vaultPath, { skip: new Set(["node_modules"]) }),
      );
      expect(result).toEqual(["_archive/old.md", "keep.md"]);
    } finally {
      await cleanup();
    }
  });

  it("can include dotfile dirs when skipDotfiles is false", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "keep.md": "x",
      ".obsidian-notes/n.md": "x",
    });
    try {
      const result = await collect(
        walkVaultMarkdown(vaultPath, { skip: new Set(), skipDotfiles: false }),
      );
      expect(result).toEqual([".obsidian-notes/n.md", "keep.md"]);
    } finally {
      await cleanup();
    }
  });

  it("returns nothing for a missing directory instead of throwing", async () => {
    expect(await collect(walkVaultMarkdown("/no/such/vault/xyz"))).toEqual([]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const items = [50, 10, 30, 0, 20];
    const result = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(result).toEqual([100, 20, 60, 0, 40]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });

  it("processes every item with limit greater than length", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 64, async (n) => n + 1);
    expect(result).toEqual([2, 3, 4]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
