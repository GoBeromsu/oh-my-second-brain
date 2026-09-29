import { access, appendFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { runInterview, type InterviewIO, type Question } from "./interview.js";
import { appendInterviewEvent, EVENTS_FILE, migrateInterviewLog, pendingLogKey, readInterviewLog } from "./interview-log.js";
import { stateDir } from "./state-dir.js";
import { confirmedProposal, currentRun, latestProposal, pendingAnswers, resumableIO, vaultLog } from "./interview-resume.js";
import type { Answers } from "./scripted-interview.js";
import { readStore } from "./store.js";
import { resolveSealState } from "./vault-id.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOW = 1_800_000_000_000;

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-resume-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A vault under `base/<name>` with its own store root. */
async function makeVault(name: string): Promise<{ readonly vault: string; readonly root: string }> {
  const vault = join(base, name, "vault");
  const root = join(base, name, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, ".oms"));
  await mkdir(join(vault, ".obsidian"));
  await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { status: "text" } }));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
  await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
  return { vault, root };
}

const TERMINAL: Answers = {
  "folder:Projects:register": true,
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": false,
  "folder:Templates:register": false,
  "property:status:register": true,
  "property:status:type": "",
  "property:status:required": true,
  "property:status:rule": "none",
  "property:status:meaning": "workflow state",
  seal: true,
};

