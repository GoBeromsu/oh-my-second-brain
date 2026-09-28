import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { interpretVault } from "./interpretation-fixture.js";
import { runInterview, type InterviewIO, type Question } from "./interview.js";
import { readInterviewLog } from "./interview-log.js";
import { confirmedProposal, currentRun, latestProposal, pendingAnswers, resumableIO } from "./interview-resume.js";
import type { Answers } from "./scripted-interview.js";
import { readStore } from "./store.js";

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
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Projects/Alpha.md"), "---\nstatus: active\n---\nbody\n");
  await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
  return { vault, root };
}

const TERMINAL: Answers = {
  "template:Meeting:interpretation": true,
  "folder:Projects:register": true,
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": false,
  "folder:Templates:register": false,
  "property:status:register": true,
  "property:status:type": "",
  "property:status:required": true,
  "property:status:rule": "none",
  "property:status:meaning": "workflow state",
  "template:Meeting:register": true,
  "template:Meeting:field:status:required": true,
  "template:Meeting:field:status:literal": "one-of-allowed",
  "template:Meeting:field:status:allowed": "open, done",
  "template:Meeting:heading:Agenda": true,
  "template:Meeting:apply-folder": "Projects",
  seal: true,
};

class Interrupted extends Error {}

/** A terminal that answers from TERMINAL, and is closed (Ctrl-C) when asked its question number `stopAt`. */
function terminal(stopAt = Number.POSITIVE_INFINITY): { readonly io: InterviewIO; readonly asked: string[] } {
  const asked: string[] = [];
  const io: InterviewIO = {
    say: () => undefined,
    ask: async (question: Question) => {
      if (asked.length + 1 >= stopAt) throw new Interrupted(question.id);
      asked.push(question.id);
      const value = TERMINAL[question.id];
      if (value === undefined) return null;
      if (typeof value === "boolean") return question.kind === "confirm" ? (value ? "yes" : "no") : String(value);
      return String(value);
    },
  };
  return { io, asked };
}

async function interview(vault: string, root: string, io: InterviewIO) {
  const resumed = await resumableIO({ vault, root, fallback: io, now: () => NOW });
  const interpretations = await interpretVault(vault);
  const result = await runInterview({ vault, io: resumed.io, root, interpretations, sealDeps: { now: () => NOW } });
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
    await mkdir(join(vault, ".obsidian"));
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
