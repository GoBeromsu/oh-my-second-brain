import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveLexicalSession } from "./live-lexical.js";
import type { DetachedLexicalStore } from "./store.js";
import { indexSourcesUnchanged } from "./freshness.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
  ["memory", undefined, "grow"], ["disk", 1, "grow"],
  ["memory", undefined, "same"], ["disk", 1, "same"],
  ["memory", undefined, "empty"], ["disk", 1, "empty"],
] as const)("rolls back a failed captured document publication in the private %s store (%s bytes, %s edit)", async (_kind, maxMemoryBytes, edit) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-private-transaction-")));
  const vault = path.join(root, "vault");
  const temporary = path.join(root, "temporary");
  const dbPath = path.join(root, "persistent.sqlite");
  await mkdir(vault); await mkdir(temporary); vi.stubEnv("TMPDIR", temporary);
  const original = "# Original\noldkeyword\n";
  const filename = path.join(vault, "note.md");
  await writeFile(filename, original);
  const session = new LiveLexicalSession({ vault, dbPath, maxMemoryBytes });
  try {
    const prepared = await session.prepare(vault, ["oldkeyword"], 20);
    const current = (session as unknown as { current: DetachedLexicalStore }).current;
    const before = {
      hits: current.store.queryLex("oldkeyword", 20),
      shas: current.store.getShas("note.md"),
      sources: current.store.readDocumentSources(),
    };
    const changed = edit === "empty" ? "" : "# Replacement\nnewkeyword\n" + (edit === "grow" ? "newkeyword new content\n".repeat(600) : "");
    await writeFile(filename, changed);
    const fault = new Error("injected source publication failure");
    vi.spyOn(current.store, "recordDocumentSource").mockImplementationOnce(() => { throw fault; });
    await expect(session.prepare(vault, ["newkeyword"], 20)).rejects.toBe(fault);
    expect(current.store.queryLex("oldkeyword", 20)).toEqual(before.hits);
    expect(current.store.queryLex("newkeyword", 20)).toEqual([]);
    expect(current.store.getShas("note.md")).toEqual(before.shas);
    expect(current.store.readDocumentSources()).toEqual(before.sources);
    expect(prepared.store.queryLex("oldkeyword", 20)).toEqual(before.hits);
    expect(await indexSourcesUnchanged(prepared.snapshot)).toBe(false);
    const retry = await session.prepare(vault, ["newkeyword"], 20);
    expect(retry.store.queryLex("newkeyword", 20).length).toBe(edit === "empty" ? 0 : current.store.getShas("note.md").size);
    expect(current.store.queryLex("oldkeyword", 20)).toEqual([]);
    expect(current.store.readDocumentSources()?.has("note.md")).toBe(true);
    expect(await indexSourcesUnchanged(retry.snapshot)).toBe(true);
    expect(await readFile(filename, "utf8")).toBe(changed);
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(vault, ".oms"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    try { await session.dispose(); expect(await readdir(temporary)).toEqual([]); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
