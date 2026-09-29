import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { hasNestedQuantifier, InterviewAborted, runInterview, type InterviewIO, type Question } from "./interview.js";
import { judge } from "./judge.js";
import { digestBytes } from "../conventions/canonical.js";
import { sealLegacyGeneration } from "./legacy-store-fixture.js";
import { bootstrapSnapshots, readDeclined, readStore } from "./store.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const SECRET = "SECRET-42";
const DROPPED_ONE = "CONTRACT_LEGACY_TEMPLATES_DROPPED: 1 template(s) sealed by an older generation are not carried forward; templates now scaffold new notes from the template folder and are never judged";

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-interview-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, "Inbox"));
  await mkdir(join(vault, ".obsidian"));
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, ".oms"));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Templates/Meeting.md"), MEETING_SOURCE);
  // Properties are discovered from Obsidian's property types, never from template text.
  await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { status: "text", created: "date" } }));
});

const MEETING_SOURCE = "---\nstatus: open\ncreated: \"{{date}}\"\n---\n## Agenda\n";

/**
 * Seals the state BASE_ANSWERS reaches, the way a version 2 store held it: the Meeting
 * template included. A version 3 seal no longer stores templates, so only a head sealed
 * before it still carries one for the interview to compare against.
 */
async function sealLegacyHead(): Promise<void> {
  await sealLegacyGeneration({
    vaultRealPath: vault,
    vaultId: VAULT_ID,
    contract: {
      folders: { Projects: { meaning: "project notes", searchExclude: false } },
      properties: { status: { meaning: "workflow state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "closed"] }] } },
    },
    templates: {
      Meeting: {
        source: "Templates/Meeting.md",
        sourceHash: digestBytes(MEETING_SOURCE),
        applyFolder: "Projects",
        requiredProperties: ["status"],
        narrowedRules: { status: [{ kind: "fixed", value: "open" }] },
        requiredHeadings: ["Agenda"],
      },
    },
    declined: { folders: ["Inbox", "Templates"], properties: ["created"], templates: {} },
  }, root);
  await bootstrapSnapshots(root, VAULT_ID);
}

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Answers by question id; any question not scripted fails the test. */
function scripted(answers: Readonly<Record<string, string | readonly string[]>>): InterviewIO & { readonly asked: string[]; readonly said: string[] } {
  const asked: string[] = [];
  const said: string[] = [];
  const queues = new Map(Object.entries(answers).map(([id, answer]) => [id, typeof answer === "string" ? [answer] : [...answer]]));
  return {
    asked,
    said,
    say: line => { said.push(line); },
    ask: async (question: Question) => {
      asked.push(question.id);
      const queue = queues.get(question.id);
      if (queue === undefined || queue.length === 0) throw new Error(`unscripted question ${question.id}`);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  };
}

const BASE_ANSWERS = {
  "folder:Inbox:register": "n",
  "folder:Projects:register": "y",
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": "n",
  "folder:Templates:register": "n",
  "property:created:register": "n",
  "property:status:register": "y",
  "property:status:type": "",
  "property:status:required": "yes",
  "property:status:rule": "2",
  "property:status:allowed": "open, closed",
  "property:status:meaning": "workflow state",
  "template-folder:path": "",
  "seal": "y",
} as const;

describe("runInterview", () => {
  it("seals the answered contract", async () => {
    const io = scripted(BASE_ANSWERS);
    const result = await runInterview({ vault, io, root });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
    expect(io.asked.some(id => id.startsWith("template"))).toBe(false);
    expect(io.asked).not.toContain("folder:.obsidian:register");
    expect(io.asked).not.toContain("property:status:default");

    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(`store ${store.state}`);
    expect(store.contract.folders).toEqual({ Projects: { meaning: "project notes", searchExclude: false } });
    expect(store.contract.properties).toEqual({
      status: { meaning: "workflow state", type: "text", default: false, required: true, rules: [{ kind: "allowed", values: ["open", "closed"] }] },
    });
    // A version 3 seal carries the axes only; the Meeting template scaffolds and is never sealed.
    expect(Object.keys(store.contract).sort()).toEqual(["folders", "properties"]);
    expect(store.legacy).toBeUndefined();
  });

  it("refuses a public meaning that carries a hidden value, without naming it", async () => {
    const io = scripted({
      ...BASE_ANSWERS,
      "folder:Projects:meaning": `holds ${SECRET}`,
      "property:status:allowed": `open, ${SECRET}`,
    });
    const result = await runInterview({ vault, io, root });
    expect(result.state).toBe("refused");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("aborts after three invalid answers", async () => {
    const io = scripted({ ...BASE_ANSWERS, "folder:Inbox:register": "maybe" });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "aborted" });
    expect(io.asked.filter(id => id === "folder:Inbox:register")).toHaveLength(3);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("aborts when the IO aborts or the seal is declined", async () => {
    const aborting: InterviewIO = { say: () => {}, ask: async () => { throw new InterviewAborted(); } };
    expect(await runInterview({ vault, io: aborting, root })).toEqual({ state: "aborted" });
    expect(await runInterview({ vault, io: scripted({ ...BASE_ANSWERS, seal: "n" }), root })).toEqual({ state: "aborted" });
    await expect(readdir(root)).rejects.toThrow();
  });

  it("issues a vault id when none exists", async () => {
    await rm(join(vault, SETTINGS_PATH));
    const io = scripted({ ...BASE_ANSWERS, "property:status:register": "n", "property:created:register": "n" });
    const result = await runInterview({ vault, io, root });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: true, folders: 1, properties: 0 });
  });

  it("refuses a pattern rule with nested repetition", async () => {
    const io = scripted({ ...BASE_ANSWERS, "property:status:rule": "pattern", "property:status:pattern": ["(a+)+", "(a|a)*", "[a-z]+(-[a-z]+)*"] });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "aborted" });
    expect(io.said.filter(line => line.includes("Nested repetition"))).toHaveLength(3);
    for (const risky of ["(a+)+", "(a*)*", "(a|a)*", "(?:a+){2,}", "((ab)*)+", "(?<x>a?)+"]) expect(hasNestedQuantifier(risky)).toBe(true);
    for (const safe of ["^[a-z]+$", "(ab)+", "\\(a+\\)+", "[(a+)]+", "\\d{4}-\\d{2}", "(a|b)"]) expect(hasNestedQuantifier(safe)).toBe(false);
  });

  it("refuses a pattern rule past the length cap", async () => {
    const io = scripted({ ...BASE_ANSWERS, "property:status:rule": "pattern", "property:status:pattern": ["a".repeat(PATTERN_SOURCE_LIMIT + 1)] });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "aborted" });
    expect(io.said.filter(line => line.includes(`${PATTERN_SOURCE_LIMIT} characters or fewer`))).not.toHaveLength(0);
  });

  it("refuses a vault whose id was changed or is shared with a copy", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: "0d2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c", templateFolder: "Templates" }));
    await expect(runInterview({ vault, io: scripted(BASE_ANSWERS), root })).rejects.toThrow(/^CONTRACT_VAULT_ID_TAMPERED: .*oms doctor contract/);

    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
    const copy = join(base, "copy");
    await mkdir(join(copy, ".oms"), { recursive: true });
    await writeFile(join(copy, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await expect(runInterview({ vault: copy, io: scripted(BASE_ANSWERS), root })).rejects.toThrow(/^CONTRACT_VAULT_ID_SHARED: .*remove \.oms\/settings\.json in the copy/);
    await expect(readdir(join(copy, ".oms"))).resolves.toEqual(["settings.json"]);
  });
});

