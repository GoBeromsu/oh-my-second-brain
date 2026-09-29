import { appendFile, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewIO, Question } from "../kernel/contract/interview.js";
import { EVENTS_FILE, pendingLogKey, readInterviewLog } from "../kernel/contract/interview-log.js";
import { stateDir } from "../kernel/contract/state-dir.js";
import { readStore } from "../kernel/contract/store.js";
import { resolveSealState } from "../kernel/contract/vault-id.js";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../kernel/vault/settings.js";
import { interviewUsage, runInterviewCommand } from "./interview-command.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_800_000_000_000;
const ANSWERS: Readonly<Record<string, string>> = {
  "template-folder:path": "",
  "folder:Projects:register": "yes",
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": "no",
  seal: "yes",
};

class Interrupted extends Error {}

/** Answers from ANSWERS and is closed (Ctrl-C) when asked its question number `stopAt`. */
function owner(stopAt = Number.POSITIVE_INFINITY): { readonly io: InterviewIO; readonly asked: string[] } {
  const asked: string[] = [];
  const io: InterviewIO = {
    say: () => undefined,
    ask: async (question: Question) => {
      if (asked.length + 1 >= stopAt) throw new Interrupted(question.id);
      asked.push(question.id);
      return ANSWERS[question.id] ?? null;
    },
  };
  return { io, asked };
}

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

/** The command reports the closed terminal as a failed run instead of throwing it. */
async function interrupted(run: Promise<void>): Promise<void> {
  await run;
  expect(process.exitCode).toBe(1);
}

