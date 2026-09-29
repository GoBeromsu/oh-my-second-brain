import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { enumerateTemplateSources, parseInterpretations, resolveInterpretations, scopedTemplateName, type TemplateInterpretation } from "./interpretation.js";
import { interpretVault } from "./interpretation-fixture.js";
import { runInterview } from "./interview.js";
import { scriptedIO, type Answers } from "./scripted-interview.js";
import { readStore } from "./store.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const SOURCE = "Templates/Meeting.md";
const BYTES = "---\nstatus: open\n---\n## Agenda\n";

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-interpretation-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, ".oms"));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, SOURCE), BYTES);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const ANSWERS: Answers = {
  "folder:Projects:register": false,
  "folder:Templates:register": false,
  "property:status:register": true,
  "property:status:type": "",
  "property:status:required": true,
  "property:status:rule": "none",
  "property:status:meaning": "workflow state",
  "template:Meeting:interpretation": true,
  "template:Meeting:register": true,
  "template:Meeting:field:status:required": true,
  "template:Meeting:field:status:literal": "must-equal",
  "template:Meeting:heading:Agenda": true,
  "template:Meeting:apply-folder": "",
  seal: true,
};

async function run(answers: Answers, interpretations: readonly TemplateInterpretation[]) {
  const { io, notes } = scriptedIO(answers);
  return { result: await runInterview({ vault, io, root, nonLoosening: true, interpretations }), notes };
}

const INTERPRETED: TemplateInterpretation = {
  source: SOURCE,
  observedHash: digestBytes(BYTES),
  fields: [{ name: "status", inferredType: "text", literal: "open", variable: null }],
  headings: [{ title: "Agenda", level: 2, variable: false }],
};

describe("the source OMS enumerates", () => {
  it("reports the path and the digest it computed, and nothing about the content", async () => {
    const result = await enumerateTemplateSources(vault, { path: "Templates", kind: "folder" });
    expect(result).toEqual({ ok: true, sources: [{ path: SOURCE, digest: digestBytes(BYTES) }] });
    expect(JSON.stringify(result)).not.toContain("status");
  });

  it("is what an interpretation's hash is checked against, so a submission cannot supply it", async () => {
    const forged = { ...INTERPRETED, observedHash: digestBytes("other bytes") };
    const resolved = resolveInterpretations("Templates", [{ path: SOURCE, digest: digestBytes(BYTES) }], [forged]);
    expect(resolved).toEqual({ ok: false, reasons: [expect.stringContaining("read from different bytes")] });
  });
});

describe("a submitted interpretation", () => {
  it("decides the template questions, and the sealed values still come from the answers", async () => {
    const { result, notes } = await run(ANSWERS, [INTERPRETED]);
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 0, properties: 1, templates: ["Meeting"] });
    expect(notes).toContain("  template Meeting: properties [status], headings [Agenda]");
    // A version 3 seal stores no templates; the answers shaped only the proposal.
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(store.state);
    expect(Object.hasOwn(store.contract, "templates")).toBe(false);
  });

  it("builds no question OMS was not given: an omitted field is asked about nowhere", async () => {
    // Nothing else in this vault mentions `status`: the Obsidian type map is empty, and
    // OMS cannot see the frontmatter, so dropping the field drops its questions entirely.
    const { io, notes } = scriptedIO({ "folder:Projects:register": false, "folder:Templates:register": false, "template:Meeting:interpretation": true, "template:Meeting:register": true, "template:Meeting:heading:Agenda": true, "template:Meeting:apply-folder": "", seal: true });
    const result = await runInterview({ vault, io, root, nonLoosening: true, interpretations: [{ ...INTERPRETED, fields: [] }] });
    expect(result).toEqual({ state: "sealed", vaultIdCreated: false, folders: 0, properties: 0, templates: ["Meeting"] });
    expect(notes).toContain("  template Meeting: properties [], headings [Agenda]");
  });

  it("is shown to the owner without its literal values, and a declined one seals nothing", async () => {
    const { result, notes } = await run({ ...ANSWERS, "template:Meeting:interpretation": false }, [INTERPRETED]);
    expect(result).toEqual({ state: "interpretation-rejected", templates: ["Meeting"] });
    expect(notes.join("\n")).toContain("property status (text): a fixed value");
    expect(notes.join("\n")).not.toContain("open");
    await expect(readdir(root)).rejects.toThrow();
  });
});

