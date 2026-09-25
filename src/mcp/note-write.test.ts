import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteNote } from "./note-write.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "oms-note-write-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteNote", () => {
  it("creates a new note and its folder under the umask, 0644 at most", async () => {
    const target = path.join(dir, "Projects", "a.md");
    expect(await atomicWriteNote(target, "new", undefined)).toBe("written");
    expect(await readFile(target, "utf8")).toBe("new");
    const umask = process.umask();
    expect((await stat(target)).mode & 0o777).toBe(0o644 & ~umask);
    expect((await stat(path.dirname(target))).mode & 0o777).toBe(0o777 & ~umask);
    expect(await readdir(path.dirname(target))).toEqual(["a.md"]);
  });

  it("keeps an existing note's mode on overwrite", async () => {
    const target = path.join(dir, "a.md");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    expect(await atomicWriteNote(target, "next", "old")).toBe("written");
    expect(await readFile(target, "utf8")).toBe("next");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("refuses to overwrite a note that changed after judging and leaves no temporary file", async () => {
    const target = path.join(dir, "a.md");
    await writeFile(target, "edited meanwhile");
    expect(await atomicWriteNote(target, "next", "judged")).toBe("changed");
    expect(await readFile(target, "utf8")).toBe("edited meanwhile");
    expect(await readdir(dir)).toEqual(["a.md"]);
  });

  it("refuses to replace a note that appeared after a new-note verdict", async () => {
    const target = path.join(dir, "a.md");
    await writeFile(target, "someone else");
    expect(await atomicWriteNote(target, "mine", undefined)).toBe("changed");
    expect(await readFile(target, "utf8")).toBe("someone else");
    expect(await readdir(dir)).toEqual(["a.md"]);
  });

  it("reports a note removed after judging instead of recreating it", async () => {
    const target = path.join(dir, "a.md");
    expect(await atomicWriteNote(target, "next", "judged")).toBe("vanished");
    expect(await atomicWriteNote(target, "next", null)).toBe("vanished");
    expect(await readdir(dir)).toEqual([]);
  });
});