/** A vault never sealed: no `.oms/settings.json`, no templates. */
async function makeFreshVault(name: string): Promise<{ readonly vault: string; readonly root: string }> {
  const vault = join(base, name, "vault");
  const root = join(base, name, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await writeFile(join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
  return { vault, root };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

class Interrupted extends Error {}

/** A terminal that answers from TERMINAL, and is closed (Ctrl-C) when asked its question number `stopAt`. */
function terminal(stopAt = Number.POSITIVE_INFINITY): { readonly io: InterviewIO; readonly asked: string[] } {
  const asked: string[] = [];
  const io: InterviewIO = {
    say: () => undefined,
    ask: async (question: Question) => {
      if (asked.length + 1 >= stopAt) throw new Interrupted(question.id);
      asked.push(question.id);
      const value = question.id === "template-folder:path" ? "" : TERMINAL[question.id];
      if (value === undefined) return null;
      if (typeof value === "boolean") return question.kind === "confirm" ? (value ? "yes" : "no") : String(value);
      return String(value);
    },
  };
  return { io, asked };
}

async function interview(vault: string, root: string, io: InterviewIO) {
  const resumed = await resumableIO({ vault, root, fallback: io, now: () => NOW });
  const result = await runInterview({ vault, io: resumed.io, root, sealDeps: { now: () => NOW } });
  return { result, resumed };
}

/** Every file in the linked generation, by name; the generation's own name and link target are left out. */
async function generationFiles(root: string): Promise<Record<string, string>> {
  const target = await readlink(join(root, VAULT_ID));
  const directory = join(root, target);
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = await readFile(join(dir, entry.name), "utf8");
    }
  }
  await walk(directory, "");
  return out;
}

describe("continuing an interrupted interview", () => {
  it("seals byte-for-byte what an uninterrupted run seals", async () => {
    const straight = await makeVault("straight");
    const once = await interview(straight.vault, straight.root, terminal().io);
    expect(once.result.state).toBe("sealed");

    const broken = await makeVault("broken");
    const first = terminal(6);
    await expect(interview(broken.vault, broken.root, first.io)).rejects.toThrow(Interrupted);
    expect((await readStore(VAULT_ID, broken.root)).state).toBe("absent");
    const logged = await readInterviewLog(broken.root, VAULT_ID);
    expect(logged.events.filter(event => event.type === "answered").map(event => event.questionId)).toEqual(first.asked);

    const second = terminal();
    const resumed = await interview(broken.vault, broken.root, second.io);
    expect(resumed.result.state).toBe("sealed");
    expect(resumed.resumed.pending).toBe(first.asked.length);
    expect(resumed.resumed.drift).toEqual([]);
    // Replayed questions are not put to the terminal again.
    for (const id of first.asked) expect(second.asked).not.toContain(id);

    const expected = await generationFiles(straight.root);
    const actual = await generationFiles(broken.root);
    expect(Object.keys(actual)).toContain("manifest.json");
    expect(JSON.parse(actual["manifest.json"]!)).toEqual(JSON.parse(expected["manifest.json"]!));
    expect(actual).toEqual(expected);

    // The lock, stale-lock renames, the index and the state directory stay beside the generation.
    const generation = join(broken.root, await readlink(join(broken.root, VAULT_ID)));
    const names = await readdir(generation, { recursive: true });
    expect(names.filter(name => /lock|stale|index\.json|\.state|events\.jsonl/.test(name))).toEqual([]);
    expect((await lstat(join(broken.root, "index.json"))).isFile()).toBe(true);

    const events = (await readInterviewLog(broken.root, VAULT_ID)).events;
    expect(events.at(-1)?.type).toBe("sealed");
    expect(currentRun(events)).toEqual([]);
  });

  it("reports logged answers whose question now reads differently and asks them again", async () => {
    const { vault, root } = await makeVault("drift");
    const first = terminal(10);
    await expect(interview(vault, root, first.io)).rejects.toThrow(Interrupted);
    expect(first.asked).toContain("property:status:type");

    // Obsidian now declares `status` a select, so the type question offers another default.
    await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { status: "select" } }));
    const second = terminal();
    const { result, resumed } = await interview(vault, root, second.io);
    expect(result.state).toBe("sealed");
    expect(resumed.drift).toEqual([{ questionId: "property:status:type", reason: "question-changed" }]);
    expect(second.asked).toContain("property:status:type");
    expect(second.asked).not.toContain("folder:Projects:register");
  });

  it("starts over after restart and replays nothing", async () => {
    const { vault, root } = await makeVault("restart");
    const first = terminal(4);
    await expect(interview(vault, root, first.io)).rejects.toThrow(Interrupted);
    const resumed = await resumableIO({ vault, root, restart: true, now: () => NOW });
    expect(resumed.pending).toBe(0);
    const events = (await readInterviewLog(root, VAULT_ID)).events;
    expect(events.at(-1)?.type).toBe("abandoned");
    expect(pendingAnswers(events).size).toBe(0);
  });

  it("logs a never-sealed vault under its pending key and writes nothing into the vault before the seal", async () => {
    const { vault, root } = await makeFreshVault("fresh");
    const pending = await pendingLogKey(vault);
    const first = terminal(4);
    await expect(interview(vault, root, first.io)).rejects.toThrow(Interrupted);
    const logged = (await readInterviewLog(root, pending)).events;
    expect(logged.filter(event => event.type === "answered").map(event => event.questionId)).toEqual(first.asked);
    // Each question put to the terminal is logged as asked, including the one interrupted.
    const asked = logged.filter(event => event.type === "asked").map(event => event.questionId);
    expect(asked.slice(0, -1)).toEqual(first.asked);
    expect(asked).toHaveLength(first.asked.length + 1);
    expect(await exists(join(vault, ".oms"))).toBe(false);
    expect((await resolveSealState(vault, root)).row).toBe("never-sealed");

    // A new process picks the answers up from the pending log.
    const second = terminal();
    const { result, resumed } = await interview(vault, root, second.io);
    expect(resumed.pending).toBe(first.asked.length);
    for (const id of first.asked) expect(second.asked).not.toContain(id);
    expect(result.state).toBe("sealed");

    // The seal issued the id, and the pending log now lives under it.
    const vaultId = (await readVaultSettings(vault))!.vaultId;
    const events = (await readInterviewLog(root, vaultId)).events;
    expect(events.filter(event => event.type === "answered").map(event => event.questionId)).toEqual(expect.arrayContaining(first.asked));
    expect(events.at(-1)?.type).toBe("sealed");
    expect((await readInterviewLog(root, pending)).events).toEqual([]);
    expect((await resolveSealState(vault, root)).row).toBe("sealed");
  });

  it("abandons a never-sealed interview without writing settings", async () => {
    const { vault, root } = await makeFreshVault("fresh-abandon");
    await expect(interview(vault, root, terminal(4).io)).rejects.toThrow(Interrupted);
    const resumed = await resumableIO({ vault, root, restart: true, now: () => NOW });
    expect(resumed.pending).toBe(0);
    expect((await readInterviewLog(root, await pendingLogKey(vault))).events.at(-1)?.type).toBe("abandoned");
    expect(await exists(join(vault, SETTINGS_PATH))).toBe(false);
    expect((await resolveSealState(vault, root)).row).toBe("never-sealed");
  });

  it("orders a pending log beside the vault id log the same before and after it is moved", async () => {
    const { vault, root } = await makeVault("order");
    const pending = await pendingLogKey(vault);
    const answer = (questionId: string) => ({ type: "answered" as const, questionId, questionDigest: "d", payload: { answer: "x" } });
    await appendInterviewEvent(root, VAULT_ID, answer("own-1"), () => 1);
    await appendInterviewEvent(root, VAULT_ID, answer("own-2"), () => 2);
    await appendInterviewEvent(root, pending, answer("pending-1"), () => 3);
    const strip = (events: readonly { readonly seq: number; readonly questionId: string | null }[]) =>
      events.map(event => [event.seq, event.questionId]);
    const before = strip((await vaultLog(vault, root)).events);
    expect(before).toEqual([[1, "own-1"], [2, "own-2"], [3, "pending-1"]]);
    await migrateInterviewLog(root, pending, VAULT_ID);
    expect(strip((await vaultLog(vault, root)).events)).toEqual(before);
  });

  it("lists a pending event already copied by a cut-short move once, as the retried move leaves it", async () => {
    const { vault, root } = await makeVault("partial");
    const pending = await pendingLogKey(vault);
    const answer = (questionId: string) => ({ type: "answered" as const, questionId, questionDigest: "d", payload: { answer: "x" } });
    await appendInterviewEvent(root, VAULT_ID, answer("own-1"), () => 1);
    await appendInterviewEvent(root, pending, answer("pending-1"), () => 2);
    await appendInterviewEvent(root, pending, answer("pending-2"), () => 3);
    // The first move copied "pending-1" and then stopped: the pending log is still there.
    await appendInterviewEvent(root, VAULT_ID, answer("pending-1"), () => 2);
    const strip = (events: readonly { readonly seq: number; readonly questionId: string | null }[]) =>
      events.map(event => [event.seq, event.questionId]);
    const before = strip((await vaultLog(vault, root)).events);
    expect(before).toEqual([[1, "own-1"], [2, "pending-1"], [3, "pending-2"]]);
    await migrateInterviewLog(root, pending, VAULT_ID);
    expect(strip((await vaultLog(vault, root)).events)).toEqual(before);
  });

  it("reports unparsable lines numbered within the file they are in", async () => {
    const { vault, root } = await makeVault("corrupt-lines");
    const pending = await pendingLogKey(vault);
    const answer = (questionId: string) => ({ type: "answered" as const, questionId, questionDigest: "d", payload: { answer: "x" } });
    await appendInterviewEvent(root, VAULT_ID, answer("own-1"), () => 1);
    await appendFile(join(stateDir(root, VAULT_ID), "interview", EVENTS_FILE), "{not json\n");
    await appendInterviewEvent(root, pending, answer("pending-1"), () => 2);
    await appendInterviewEvent(root, pending, answer("pending-2"), () => 3);
    await appendFile(join(stateDir(root, pending), "interview", EVENTS_FILE), "{not json\n");
    const log = await vaultLog(vault, root);
    expect(log.corrupt).toEqual([2]);
    expect(log.pendingCorrupt).toEqual([3]);
    const resumed = await resumableIO({ vault, root, record: false, now: () => NOW });
    expect([resumed.corrupt, resumed.pendingCorrupt]).toEqual([[2], [3]]);
  });

  it("reports a pending log's unparsable lines as pending before the first seal", async () => {
    const { vault, root } = await makeFreshVault("fresh-corrupt");
    const pending = await pendingLogKey(vault);
    await appendInterviewEvent(root, pending, { type: "answered", questionId: "q", questionDigest: "d", payload: { answer: "x" } }, () => 1);
    await appendFile(join(stateDir(root, pending), "interview", EVENTS_FILE), "{not json\n");
    const log = await vaultLog(vault, root);
    expect([log.vaultId, log.corrupt, log.pendingCorrupt]).toEqual([null, [], [2]]);
  });

  it("confirms only the latest proposal", () => {
    const event = (seq: number, type: "proposed" | "answered" | "sealed", payload: Record<string, unknown>, questionId: string | null = null) =>
      ({ seq, at: seq, type, questionId, questionDigest: questionId === null ? null : "d", payload });
    const events = [
      event(1, "proposed", { digest: "old" }),
      event(2, "answered", { answer: "yes", confirm: true, proposed: "old" }, "seal"),
      event(3, "proposed", { digest: "new" }),
    ];
    expect(latestProposal(events)?.payload["digest"]).toBe("new");
    expect(confirmedProposal(events)).toBeNull();
    expect(confirmedProposal([...events, event(4, "answered", { answer: "yes", confirm: true, proposed: "new" }, "seal")])).toBe("new");
    expect(confirmedProposal([...events, event(4, "answered", { answer: "yes", proposed: "new" }, "seal")])).toBeNull();
    expect(confirmedProposal([...events, event(4, "answered", { answer: "yes", confirm: true, proposed: "new" }, "seal"), event(5, "sealed", {})])).toBeNull();
    // A logged seal answer is never replayed.
    expect(pendingAnswers([event(1, "answered", { answer: "yes" }, "seal")]).size).toBe(0);
  });
});
