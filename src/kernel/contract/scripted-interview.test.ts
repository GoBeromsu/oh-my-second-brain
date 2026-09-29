import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { runInterview, templateFieldType } from "./interview.js";
import { parseAnswers, publicQuestion, scriptedIO, type Answers } from "./scripted-interview.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { sealLegacyGeneration } from "./legacy-store-fixture.js";
import { bootstrapSnapshots, readStore } from "./store.js";
import type { Rule } from "./types.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const DROPPED_ONE = "CONTRACT_LEGACY_TEMPLATES_DROPPED: 1 template(s) sealed by an older generation are not carried forward; templates now scaffold new notes from the template folder and are never judged";

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-scripted-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, ".oms"));
  await mkdir(join(vault, ".obsidian"));
  // Properties are discovered from Obsidian's property types, then from the keys templates set.
  await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { status: "text" } }));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Templates/Meeting.md"), MEETING_SOURCE);
});

const MEETING_SOURCE = "---\nstatus: open\n---\n## Agenda\n";

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const ANSWERS: Answers = {
  "folder:Projects:register": true,
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": false,
  "folder:Templates:register": false,
  "property:status:register": true,
  "property:status:type": "",
  "property:status:required": true,
  "property:status:rule": "none",
  "property:status:meaning": "workflow state",
};

async function run(answers: Answers, extra: { readonly reask?: boolean } = {}) {
  const { io, notes } = scriptedIO(answers);
  return { result: await runInterview({ vault, io, root, nonLoosening: true, ...extra }), notes };
}

/**
 * Seals what ANSWERS reaches the way a version 2 store held it, the Meeting template
 * included. A version 3 seal stores no templates, so only such a head gives a reseal a
 * sealed template to compare against.
 */
async function sealLegacyHead(rules: { readonly status?: readonly Rule[]; readonly meeting?: readonly Rule[] } = {}): Promise<void> {
  await sealLegacyGeneration({
    vaultRealPath: vault,
    vaultId: VAULT_ID,
    contract: {
      folders: { Projects: { meaning: "project notes", searchExclude: false } },
      properties: { status: { meaning: "workflow state", type: "text", default: false, required: true, rules: rules.status ?? [] } },
    },
    templates: {
      Meeting: {
        source: "Templates/Meeting.md",
        sourceHash: digestBytes(MEETING_SOURCE),
        applyFolder: "Projects",
        requiredProperties: ["status"],
        narrowedRules: { status: rules.meeting ?? [{ kind: "allowed", values: ["open", "done"] }] },
        requiredHeadings: ["Agenda"],
      },
    },
    declined: { folders: ["Templates"], properties: [], templates: {} },
  }, root);
  await bootstrapSnapshots(root, VAULT_ID);
}

async function sealedContract() {
  const store = await readStore(VAULT_ID, root);
  if (store.state !== "ok") throw new Error(`store ${store.state}`);
  return store.contract;
}

