import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLiveDocumentId } from "./live-docid.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("live native document identifiers", () => {
  it("reads current notes without an index and rejects unsafe, missing, hidden, non-note, and excluded paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-live-docid-")); roots.push(root);
    const vault = path.join(root, "vault"); await mkdir(vault);
    await writeFile(path.join(vault, "note.md"), "# Note\nbody");
    expect(await readLiveDocumentId(vault, "note.md")).toEqual({ path: "note.md", content: "# Note\nbody" });
    await writeFile(path.join(vault, "plain.txt"), "text");
    for (const invalid of ["../outside.md", "./note.md", "folder//note.md", ".hidden.md", "node_modules/note.md", "plain.txt", "missing.md", "folder\\note.md", path.join(vault, "note.md")]) {
      expect(await readLiveDocumentId(vault, invalid), invalid).toBeNull();
    }
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(vault, "Templates"));
    await writeFile(path.join(vault, "Templates", "template.md"), "template");
    await writeFile(path.join(vault, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates" }));
    expect(await readLiveDocumentId(vault, "Templates/template.md")).toBeNull();
    await writeFile(path.join(root, "outside.md"), "outside");
    await symlink(path.join(root, "outside.md"), path.join(vault, "outside-link.md"));
    await symlink(path.join(vault, "note.md"), path.join(vault, "inside-link.md"));
    expect(await readLiveDocumentId(vault, "outside-link.md")).toBeNull();
    expect(await readLiveDocumentId(vault, "inside-link.md")).toBeNull();
  });
});
