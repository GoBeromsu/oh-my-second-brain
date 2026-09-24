import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkContract, selectContract, resolveVault } = vi.hoisted(() => ({
  checkContract: vi.fn(async (input: { readonly locator: { readonly connectionId: string; readonly sessionId: string } }) => ({
    locator: input.locator,
    notePath: "notes/one.md",
    result: { valid: true, structural: "pass", semantic: "not-evaluated", violations: [] },
  })),
  selectContract: vi.fn(async (input: { readonly notePath: string; readonly templateId: string | null }) => ({
    state: "selected",
    locator: { connectionId: "c", sessionId: "s" },
    notePath: input.notePath,
    selected: { binding: { templateId: input.templateId } },
  })),
  resolveVault: vi.fn(async () => ({ vault: process.cwd(), source: "cwd" as const, scope: null })),
}));

vi.mock("../kernel/templates/service.js", () => ({
  checkContract,
  selectContract,
  ContractServiceError: class extends Error {
    constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
  },
}));
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
    expect(checkContract).not.toHaveBeenCalled();
    expect(selectContract).not.toHaveBeenCalled();
  });

  it("selects a contract for the saved path without writing vault bytes", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "kept.md"), "unchanged\n");
    const before = await readdir(root, { recursive: true });
    await runNoteCommand(["guide", "notes/one.md", "--vault", root, "--template-id", "note"]);
    expect(output()).toMatchObject({ state: "selected", notePath: "notes/one.md" });
    expect(selectContract).toHaveBeenCalledWith({
      target: { vault: root, source: "explicit" },
      notePath: "notes/one.md",
      templateId: "note",
    });
    expect(await readdir(root, { recursive: true })).toEqual(before);
    expect(await import("node:fs/promises").then(fs => fs.readFile(path.join(root, "notes", "kept.md"), "utf8"))).toBe("unchanged\n");
    expect(checkContract).not.toHaveBeenCalled();
  });

  it("checks through the selection locator and refuses retired check arguments", async () => {
    const root = await vault();
    await runNoteCommand(["check", "--vault", root, "--connection-id", "c", "--session-id", "s"]);
    expect(checkContract).toHaveBeenCalledWith({ vault: root, locator: { connectionId: "c", sessionId: "s" } });
    expect(output()).toMatchObject({ result: { structural: "pass", semantic: "not-evaluated" } });

    checkContract.mockClear();
    await runNoteCommand(["check", "notes/one.md", "--vault", root, "--template-id", "note"]);
    expect(output()).toMatchObject({ status: "rejected", diagnostics: [{ code: "NOTE_ARGS_INVALID" }] });
    expect(checkContract).not.toHaveBeenCalled();
  });

  it("refuses a cwd-inferred vault for guide and check", async () => {
    await runNoteCommand(["guide", "notes/one.md"]);
    expect(output()).toMatchObject({ status: "rejected", rejection: { code: "TARGET_UNVERIFIED" } });
    await runNoteCommand(["check", "--connection-id", "c", "--session-id", "s"]);
    expect(output()).toMatchObject({ status: "rejected", rejection: { code: "TARGET_UNVERIFIED" } });
    expect(checkContract).not.toHaveBeenCalled();
    expect(selectContract).not.toHaveBeenCalled();
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