describe("scripted interview questions", () => {
  it("lists the first questions from the interview itself and asks nothing about a template", async () => {
    const { result } = await run({});
    if (result.state !== "incomplete") throw new Error(result.state);
    expect(result.questions.map(question => question.id)).toEqual([
      "folder:Projects:register",
      "folder:Templates:register",
      "property:status:register",
      "seal",
    ]);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("asks follow-up questions once their parent is answered", async () => {
    const { result } = await run({ "folder:Projects:register": true });
    if (result.state !== "incomplete") throw new Error(result.state);
    const ids = result.questions.map(question => question.id);
    expect(ids).toEqual(expect.arrayContaining(["folder:Projects:meaning", "folder:Projects:search-exclude"]));
    expect(ids.some(id => id.startsWith("template:"))).toBe(false);
  });

  it("asks the template folder first when the vault names none", async () => {
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    const { result } = await run({});
    if (result.state !== "incomplete") throw new Error(result.state);
    expect(result.questions[0]).toEqual(expect.objectContaining({ id: "template-folder:path", kind: "text" }));
  });

  it("prints choices and defaults", () => {
    expect(publicQuestion({ id: "a", prompt: "p", kind: "choice", options: ["x", "y"] })).toEqual({ id: "a", prompt: "p", kind: "choice", choices: ["x", "y"] });
    expect(publicQuestion({ id: "b", prompt: "p", kind: "confirm", initial: true })).toEqual({ id: "b", prompt: "p", kind: "confirm", default: true });
    expect(publicQuestion({ id: "c", prompt: "p", kind: "text", initial: "text" })).toEqual({ id: "c", prompt: "p", kind: "text", default: "text" });
  });
});

describe("scripted interview answers", () => {
  it("stops before the seal with the public preview, then seals once the seal is answered", async () => {
    const first = await run(ANSWERS);
    expect(first.result).toEqual({ state: "incomplete", questions: [expect.objectContaining({ id: "seal", kind: "confirm" })] });
    expect(first.notes).toContain("Public part (agents will see this):");
    await expect(readdir(root)).rejects.toThrow();

    const second = await run({ ...ANSWERS, seal: true });
    expect(second.result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
    // A version 3 seal carries folders and properties only.
    expect(Object.keys(await sealedContract()).sort()).toEqual(["folders", "properties"]);
  });

  it("aborts when the seal is declined", async () => {
    expect((await run({ ...ANSWERS, seal: false })).result).toEqual({ state: "aborted" });
    await expect(readdir(root)).rejects.toThrow();
  });

  it("rejects an invalid answer with the reason and seals nothing", async () => {
    await expect(run({ ...ANSWERS, "property:status:rule": "sometimes", seal: true })).rejects.toThrow(/^CONTRACT_ANSWER_INVALID: property:status:rule: Choose one of/);
    await expect(run({ ...ANSWERS, "property:status:type": "colour", seal: true })).rejects.toThrow(/^CONTRACT_ANSWER_INVALID: property:status:type:/);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("rejects an answer for a question that was never asked", async () => {
    await expect(run({ ...ANSWERS, "folder:Nowhere:register": true, seal: true })).rejects.toThrow("CONTRACT_ANSWER_UNKNOWN: no question has the id \"folder:Nowhere:register\"");
    await expect(readdir(root)).rejects.toThrow();
  });

  it("refuses a hidden value in a public meaning like the terminal interview", async () => {
    const { result } = await run({ ...ANSWERS, "property:status:rule": "one-of-allowed", "property:status:allowed": "open, done", "property:status:meaning": "open or done", seal: true });
    expect(result.state).toBe("refused");
    await expect(readdir(root)).rejects.toThrow();
  });

  it("offers a key a template sets as a text property unless Obsidian already types it", async () => {
    await writeFile(join(vault, ".obsidian/types.json"), JSON.stringify({ types: { status: "text", due: "date" } }));
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\ndue: 2026-01-01\nfolder: Projects\ntopic: x\n---\n## Agenda\n");
    const { result, notes } = await run({
      ...ANSWERS,
      "property:due:register": false,
      "property:topic:register": true,
      "property:topic:type": "",
      "property:topic:required": false,
      "property:topic:default": false,
      "property:topic:rule": "none",
      "property:topic:meaning": "subject",
      seal: true,
    });
    expect(result).toMatchObject({ state: "sealed", properties: 2 });
    expect((await sealedContract()).properties?.["topic"]).toMatchObject({ type: "text" });
    expect(notes.filter(note => note.startsWith("property:folder"))).toEqual([]);
  });

  it("offers a template key Obsidian does not type as the list, date or datetime its value clearly is", async () => {
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\ntags:\n  - meeting\ndue: \"{{date}}\"\nat: \"{{date:YYYY-MM-DDTHH:mm}}\"\ntopic: \"{{title}}\"\n---\n## Agenda\n");
    const { result } = await run({
      ...ANSWERS,
      "property:tags:register": true,
      "property:tags:type": "",
      "property:tags:required": false,
      "property:tags:default": false,
      "property:tags:rule": "none",
      "property:tags:meaning": "tags",
      "property:due:register": true,
      "property:due:type": "",
      "property:due:required": false,
      "property:due:default": false,
      "property:due:rule": "none",
      "property:due:meaning": "due",
      "property:at:register": true,
      "property:at:type": "",
      "property:at:required": false,
      "property:at:default": false,
      "property:at:rule": "none",
      "property:at:meaning": "at",
      "property:topic:register": true,
      "property:topic:type": "",
      "property:topic:required": false,
      "property:topic:default": false,
      "property:topic:rule": "none",
      "property:topic:meaning": "topic",
      seal: true,
    });
    expect(result).toMatchObject({ state: "sealed", properties: 5 });
    const properties = (await sealedContract()).properties ?? {};
    expect(Object.fromEntries(["tags", "due", "at", "topic"].map(name => [name, properties[name]?.type]))).toEqual({ tags: "list", due: "date", at: "datetime", topic: "text" });
  });

  it("infers a template value's type only when it is clear", () => {
    expect(templateFieldType("tags: [a, b]")).toBe("list");
    expect(templateFieldType("tags:\n  - a\n  - b")).toBe("list");
    expect(templateFieldType("due: 2026-01-01")).toBe("date");
    expect(templateFieldType("due: '{{ date:YYYY-MM-DD }}'")).toBe("date");
    expect(templateFieldType("at: 2026-01-01T09:30")).toBe("datetime");
    expect(templateFieldType("at: \"{{date:YYYY-MM-DDTHH:mm:ss}}\"")).toBe("datetime");
    expect(templateFieldType("week: \"{{date:YYYY-[W]ww}}\"")).toBe("text");
    expect(templateFieldType("topic: 2026-01-01 kickoff")).toBe("text");
    expect(templateFieldType("owner:\n  name: me")).toBe("text");
  });

  it("never refuses over a template's content, since templates are not sealed", async () => {
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\nowner: me\n---\n## Agenda\n");
    const { result } = await run({ ...ANSWERS, "property:status:meaning": "open or done", "property:owner:register": false, seal: true });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1 });
    expect(Object.keys(await sealedContract()).sort()).toEqual(["folders", "properties"]);
  });
});

describe("non-loosening reseal", () => {
  beforeEach(async () => {
    await sealLegacyHead();
  });

  it("reseals over a version 3 head without a template to compare against", async () => {
    await rm(root, { recursive: true, force: true });
    expect((await run({ ...ANSWERS, seal: true })).result.state).toBe("sealed");
    await mkdir(join(vault, "Journal"));
    const { result } = await run({ "folder:Journal:register": true, "folder:Journal:meaning": "journal", "folder:Journal:search-exclude": true, seal: true });
    expect(result.state).toBe("sealed");
  });

  it("allows a reseal that only adds", async () => {
    await mkdir(join(vault, "Journal"));
    const { result } = await run({ "folder:Journal:register": true, "folder:Journal:meaning": "journal", "folder:Journal:search-exclude": true, seal: true });
    expect(result.state).toBe("sealed");
    expect(Object.keys((await sealedContract()).folders ?? {}).sort()).toEqual(["Journal", "Projects"]);
  });

  it("asks nothing about a legacy template whose source changed", async () => {
    const before = await sealedContract();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n## Notes\n");
    const { result } = await run({ seal: true });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1, warnings: [DROPPED_ONE] });
    expect(await sealedContract()).toEqual({ folders: before.folders, properties: before.properties });
  });

  it("warns, and does not refuse, that the legacy templates are not carried into the v3 contract", async () => {
    const records: unknown[] = [];
    const { io, notes } = scriptedIO({ seal: true });
    const result = await runInterview({ vault, io: { ...io, record: async event => { records.push(event); } }, root, nonLoosening: true });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1, warnings: [DROPPED_ONE] });
    expect(notes).toContain(DROPPED_ONE);
    expect(records).toContainEqual(expect.objectContaining({ type: "proposed", droppedLegacyTemplates: 1 }));
    const store = await readStore(VAULT_ID, root);
    expect(store.state === "ok" && store.legacy).toBeUndefined();
  });

  it("seals over a legacy template whose source is gone, with the same warning and no question", async () => {
    await rm(join(vault, "Templates/Meeting.md"));
    const { result } = await run({ seal: true });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1, warnings: [DROPPED_ONE] });
  });

  it("refuses a seal that needs recovery", async () => {
    const moved = join(base, "moved");
    await rename(vault, moved);
    vault = moved;
    const { result } = await run({ seal: true });
    expect(result.state).toBe("refused");
  });
});