describe("template folder discovery", () => {
  beforeEach(async () => {
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
  });

  it("remembers the folder named by .obsidian/templates.json once confirmed, and seals no template", async () => {
    await writeFile(join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
    const io = scripted({ ...BASE_ANSWERS, "template-folder:confirm": "" });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
    expect(io.asked).not.toContain("template-folder:path");
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
    const store = await readStore(VAULT_ID, root);
    expect(store.state === "ok" && Object.hasOwn(store.contract, "templates")).toBe(false);
  });

  it("persists the template folder and still reports sealed, with a warning, when the seal cannot be logged", async () => {
    await writeFile(join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
    const io: InterviewIO = {
      ...scripted({ ...BASE_ANSWERS, "template-folder:confirm": "" }),
      record: async event => {
        if (event.type === "sealed") throw new Error("disk full");
      },
    };
    const result = await runInterview({ vault, io, root });
    expect(result).toMatchObject({ state: "sealed" });
    expect(result.state === "sealed" && result.warnings).toEqual(["INTERVIEW_LOG_UNRECORDED: the seal was not logged (disk full)"]);
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
    expect((await readStore(VAULT_ID, root)).state).toBe("ok");
  });

  it("offers the Templater folder and asks for another folder when the owner declines it", async () => {
    await mkdir(join(vault, "Other"));
    await mkdir(join(vault, ".obsidian/plugins/templater-obsidian"), { recursive: true });
    await writeFile(join(vault, ".obsidian/plugins/templater-obsidian/data.json"), JSON.stringify({ templates_folder: "/Other/" }));
    const io = scripted({
      ...BASE_ANSWERS,
      "folder:Other:register": "n",
      "template-folder:confirm": "n",
      "template-folder:path": ["../outside", ".obsidian", "Missing", "Templates"],
    });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "aborted" });
    expect(io.asked.filter(id => id === "template-folder:path")).toHaveLength(3);

    const retry = scripted({ ...BASE_ANSWERS, "folder:Other:register": "n", "template-folder:confirm": "no", "template-folder:path": "Templates" });
    expect((await runInterview({ vault, io: retry, root })).state).toBe("sealed");
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
  });

  it("leaves the template folder unset when the owner names none, and does not ask again", async () => {
    const io = scripted({ ...BASE_ANSWERS, "property:status:register": "n" });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 0 });
    expect((await readVaultSettings(vault))?.templateFolder).toBeUndefined();
    const rerun = scripted({ seal: "y" });
    expect((await runInterview({ vault, io: rerun, root })).state).toBe("sealed");
    expect(rerun.asked).toEqual(["seal"]);
  });
});

