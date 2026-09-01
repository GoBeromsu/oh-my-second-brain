import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineStorePath } from "../kernel/engine/paths.js";
import { runSearchCli } from "./search.js";

const roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = path.join(tmpdir(), `oms-index-command-${crypto.randomUUID()}`);
  await mkdir(path.join(vault, ".oms"), { recursive: true });
  roots.push(vault);
  return vault;
}

function createCorruptStore(vault: string): void {
  const db = new Database(engineStorePath(vault));
  try {
    db.exec("CREATE TABLE engine_meta (id INTEGER PRIMARY KEY);");
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("oms index repair", () => {
  it("requires the space-form closed mode enum with no duplicate or positional values", async () => {
    const vault = await makeVault();
    for (const argv of [
      ["index", "repair"],
      ["index", "repair", "--mode=rebuild"],
      ["index", "repair", "--mode", "rebuild", "--mode", "drop"],
      ["index", "repair", "--mode", "other"],
      ["index", "repair", "--mode", "rebuild", "extra"],
    ]) {
      const writeError = vi.fn();
      expect(await runSearchCli({ argv, vault, write: vi.fn(), writeError })).toBe(1);
      expect(writeError).toHaveBeenCalled();
    }
  });

  it("accepts --dry-run and reports the repair plan without opening the store", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    const write = vi.fn();
    expect(await runSearchCli({
      argv: ["index", "repair", "--mode", "rebuild", "--dry-run"],
      vault,
      write,
      writeError: vi.fn(),
    })).toBe(0);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      mode: "rebuild",
      dryRun: true,
      reindexRequired: true,
      backupPath: expect.any(String),
    });
  });

  it("quotes the rebuild command when status detects a corrupt legacy store", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    const writeError = vi.fn();
    expect(await runSearchCli({ argv: ["index", "status"], vault, write: vi.fn(), writeError })).toBe(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("oms index repair --mode rebuild"));
  });

  it("removes the corrupt-store status failure after rebuild", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    expect(await runSearchCli({
      argv: ["index", "repair", "--mode", "rebuild"],
      vault,
      write: vi.fn(),
      writeError: vi.fn(),
    })).toBe(0);
    const writeError = vi.fn();
    await runSearchCli({ argv: ["index", "status"], vault, write: vi.fn(), writeError });
    expect(writeError).not.toHaveBeenCalledWith(expect.stringContaining("oms index repair --mode rebuild"));
  }, 15_000);

  it("reports a missing store after drop and directs the user to sync", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    expect(await runSearchCli({
      argv: ["index", "repair", "--mode", "drop"],
      vault,
      write: vi.fn(),
      writeError: vi.fn(),
    })).toBe(0);

    const writeError = vi.fn();
    expect(await runSearchCli({ argv: ["index", "status"], vault, write: vi.fn(), writeError })).toBe(1);
    expect(writeError).toHaveBeenCalledWith("No engine store; run `oms index sync`.");
  });
});
