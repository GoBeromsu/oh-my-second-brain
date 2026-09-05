import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineStorePath } from "../kernel/engine/paths.js";
import { runIndexFamilyCommand } from "./search.js";
import { runIndexCommand } from "./index-command.js";
import { parseSearchArgs } from "./search-args.js";

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

beforeEach(() => {
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("index family", () => {
  it("requires the closed repair mode and rejects retired leaves", async () => {
    const vault = await makeVault();
    for (const argv of [
      ["repair"],
      ["repair", "--mode=rebuild"],
      ["repair", "--mode", "rebuild", "--mode", "drop"],
      ["repair", "--mode", "other"],
      ["repair", "--mode", "rebuild", "extra"],
      ["sync", "--force"],
      ["sync", "--embed"],
      ["embed", "--force"],
      ["cleanup"],
      ["collections"],
      ["contexts"],
    ]) {
      await runIndexFamilyCommand([...argv, "--vault", vault]);
      expect(process.exitCode).toBe(1);
    }
  });

  it("rejects overlapping and cross-leaf flags before creating a vault store", async () => {
    for (const argv of [
      ["sync", "--embed"],
      ["sync", "--force"],
      ["embed", "--force"],
      ["embed", "--dry-run"],
      ["clean", "--mode", "rebuild"],
      ["repair", "--collection", "default", "--mode", "rebuild"],
      ["status", "--dry-run"],
      ["sync", "--unexpected"],
    ]) {
      const vault = await makeVault();
      await runIndexFamilyCommand([...argv, "--vault", vault]);
      expect(process.exitCode, argv.join(" ")).toBe(1);
      expect(existsSync(engineStorePath(vault)), argv.join(" ")).toBe(false);
    }
  });

  it("dry-run repair reports a plan for the verified target", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    await runIndexFamilyCommand(["repair", "--mode", "rebuild", "--dry-run", "--vault", vault]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({
      mode: "rebuild",
      dryRun: true,
      reindexRequired: true,
      backupPath: expect.any(String),
      resolvedVault: vault,
      resolutionSource: "explicit",
      receipt: {
        operation: "repair-index",
        resolvedVault: vault,
        resolutionSource: "explicit",
      },
    });
  });

  it("status is read-only and does not create a missing store", async () => {
    const vault = await makeVault();
    await rm(path.join(vault, ".oms"), { recursive: true });
    await runIndexFamilyCommand(["status", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(engineStorePath(vault))).toBe(false);
    expect(console.error).toHaveBeenCalledWith("No engine store; run `oms index sync`.");
  });

  it("quotes the verified repair command for a corrupt store", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    await runIndexFamilyCommand(["status", "--vault", vault]);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("oms index repair --mode rebuild"));
  });

  it("retains the explicit rebuild repair capability", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    await runIndexFamilyCommand(["repair", "--mode", "rebuild", "--vault", vault]);
    expect(process.exitCode).toBe(0);

    vi.mocked(console.error).mockClear();
    await runIndexFamilyCommand(["status", "--vault", vault]);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("oms index repair --mode rebuild"),
    );
  });

  it("rejects a cwd-inferred repair without changing the target", async () => {
    const vault = await makeVault();
    createCorruptStore(vault);
    const before = new Uint8Array(await readFile(engineStorePath(vault)));
    const write = vi.fn();
    const writeError = vi.fn();

    const code = await runIndexCommand({
      args: parseSearchArgs(["index", "repair", "--mode", "drop"]),
      vault,
      source: "cwd",
      write,
      writeError,
    });

    expect(code).toBe(1);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"status": "rejected"'));
    expect(writeError).not.toHaveBeenCalled();
    expect(new Uint8Array(await readFile(engineStorePath(vault)))).toEqual(before);
  });
});
