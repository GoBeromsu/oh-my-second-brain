import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { runInterview } from "./interview.js";
import { parseAnswers, publicQuestion, scriptedIO, type Answers } from "./scripted-interview.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { readStore } from "./store.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

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
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
});

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
  "template:Meeting:register": true,
  "template:Meeting:field:status:required": true,
  "template:Meeting:field:status:literal": "one-of-allowed",
  "template:Meeting:field:status:allowed": "open, done",
  "template:Meeting:heading:Agenda": true,
  "template:Meeting:apply-folder": "Projects",
};

async function run(answers: Answers, extra: { readonly reask?: boolean } = {}) {
  const { io, notes } = scriptedIO(answers);
  return { result: await runInterview({ vault, io, root, nonLoosening: true, ...extra }), notes };
}

async function sealedContract() {
  const store = await readStore(VAULT_ID, root);
  if (store.state !== "ok") throw new Error(`store ${store.state}`);
  return store.contract;
}

describe("scripted interview questions", () => {
  it("lists the first questions from the interview itself and writes nothing", async () => {
    const { result } = await run({});
    if (result.state !== "incomplete") throw new Error(result.state);
    expect(result.questions.map(question => question.id)).toEqual([
      "folder:Projects:register",
      "folder:Templates:register",
      "property:status:register",
      "template:Meeting:register",
      "seal",
    ]);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("asks follow-up questions once their parent is answered", async () => {
    const { result } = await run({ "folder:Projects:register": true, "template:Meeting:register": true });
    if (result.state !== "incomplete") throw new Error(result.state);
    const ids = result.questions.map(question => question.id);
    expect(ids).toEqual(expect.arrayContaining(["folder:Projects:meaning", "folder:Projects:search-exclude", "template:Meeting:field:status:required", "template:Meeting:field:status:literal"]));
    expect(ids).not.toContain("template:Meeting:field:status:allowed");
  });

  it("asks the template folder first when the vault names none", async () => {
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
    const { result } = await run({});
    expect(result).toEqual({ state: "incomplete", questions: [expect.objectContaining({ id: "template-folder:path", kind: "text" })] });
  });

  it("prints choices and defaults but never a secret default", () => {
    expect(publicQuestion({ id: "a", prompt: "p", kind: "choice", options: ["x", "y"] })).toEqual({ id: "a", prompt: "p", kind: "choice", choices: ["x", "y"] });
    expect(publicQuestion({ id: "b", prompt: "p", kind: "confirm", initial: true })).toEqual({ id: "b", prompt: "p", kind: "confirm", default: true });
    expect(publicQuestion({ id: "c", prompt: "p", kind: "text", initial: "text" })).toEqual({ id: "c", prompt: "p", kind: "text", default: "text" });
    expect(publicQuestion({ id: "d", prompt: "p", kind: "text", initial: "open, done", secret: true })).toEqual({ id: "d", prompt: "p", kind: "text" });
  });
});

describe("scripted interview answers", () => {
  it("stops before the seal with the public preview, then seals once the seal is answered", async () => {
    const first = await run(ANSWERS);
    expect(first.result).toEqual({ state: "incomplete", questions: [expect.objectContaining({ id: "seal", kind: "confirm" })] });
    expect(first.notes).toContain("Public part (agents will see this):");
    await expect(readdir(root)).rejects.toThrow();

    const second = await run({ ...ANSWERS, seal: true });
    expect(second.result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 1, properties: 1, templates: ["Meeting"] });
    expect((await sealedContract()).templates["Meeting"]?.narrowedRules).toEqual({ status: [{ kind: "allowed", values: ["open", "done"] }] });
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
    const { result } = await run({ ...ANSWERS, "property:status:meaning": "open or done", seal: true });
    expect(result.state).toBe("refused");
    await expect(readdir(root)).rejects.toThrow();
  });
});

describe("non-loosening reseal", () => {
  beforeEach(async () => {
    expect((await run({ ...ANSWERS, seal: true })).result.state).toBe("sealed");
  });

  it("allows a reseal that only adds", async () => {
    await mkdir(join(vault, "Journal"));
    const { result } = await run({ "folder:Journal:register": true, "folder:Journal:meaning": "journal", "folder:Journal:search-exclude": true, seal: true });
    expect(result.state).toBe("sealed");
    expect(Object.keys((await sealedContract()).folders ?? {}).sort()).toEqual(["Journal", "Projects"]);
  });

  it("allows a changed template answered exactly as before", async () => {
    const before = await sealedContract();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n## Notes\n");
    const { result } = await run({
      "template:Meeting:register": true,
      "template:Meeting:field:status:required": true,
      "template:Meeting:field:status:literal": "one-of-allowed",
      "template:Meeting:field:status:allowed": "open, done",
      "template:Meeting:heading:Agenda": true,
      "template:Meeting:heading:Notes": false,
      "template:Meeting:apply-folder": "Projects",
      seal: true,
    });
    expect(result.state).toBe("sealed");
    const after = (await sealedContract()).templates["Meeting"]!;
    expect(after.sourceHash).not.toBe(before.templates["Meeting"]!.sourceHash);
    expect({ ...after, sourceHash: "" }).toEqual({ ...before.templates["Meeting"]!, sourceHash: "" });
  });

  it("refuses a changed template answered more strictly, which the judge would stop enforcing on notes that fail it", async () => {
    const before = await sealedContract();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n## Notes\n");
    const { result } = await run({
      "template:Meeting:register": true,
      "template:Meeting:field:status:required": true,
      "template:Meeting:field:status:literal": "must-equal",
      "template:Meeting:heading:Agenda": true,
      "template:Meeting:heading:Notes": true,
      "template:Meeting:apply-folder": "Projects",
      seal: true,
    });
    expect(result).toEqual({
      state: "loosening",
      changes: [
        { field: "templates.Meeting.narrowedRules.status", kind: "template-tightened" },
        { field: "templates.Meeting.requiredHeadings.Notes", kind: "template-tightened" },
      ],
    });
    expect(await sealedContract()).toEqual(before);
  });

  it("refuses a looser answer, names fields and kinds only and keeps the sealed contract", async () => {
    const before = await sealedContract();
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n## Notes\n");
    const { result, notes } = await run({
      "template:Meeting:register": true,
      "template:Meeting:field:status:required": false,
      "template:Meeting:field:status:literal": "example-only",
      "template:Meeting:heading:Agenda": true,
      "template:Meeting:heading:Notes": true,
      "template:Meeting:apply-folder": "",
      seal: true,
    });
    expect(result).toEqual({
      state: "loosening",
      changes: [
        { field: "templates.Meeting.requiredProperties.status", kind: "required-dropped" },
        { field: "templates.Meeting.narrowedRules.status", kind: "rule-removed" },
        { field: "templates.Meeting.requiredHeadings.Notes", kind: "template-tightened" },
        { field: "templates.Meeting.applyFolder", kind: "apply-folder-changed" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/"(open|done)"/);
    expect(notes).not.toContain("Public part (agents will see this):");
    expect(await sealedContract()).toEqual(before);
  });

  it("refuses a new template scoped inside a sealed scoped template's folder", async () => {
    const before = await sealedContract();
    await writeFile(join(vault, "Templates/Daily.md"), "## Log\n");
    const { result } = await run({
      "template:Daily:register": true,
      "template:Daily:heading:Log": true,
      "template:Daily:apply-folder": "Projects/Daily",
      seal: true,
    });
    expect(result).toEqual({ state: "loosening", changes: [{ field: "templates.Daily.applyFolder", kind: "apply-folder-overlap" }] });
    expect(await sealedContract()).toEqual(before);
  });

  it("refuses removing a template whose source is gone", async () => {
    await rm(join(vault, "Templates/Meeting.md"));
    const { result } = await run({ "template:Meeting:remove": true, seal: true });
    expect(result).toEqual({ state: "loosening", changes: [{ field: "templates.Meeting", kind: "removed" }] });
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

  /** Rewrites one file of the linked generation the way an older release could have sealed it. */
  async function rewriteGeneration(file: string, change: (value: Record<string, unknown>) => void): Promise<void> {
    const directory = join(root, (await readdir(root)).find(entry => entry.startsWith(`.${VAULT_ID}.`))!);
    const value = JSON.parse(await readFile(join(directory, file), "utf8")) as Record<string, unknown>;
    change(value);
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(join(directory, file), bytes);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { files: Record<string, string> };
    manifest.files[file] = digestBytes(bytes);
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  }

  beforeEach(async () => {
    expect((await run({ ...ANSWERS, seal: true })).result.state).toBe("sealed");
    await rewriteGeneration("properties.json", value => {
      (value["properties"] as Record<string, { rules: unknown[] }>)["status"]!.rules = [{ kind: "pattern", regex: LEGACY }];
    });
    await rewriteGeneration("templates/Meeting.json", value => {
      value["narrowedRules"] = { status: [{ kind: "allowed", values: ["open", "done"] }, { kind: "pattern", regex: "(a+)+" }] };
    });
    expect(((await sealedContract()).properties?.["status"]?.rules)).toEqual([{ kind: "pattern", regex: LEGACY }]);
  });

  it("refuses an agent reseal as loosening, naming fields and kinds only", async () => {
    const before = await sealedContract();
    const { result, notes } = await run({ seal: true });
    expect(result).toEqual({
      state: "loosening",
      changes: [
        { field: "properties.status", kind: "pattern-unsafe" },
        { field: "templates.Meeting.narrowedRules.status", kind: "pattern-unsafe" },
      ],
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
    expect(incomplete.result.questions.map(question => question.id)).toEqual(["property:status:repair:rule", "template:Meeting:repair:status:rule", "seal"]);
    expect(incomplete.notes.join("\n")).toContain("The sealed pattern rule for `status` is no longer accepted");
    expect(incomplete.notes.join("\n")).not.toMatch(/xxxx|\(a\+\)\+/);

    const sealed = await owner({
      "property:status:repair:rule": "pattern",
      "property:status:repair:pattern": "[a-z]+",
      "template:Meeting:repair:status:rule": "none",
      seal: true,
    });
    expect(sealed.result.state).toBe("sealed");
    expect(sealed.notes.join("\n")).not.toMatch(/xxxx|\(a\+\)\+/);
    const contract = await sealedContract();
    expect(contract.properties?.["status"]?.rules).toEqual([{ kind: "pattern", regex: "[a-z]+" }]);
    expect(contract.templates["Meeting"]?.narrowedRules).toEqual({ status: [{ kind: "allowed", values: ["open", "done"] }] });
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