describe("a vault whose templates were not interpreted", () => {
  it("seals nothing and names every source with the hash to read it at", async () => {
    const { result } = await run(ANSWERS, []);
    expect(result).toEqual({ state: "interpretation-required", sources: [{ source: SOURCE, sourceHash: digestBytes(BYTES) }] });
    await expect(readdir(root)).rejects.toThrow();
  });

  it("refuses a partial submission rather than interviewing only the interpreted half", async () => {
    await writeFile(join(vault, "Templates/Daily.md"), "## Log\n");
    const { result } = await run(ANSWERS, [INTERPRETED]);
    expect(result).toEqual({ state: "refused", reasons: [expect.stringContaining("has no interpretation")] });
  });

  it("refuses a submission for a source that is not a template", async () => {
    const { result } = await run(ANSWERS, [INTERPRETED, { ...INTERPRETED, source: "Projects/note.md" }]);
    expect(result).toEqual({ state: "refused", reasons: [expect.stringContaining("not a template source")] });
  });

  it("refuses an interpretation read from bytes the file no longer holds", async () => {
    await writeFile(join(vault, SOURCE), "---\nstatus: closed\n---\n");
    const { result } = await run(ANSWERS, [INTERPRETED]);
    expect(result).toEqual({ state: "refused", reasons: [expect.stringContaining("read it again")] });
  });
});

describe("parseInterpretations", () => {
  it("reads an array or an object keyed by source path", () => {
    expect(parseInterpretations(JSON.stringify([INTERPRETED]))).toEqual([INTERPRETED]);
    const keyed = { [SOURCE]: { observedHash: INTERPRETED.observedHash, fields: INTERPRETED.fields, headings: INTERPRETED.headings } };
    expect(parseInterpretations(JSON.stringify(keyed))).toEqual([INTERPRETED]);
  });

  it("rejects a malformed submission and names the entry, not the vault", () => {
    expect(() => parseInterpretations("nope")).toThrow("CONTRACT_INTERPRETATION_INVALID");
    expect(() => parseInterpretations("3")).toThrow("CONTRACT_INTERPRETATION_INVALID");
    expect(() => parseInterpretations(JSON.stringify([{ ...INTERPRETED, observedHash: "abc" }]))).toThrow(/observedHash as sha256/);
    expect(() => parseInterpretations(JSON.stringify([{ ...INTERPRETED, fields: [{ name: "a", inferredType: "colour" }] }]))).toThrow(/needs one of these types/);
    expect(() => parseInterpretations(JSON.stringify([{ ...INTERPRETED, headings: [{ title: "A", level: 9 }] }]))).toThrow(/level from 1 to 6/);
    expect(() => parseInterpretations(JSON.stringify([INTERPRETED, INTERPRETED]))).toThrow(/submitted twice/);
    expect(() => parseInterpretations(JSON.stringify([{ ...INTERPRETED, fields: [INTERPRETED.fields[0], INTERPRETED.fields[0]] }]))).toThrow(/appears twice/);
  });
});

describe("a template in a subfolder", () => {
  it("is named by its scope, so two files of the same name do not collide", async () => {
    expect(scopedTemplateName("Templates", "Templates/Meeting.md")).toBe("Meeting");
    expect(scopedTemplateName("Templates/", "Templates/Work/Meeting.md")).toBe("Work__Meeting");

    await mkdir(join(vault, "Templates/Work"));
    await writeFile(join(vault, "Templates/Work/Meeting.md"), "## Log\n");
    const { result } = await run({
      ...ANSWERS,
      "template:Work__Meeting:interpretation": true,
      "template:Work__Meeting:register": true,
      "template:Work__Meeting:heading:Log": true,
      "template:Work__Meeting:apply-folder": "",
    }, await interpretVault(vault));
    expect(result).toMatchObject({ state: "sealed", templates: ["Meeting", "Work__Meeting"] });
  });
});
