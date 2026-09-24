import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSavedNote, resolveVault } = vi.hoisted(() => ({
  checkSavedNote: vi.fn(async (request: { readonly evidencePaths?: readonly string[] }) => ({
    status: "pass",
    checkpoint: { evidencePaths: request.evidencePaths ?? [] },
    rejection: null,
  })),
  resolveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd" as const, scope: null })),
}));

vi.mock("../kernel/capture/check.js", () => ({ checkSavedNote }));
vi.mock("../kernel/link/link.js", () => ({ resolveEffectiveVault: resolveVault }));

import { noteUsage, runNoteCommand } from "./note-command.js";

const roots: string[] = [];
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-note-cli-"));
  roots.push(root);
  await mkdir(path.join(root, "notes"), { recursive: true });
  return root;
}

function output(): any {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  resolveVault.mockResolvedValue({ vault: process.cwd(), source: "cwd", scope: null });
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("note command", () => {
  it("documents every public leaf and rejects retired leaves with no alias", async () => {
    const usage = noteUsage();
    for (const verb of ["guide", "check", "audit", "get"]) expect(usage).toContain(verb);
    expect(usage).toContain("Leaves: guide | check | audit | get");
    expect(usage).not.toMatch(/\bcomplete\b/u);
    expect(usage).not.toContain("--evidence-path");
    expect(usage).not.toMatch(/\bcreate\b/u);
    expect(usage).not.toMatch(/\bappend\b/u);
    expect(usage).not.toMatch(/\bupdate\b/u);
    expect(usage).not.toMatch(/\bbackfill\b/u);

    for (const args of [["create"], ["append", "notes/a.md"], ["update", "notes/a.md"], ["backfill", "notes/a.md"], ["complete", "--checkpoint", "{}", "--review", "{}"]]) {
      await runNoteCommand(args);
      expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "NOTE_ARGS_INVALID" }] });
    }
    expect(checkSavedNote).not.toHaveBeenCalled();
  });

  it("guides without writing vault bytes", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "kept.md"), "unchanged\n");
    const before = await readdir(root, { recursive: true });
    await runNoteCommand(["guide", "--vault", root]);
    expect(["guided", "needs-path", "rejected"]).toContain(output().status);
    expect(await readdir(root, { recursive: true })).toEqual(before);
    expect(await import("node:fs/promises").then(fs => fs.readFile(path.join(root, "notes", "kept.md"), "utf8"))).toBe("unchanged\n");
    expect(checkSavedNote).not.toHaveBeenCalled();
  });

  it("forwards the note path, template, and binding on check without evidence arguments", async () => {
    const root = await vault();
    const binding = { schemaVersion: 1, notePath: "notes/one.md" };
    await runNoteCommand([
      "check", "notes/one.md", "--vault", root, "--template-id", "note",
      "--binding", JSON.stringify(binding),
    ]);
    expect(checkSavedNote).toHaveBeenCalledWith({
      target: { vault: root, source: "explicit" },
      notePath: "notes/one.md",
      templateId: "note",
      binding,
    });

    checkSavedNote.mockClear();
    await runNoteCommand([
      "check", "notes/one.md", "--vault", root, "--evidence-path", "notes/a.md",
    ]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "NOTE_ARGS_INVALID" }] });
    expect(checkSavedNote).not.toHaveBeenCalled();
  });

  it("refuses a cwd-inferred vault for guide and check", async () => {
    await runNoteCommand(["guide"]);
    expect(output()).toMatchObject({ status: "rejected", rejection: { code: "TARGET_UNVERIFIED" } });
    await runNoteCommand(["check", "notes/one.md"]);
    expect(output()).toMatchObject({ status: "rejected", rejection: { code: "TARGET_UNVERIFIED" } });
    expect(checkSavedNote).not.toHaveBeenCalled();
  });

  it("reads single, multi, and window documents without creating the engine store", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "a.md"), "one\ntwo\nthree\n");
    await writeFile(path.join(root, "notes", "b.md"), "other\n");

    await runNoteCommand(["get", "notes/a.md", "--vault", root]);
    expect(output()).toMatchObject({ available: true, documents: [{ path: "notes/a.md" }] });
    await runNoteCommand(["get", "notes/a.md", "notes/b.md", "--vault", root]);
    expect(output().documents).toHaveLength(2);
    await runNoteCommand(["get", "--note-path", "notes/a.md", "--from-line", "2", "--line-count", "1", "--vault", root]);
    expect(output().documents[0].content).toBe("two");
    expect(existsSync(path.join(root, ".oms", "engine-store.sqlite"))).toBe(false);
  });
});
