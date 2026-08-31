import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lazyLoadNoteBody } from "./cache.js";

const vaults: string[] = [];

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-lazy-note-"));
  vaults.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(vaults.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("lazyLoadNoteBody", () => {
  it("returns the confined vault-relative path and markdown body", async () => {
    const root = await vault({ "notes/example.md": "---\ntemplate: note\n---\nNote body\n" });

    await expect(lazyLoadNoteBody(root, "notes/example.md")).resolves.toEqual({
      path: "notes/example.md",
      body: "Note body\n",
    });
  });

  it("rejects a path traversal before reading outside the vault", async () => {
    const root = await vault({ "notes/example.md": "body" });

    await expect(lazyLoadNoteBody(root, "../outside.md")).rejects.toThrow("unsafe path segments");
  });

  it("rejects a missing note", async () => {
    const root = await vault({});

    await expect(lazyLoadNoteBody(root, "notes/missing.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create graph cache state", async () => {
    const root = await vault({ "notes/example.md": "body" });

    await lazyLoadNoteBody(root, "notes/example.md");
    await expect(lazyLoadNoteBody(root, ".oms/cache/graph.md")).rejects.toThrow("hidden");
  });
});