describe("diff-only rerun (R24)", () => {
  /** Declined folders and properties are remembered beside the contract; a rerun asks only the seal. */
  const DECLINED_AGAIN = { "seal": "y" } as const;

  async function sealed() {
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(`store ${store.state}`);
    return store.contract;
  }

  it("AC20: asks only about a new folder and a new property, then admits a write that uses them", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const before = await sealed();
    const note = { path: "Journal/x.md", frontmatter: { status: "open", mood: "calm" }, body: "" };
    expect(judge(note, { state: "sealed", contract: before }).warnings).not.toEqual([]);

    await mkdir(join(vault, "Journal"));
    await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { mood: "text" } }));
    const io = scripted({
      ...DECLINED_AGAIN,
      "folder:Journal:register": "y",
      "folder:Journal:meaning": "daily journal",
      "folder:Journal:search-exclude": "n",
      "property:mood:register": "y",
      "property:mood:type": "",
      "property:mood:required": "n",
      "property:mood:default": "n",
      "property:mood:rule": "1",
      "property:mood:meaning": "how the day felt",
    });
    const result = await runInterview({ vault, io, root });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 2, properties: 2 });

    const asked = new Set(io.asked.map(id => id.split(":").slice(0, 2).join(":")));
    expect([...asked].sort()).toEqual(["folder:Journal", "property:mood", "seal"].sort());
    expect(io.asked.some(id => id.startsWith("folder:Projects") || id.startsWith("property:status"))).toBe(false);

    const after = await sealed();
    expect(after.folders?.["Projects"]).toEqual(before.folders?.["Projects"]);
    expect(after.properties?.["status"]).toEqual(before.properties?.["status"]);
    expect(judge(note, { state: "sealed", contract: after })).toEqual({ ok: true, refusals: [], warnings: [], fixes: [], missingDefaults: [], violations: [] });
  });

  it("re-asks nothing already sealed when nothing changed and keeps the contract", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const before = await sealed();
    const io = scripted(DECLINED_AGAIN);
    expect((await runInterview({ vault, io, root })).state).toBe("sealed");
    expect(io.asked.sort()).toEqual(Object.keys(DECLINED_AGAIN).sort());
    expect(await sealed()).toEqual(before);
  });

  it("says so when everything is already sealed", async () => {
    await rm(join(vault, "Inbox"), { recursive: true });
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    await rm(join(vault, "Templates"), { recursive: true });
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const io = scripted({ seal: "y" });
    expect((await runInterview({ vault, io, root })).state).toBe("sealed");
    expect(io.asked).toEqual(["seal"]);
    expect(io.said).toContain("Nothing new since the last seal; existing answers are kept.");
  });

  it("reseals a legacy head without its templates, warns without refusing, and asks nothing about them", async () => {
    await sealLegacyHead();
    const io = scripted({ seal: "y" });
    expect(await runInterview({ vault, io, root })).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1, warnings: [DROPPED_ONE] });
    expect(io.asked).toEqual(["seal"]);
    expect(io.said).toContain("Nothing new since the last seal; existing answers are kept.");
    expect(io.said).toContain(DROPPED_ONE);
    const store = await readStore(VAULT_ID, root);
    expect(store.state === "ok" && store.legacy).toBeUndefined();
    expect(Object.hasOwn(await sealed(), "templates")).toBe(false);
  });

  it("asks nothing about a legacy template whose source changed or is gone", async () => {
    await sealLegacyHead();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n## Notes\n");
    const changed = scripted({ seal: "y" });
    expect((await runInterview({ vault, io: changed, root })).state).toBe("sealed");
    expect(changed.asked).toEqual(["seal"]);
    await rm(join(vault, "Templates/Meeting.md"));
    const gone = scripted({ seal: "y" });
    expect(await runInterview({ vault, io: gone, root })).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
    expect(gone.asked).toEqual(["seal"]);
  });

  it("keeps the previous contract when the reseal fails midway", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const before = await sealed();
    await mkdir(join(vault, "Journal"));
    const io = scripted({ ...DECLINED_AGAIN, "folder:Journal:register": "y", "folder:Journal:meaning": "j", "folder:Journal:search-exclude": "n" });
    const failing: typeof rename = async (from, to) => {
      if (String(to).endsWith(VAULT_ID)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    };
    await expect(runInterview({ vault, io, root, sealDeps: { fs: { rename: failing, symlink, rm } } })).rejects.toThrow("disk full");
    expect(await sealed()).toEqual(before);
    expect((await readdir(root)).filter(entry => entry.endsWith(".lock") || entry.includes("link-tmp"))).toEqual([]);
  });

  it("asks before reclaiming a stale seal lock", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const lock = join(root, `.${VAULT_ID}.lock`);
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), startedAt: Date.now() }));
    const declined = scripted({ ...DECLINED_AGAIN, "seal-lock:reclaim": "n" });
    await expect(runInterview({ vault, io: declined, root, sealDeps: { isPidAlive: () => false } })).rejects.toThrow("CONTRACT_SEAL_LOCK_STALE");
    const accepted = scripted({ ...DECLINED_AGAIN, "seal-lock:reclaim": "y" });
    expect((await runInterview({ vault, io: accepted, root, sealDeps: { isPidAlive: () => false } })).state).toBe("sealed");
    expect(accepted.asked).toContain("seal-lock:reclaim");
  });

  it("remembers what was declined until the owner asks to review it", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    const declined = await readDeclined(VAULT_ID, root);
    expect(declined.folders.sort()).toEqual(["Inbox", "Templates"]);
    expect(declined.properties).toEqual(["created"]);
    expect(Object.keys(declined).sort()).toEqual(["folders", "properties"]);

    const quiet = scripted({ seal: "y" });
    expect((await runInterview({ vault, io: quiet, root })).state).toBe("sealed");
    expect(quiet.asked).toEqual(["seal"]);
    expect(quiet.said.some(line => line.includes("oms setup --reask"))).toBe(true);
    expect(await readDeclined(VAULT_ID, root)).toEqual(declined);

    const review = scripted({ "folder:Inbox:register": "n", "folder:Templates:register": "n", "property:created:register": "n", seal: "y" });
    expect((await runInterview({ vault, io: review, root, reask: true })).state).toBe("sealed");
    expect(review.asked.sort()).toEqual(["folder:Inbox:register", "folder:Templates:register", "property:created:register", "seal"].sort());
    expect(await readDeclined(VAULT_ID, root)).toEqual(declined);
  });

  it("adds no file to the vault .oms/ besides settings.json", async () => {
    await runInterview({ vault, io: scripted(BASE_ANSWERS), root });
    await runInterview({ vault, io: scripted(DECLINED_AGAIN), root });
    expect(await readdir(join(vault, ".oms"))).toEqual(["settings.json"]);
  });
});