describe("a sealed pattern that today's seal screen refuses", () => {
  const LEGACY = `L${"x".repeat(PATTERN_SOURCE_LIMIT)}`;

  beforeEach(async () => {
    // Sealed the way an older release could have: before today's pattern screen existed.
    await sealLegacyHead({ status: [{ kind: "pattern", regex: LEGACY }], meeting: [{ kind: "allowed", values: ["open", "done"] }, { kind: "pattern", regex: "(a+)+" }] });
    expect(((await sealedContract()).properties?.["status"]?.rules)).toEqual([{ kind: "pattern", regex: LEGACY }]);
  });

  it("refuses an agent reseal as loosening, naming fields and kinds only", async () => {
    const before = await sealedContract();
    const { result, notes } = await run({ seal: true });
    expect(result).toEqual({
      state: "loosening",
      changes: [{ field: "properties.status", kind: "pattern-unsafe" }],
    });
    expect(JSON.stringify(result) + notes.join("\n")).not.toMatch(/xxxx|\(a\+\)\+/);
    expect(await sealedContract()).toEqual(before);
  });

  it("asks the owner for each refused rule again at a full-authority reseal and keeps the other rules", async () => {
    const owner = async (answers: Answers) => {
      const { io, notes } = scriptedIO(answers);
      return { result: await runInterview({ vault, io, root }), notes };
    };
    const incomplete = await owner({});
    if (incomplete.result.state !== "incomplete") throw new Error(incomplete.result.state);
    // The legacy template's refused rule is not carried forward, so it is not asked.
    expect(incomplete.result.questions.map(question => question.id)).toEqual(["property:status:repair:rule", "seal"]);
    expect(incomplete.notes.join("\n")).toContain("The sealed pattern rule for `status` is no longer accepted");
    expect(incomplete.notes.join("\n")).not.toMatch(/xxxx|\(a\+\)\+/);

    const sealed = await owner({
      "property:status:repair:rule": "pattern",
      "property:status:repair:pattern": "[a-z]+",
      seal: true,
    });
    expect(sealed.result.state).toBe("sealed");
    expect(sealed.notes.join("\n")).not.toMatch(/xxxx|\(a\+\)\+/);
    const contract = await sealedContract();
    expect(contract.properties?.["status"]?.rules).toEqual([{ kind: "pattern", regex: "[a-z]+" }]);
    expect(Object.hasOwn(contract, "templates")).toBe(false);
  });
});

describe("parseAnswers", () => {
  it("reads one JSON object of scalar answers", () => {
    expect(parseAnswers("{\"a\": true, \"b\": 2, \"c\": \"x\"}")).toEqual({ a: true, b: 2, c: "x" });
  });

  it("rejects other JSON", () => {
    expect(() => parseAnswers("not json")).toThrow("CONTRACT_ANSWERS_INVALID");
    expect(() => parseAnswers("[1]")).toThrow("CONTRACT_ANSWERS_INVALID");
    expect(() => parseAnswers("{\"a\": null}")).toThrow("CONTRACT_ANSWER_INVALID: a:");
    expect(() => parseAnswers("{\"a\": [\"x\"]}")).toThrow("CONTRACT_ANSWER_INVALID: a:");
  });
});
