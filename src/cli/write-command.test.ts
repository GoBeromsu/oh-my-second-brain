import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../test/fixtures/contract-truth-table.js";
import { runWriteCommand, writeUsage } from "./write-command.js";

const fixtures: TruthTableFixture[] = [];
const scratch: string[] = [];
let savedEnv: Record<string, string | undefined>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

async function sealedVault(): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow("sealed");
  fixtures.push(fixture);
  const home = path.join(fixture.base, "home");
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  return fixture;
}

function receipt(): Record<string, unknown> {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

function stderr(): string {
  return error.mock.calls.map(call => String(call[0])).join("\n");
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("oms write", () => {
  it("prints usage for --help without reading stdin", async () => {
    const readStdin = vi.fn(async () => "never read");
    await runWriteCommand(["--help"], { readStdin });
    expect(process.exitCode).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe(writeUsage());
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("rejects argument errors before reading stdin", async () => {
    const readStdin = vi.fn(async () => "x\n");
    for (const [argv, message] of [
      [["note.md", "--force"], "unknown write option --force"],
      [[], "write requires a vault-relative note path"],
      [["a.md", "b.md"], "write takes exactly one note path"],
      [["a.md", "--template"], "--template requires a value"],
      [["a.md", "--vault", "x", "--vault", "y"], "--vault may be specified only once"],
    ] as const) {
      error.mockClear();
      await runWriteCommand(argv, { readStdin, env: {} });
      expect(process.exitCode, argv.join(" ")).toBe(1);
      expect(stderr()).toContain(message);
    }
    expect(readStdin).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a vault inferred from the current directory and writes nothing", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-write-cwd-")));
    scratch.push(cwd);
    process.env["HOME"] = cwd;
    process.env["USERPROFILE"] = cwd;
    await runWriteCommand(["Projects/a.md"], { cwd, env: {}, readStdin: async () => "Body\n" });
    expect(process.exitCode).toBe(1);
    expect(receipt()).toMatchObject({ ok: false, status: "rejected", rejection: { code: "target-unverified" } });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("denies a note the sealed contract forbids and leaves disk untouched", async () => {
    const fixture = await sealedVault();
    const before = await readdir(fixture.vault);
    await runWriteCommand(["Loose/a.md", "--vault", fixture.vault], { env: {}, readStdin: async () => "x\n" });
    expect(process.exitCode).toBe(1);
    expect(receipt()).toMatchObject({ ok: false, violations: [{ field: "path", kind: "unregistered-folder" }] });
    expect(await readdir(fixture.vault)).toEqual(before);
  });

  it("does not overwrite an existing note when the edit is denied", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Loose"));
    await writeFile(path.join(fixture.vault, "Loose", "a.md"), "original\n");
    await runWriteCommand(["Loose/a.md", "--vault", fixture.vault], { env: {}, readStdin: async () => "changed\n" });
    expect(process.exitCode).toBe(1);
    expect(await readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).toBe("original\n");
  });

  it("writes an allowed note through the verified-target kernel", async () => {
    const fixture = await sealedVault();
    await runWriteCommand(["Projects/a.md", "--vault", fixture.vault], { env: {}, readStdin: async () => "Body\n" });
    expect(process.exitCode).toBe(0);
    expect(receipt()).toMatchObject({ ok: true, path: "Projects/a.md", missingDefaults: [] });
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("Body\n");
  });

  it("uses OMS_VAULT from the injected environment as a verified target", async () => {
    const fixture = await sealedVault();
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-write-cwd-")));
    scratch.push(cwd);
    await runWriteCommand(["Projects/b.md"], { cwd, env: { OMS_VAULT: fixture.vault }, readStdin: async () => "B\n" });
    expect(process.exitCode).toBe(0);
    expect(await readFile(path.join(fixture.vault, "Projects", "b.md"), "utf8")).toBe("B\n");
    expect(await readdir(cwd)).toEqual([]);
  });
});