async function makeVault(): Promise<{ readonly vault: string; readonly root: string }> {
  const vault = path.join(home, "vault");
  await mkdir(path.join(vault, "Projects"), { recursive: true });
  await mkdir(path.join(vault, ".oms"));
  await writeFile(path.join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
  await writeFile(path.join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
  return { vault, root: path.join(home, ".oms", "vaults") };
}

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
      [["--vault", "--restart"], "interview: --vault requires a value"],
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

  it("rejects a duplicate --restart", async () => {
    await runInterviewCommand(["--restart", "--restart"], { interactive: true });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("interview: duplicate flag --restart");
  });

  it("continues an interrupted interview from its logged answers", async () => {
    const { vault, root } = await makeVault();
    const resume = { root, now: () => NOW, sealDeps: { now: () => NOW } };
    const first = owner(3);
    await interrupted(runInterviewCommand(["--vault", vault], { io: first.io, resume }));
    expect(first.asked).toHaveLength(2);
    error.mockClear();
    expect((await readStore(VAULT_ID, root)).state).toBe("absent");

    const second = owner();
    await runInterviewCommand(["--vault", vault], { io: second.io, resume });
    expect(process.exitCode).toBe(0);
    for (const id of first.asked) expect(second.asked).not.toContain(id);
    expect(stderr()).toContain("Continuing the interview with 2 earlier answer(s)");
    expect((await readStore(VAULT_ID, root)).state).toBe("ok");
    expect(await readlink(path.join(root, VAULT_ID))).toBe(`.${VAULT_ID}.1`);
    expect((await readInterviewLog(root, VAULT_ID)).events.at(-1)?.type).toBe("sealed");
  });

  it("counts unreadable lines in the pending log as well as the vault id log", async () => {
    const { vault, root } = await makeVault();
    const resume = { root, now: () => NOW, sealDeps: { now: () => NOW } };
    await interrupted(runInterviewCommand(["--vault", vault], { io: owner(3).io, resume }));
    await appendFile(path.join(stateDir(root, VAULT_ID), "interview", EVENTS_FILE), "{not json\n");
    const pending = path.join(stateDir(root, await pendingLogKey(vault)), "interview");
    await mkdir(pending, { recursive: true });
    await appendFile(path.join(pending, EVENTS_FILE), "{not json\n");
    error.mockClear();
    await runInterviewCommand(["--vault", vault], { io: owner().io, resume });
    expect(stderr()).toContain("The interview log has 2 unreadable line(s)");
  });

  it("starts over with --restart after logging the run as abandoned", async () => {
    const { vault, root } = await makeVault();
    const resume = { root, now: () => NOW, sealDeps: { now: () => NOW } };
    await interrupted(runInterviewCommand(["--vault", vault], { io: owner(3).io, resume }));
    error.mockClear();

    const again = owner();
    await runInterviewCommand(["--restart", "--vault", vault], { io: again.io, resume });
    expect(process.exitCode).toBe(0);
    expect(again.asked).toContain("template-folder:path");
    expect(stderr()).not.toContain("Continuing the interview");
    const types = (await readInterviewLog(root, VAULT_ID)).events.map(event => event.type);
    expect(types).toContain("abandoned");
    expect(types.at(-1)).toBe("sealed");
    expect((await readStore(VAULT_ID, root)).state).toBe("ok");
  });

  it("reads --restart after a --vault value as the restart flag", async () => {
    const { vault, root } = await makeVault();
    const resume = { root, now: () => NOW, sealDeps: { now: () => NOW } };
    await interrupted(runInterviewCommand(["--vault", vault], { io: owner(3).io, resume }));
    error.mockClear();
    await runInterviewCommand(["--vault", vault, "--restart"], { io: owner().io, resume });
    expect(process.exitCode).toBe(0);
    expect(stderr()).not.toContain("Continuing the interview");
    expect((await readInterviewLog(root, VAULT_ID)).events.map(event => event.type)).toContain("abandoned");
  });

  it("logs a fresh vault under its pending key, writes nothing into it before the seal, and mints the id at seal", async () => {
    const vault = path.join(home, "fresh");
    await mkdir(path.join(vault, "Projects"), { recursive: true });
    await writeFile(path.join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
    const root = path.join(home, ".oms", "vaults");
    const resume = { root, now: () => NOW, sealDeps: { now: () => NOW } };
    const pending = await pendingLogKey(vault);

    const first = owner(3);
    await interrupted(runInterviewCommand(["--vault", vault], { io: first.io, resume }));
    expect((await readInterviewLog(root, pending)).events.filter(event => event.type === "answered").map(event => event.questionId)).toEqual(first.asked);
    await interrupted(runInterviewCommand(["--vault", vault, "--restart"], { io: owner(2).io, resume }));
    expect((await readInterviewLog(root, pending)).events.map(event => event.type)).toContain("abandoned");
    await expect(stat(path.join(vault, ".oms"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await resolveSealState(vault, root)).row).toBe("never-sealed");
    error.mockClear();

    const last = owner();
    await runInterviewCommand(["--vault", vault], { io: last.io, resume });
    expect(process.exitCode).toBe(0);
    expect(stderr()).toContain("Continuing the interview with 1 earlier answer(s)");
    const vaultId = (await readVaultSettings(vault))!.vaultId;
    expect((await resolveSealState(vault, root)).row).toBe("sealed");
    const types = (await readInterviewLog(root, vaultId)).events.map(event => event.type);
    expect(types).toContain("abandoned");
    expect(types.at(-1)).toBe("sealed");
    expect(await readInterviewLog(root, pending)).toEqual({ events: [], corrupt: [] });
  });

  it("still refuses under OMS_NON_INTERACTIVE=1 with a logged run, and logs nothing", async () => {
    const { vault, root } = await makeVault();
    const resume = { root, now: () => NOW };
    await interrupted(runInterviewCommand(["--vault", vault], { io: owner(3).io, resume }));
    const before = (await readInterviewLog(root, VAULT_ID)).events;
    process.env["OMS_NON_INTERACTIVE"] = "1";
    error.mockClear();
    await runInterviewCommand(["--restart", "--vault", vault], { resume });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("OMS_NON_INTERACTIVE unset");
    expect((await readInterviewLog(root, VAULT_ID)).events).toEqual(before);
  });
});
