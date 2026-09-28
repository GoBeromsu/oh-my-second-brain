import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interviewUsage, runInterviewCommand } from "./interview-command.js";

let savedEnv: Record<string, string | undefined>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let home: string;

function stderr(): string {
  return error.mock.calls.map(call => String(call[0])).join("\n");
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
  home = await realpath(await mkdtemp(path.join(tmpdir(), "oms-interview-home-")));
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
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
  await rm(home, { recursive: true, force: true });
});

describe("oms interview", () => {
  it("prints usage for --help", async () => {
    await runInterviewCommand(["--help"]);
    expect(process.exitCode).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe(interviewUsage());
  });

  it("rejects unknown, duplicate and valueless arguments", async () => {
    for (const [argv, message] of [
      [["--answers", "a.json"], "interview: unknown argument --answers"],
      [["--reask", "--reask"], "interview: duplicate flag --reask"],
      [["--vault"], "interview: --vault requires a value"],
      [["--vault", "a", "--vault", "b"], "interview: duplicate flag --vault"],
    ] as const) {
      error.mockClear();
      await runInterviewCommand(argv, { interactive: true });
      expect(process.exitCode, argv.join(" ")).toBe(1);
      expect(stderr()).toContain(message);
    }
  });

  it("refuses to run without an interactive terminal and seals nothing", async () => {
    await runInterviewCommand(["--vault", home], { interactive: false });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("oms interview needs an interactive terminal");
    expect(stderr()).toContain("oms setup --questions");
    expect(await readdir(home)).toEqual([]);
  });

  it("refuses under OMS_NON_INTERACTIVE=1 when no terminal decision is injected", async () => {
    process.env["OMS_NON_INTERACTIVE"] = "1";
    await runInterviewCommand(["--vault", home]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("OMS_NON_INTERACTIVE unset");
    expect(await readdir(home)).toEqual([]);
  });
});
