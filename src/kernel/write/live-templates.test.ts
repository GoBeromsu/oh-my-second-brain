import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { loadLiveTemplates, loadLiveTemplateSnapshot, readLiveTemplates, parseLiveTemplate, selectTemplate, templateFields, templatesForFolder, type LiveTemplate } from "./live-templates.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

function template(name: string, folder: string | null = null): LiveTemplate {
  return { name, source: `Templates/${name}.md`, folder, fields: [], headings: [] };
}

describe("templateFields", () => {
  it("splits top-level keys and keeps indented, list and quoted-key lines with their key", () => {
    expect(templateFields("status: open\ntags:\n  - a\n- b\n\"due date\": 2026-01-01\n'x': 1\n\n# comment")).toEqual([
      { name: "status", text: "status: open" },
      { name: "tags", text: "tags:\n  - a\n- b" },
      { name: "due date", text: "\"due date\": 2026-01-01" },
      { name: "x", text: "'x': 1\n# comment" },
    ]);
  });

  it("drops lines before the first key", () => {
    expect(templateFields("  stray\n- item\nkey: v")).toEqual([{ name: "key", text: "key: v" }]);
  });
});

describe("parseLiveTemplate", () => {
  it("reads defaults, headings and the folder selector, skipping empty keys", () => {
    expect(parseLiveTemplate("Templates/Meeting.md", "---\nfolder: /Meetings/\nstatus: open\nowner:\nnote: \"\"\n---\n## Agenda\n### Notes\n")).toEqual({
      name: "Meeting",
      source: "Templates/Meeting.md",
      folder: "Meetings",
      fields: [{ name: "status", text: "status: open" }],
      headings: [{ title: "Agenda", level: 2 }, { title: "Notes", level: 3 }],
    });
  });

  it("has no folder when the selector is blank or not a string", () => {
    expect(parseLiveTemplate("T/A.md", "---\nfolder: \"/\"\n---\n")?.folder).toBeNull();
    expect(parseLiveTemplate("T/A.md", "---\nfolder: 3\n---\n")?.folder).toBeNull();
    expect(parseLiveTemplate("T/A.md", "# Only a body\n")).toMatchObject({ folder: null, fields: [], headings: [{ title: "Only a body", level: 1 }] });
  });

  it("is null for a template whose frontmatter cannot be read", () => {
    expect(parseLiveTemplate("T/Broken.md", "---\nstatus: [open\n---\n")).toBeNull();
  });
});

describe("templatesForFolder and selectTemplate", () => {
  const meeting = template("Meeting", "Work/Meetings");
  const projects = template("Projects");
  const other = template("Other", "Projects");

  it("matches a template by the folder's last segment or by its folder selector", () => {
    expect(templatesForFolder([meeting, projects, other], "/Projects/")).toEqual([projects, other]);
    expect(templatesForFolder([meeting, projects], "Work/Meetings")).toEqual([meeting]);
    expect(templatesForFolder([meeting], undefined)).toEqual([]);
  });

  it("prefers the explicit name, by name, source or source without .md", () => {
    expect(selectTemplate([meeting, projects], { explicit: "Meeting", folder: "Projects" })).toEqual({ kind: "template", template: meeting });
    expect(selectTemplate([meeting], { explicit: "Templates/Meeting" })).toEqual({ kind: "template", template: meeting });
    expect(selectTemplate([meeting], { explicit: "Templates/Meeting.md" })).toEqual({ kind: "template", template: meeting });
  });

  it("reports a named template that is not live as missing", () => {
    expect(selectTemplate([meeting], { explicit: "Nowhere", folder: "Work/Meetings" })).toEqual({ kind: "missing", name: "Nowhere" });
  });

  it("picks the unique folder match, leaves two open as a choice, and scaffolds nothing otherwise", () => {
    expect(selectTemplate([meeting, projects], { folder: "Work/Meetings" })).toEqual({ kind: "template", template: meeting });
    expect(selectTemplate([meeting, projects, other], { folder: "Projects" })).toEqual({ kind: "choice", candidates: ["Projects", "Other"] });
    expect(selectTemplate([meeting], { folder: "Inbox" })).toEqual({ kind: "none" });
    expect(selectTemplate([meeting], {})).toEqual({ kind: "none" });
  });
});

describe("loadLiveTemplates", () => {
  let vault: string;

  beforeEach(async () => {
    vault = await realpath(await mkdtemp(join(tmpdir(), "oms-live-templates-")));
    await mkdir(join(vault, ".oms"));
    await mkdir(join(vault, "Templates"));
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  async function settings(templateFolder?: string): Promise<void> {
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, ...(templateFolder === undefined ? {} : { templateFolder }) }));
  }

  it("has no templates without a recorded template folder", async () => {
    await writeFile(join(vault, "Templates/Meeting.md"), "## Agenda\n");
    expect(await loadLiveTemplates(vault)).toEqual([]);
    await settings();
    expect(await loadLiveTemplates(vault)).toEqual([]);
  });

  it("reads every readable Markdown template, sorted by name, skipping others", async () => {
    await settings("Templates");
    await writeFile(join(vault, "Templates/Zeta.md"), "---\nstatus: open\n---\n");
    await writeFile(join(vault, "Templates/Alpha.md"), "## Agenda\n");
    await writeFile(join(vault, "Templates/Broken.md"), "---\nstatus: [open\n---\n");
    await writeFile(join(vault, "Templates/notes.txt"), "not a template");
    expect((await loadLiveTemplates(vault)).map(live => live.source)).toEqual(["Templates/Alpha.md", "Templates/Zeta.md"]);
  });

  it("has no templates when the template folder is missing", async () => {
    await settings("Nowhere");
    expect(await loadLiveTemplates(vault)).toEqual([]);
  });
  it("witnesses exact source bytes even when only ignored body text changes", async () => {
    await settings("Templates");
    const file = join(vault, "Templates/Meeting.md");
    await writeFile(file, "## Agenda\nBody one\n");
    const before = await loadLiveTemplateSnapshot(vault);
    expect(await loadLiveTemplateSnapshot(vault)).toEqual(before);
    await writeFile(file, "## Agenda\nBody two\n");
    const after = await loadLiveTemplateSnapshot(vault);
    expect(after.templates).toEqual(before.templates);
    expect(after.witness).not.toBe(before.witness);
  });

  it("witnesses malformed sources that scaffold nothing", async () => {
    await settings("Templates");
    const file = join(vault, "Templates/Broken.md");
    await writeFile(file, "---\nstatus: [open\n---\n");
    const before = await loadLiveTemplateSnapshot(vault);
    await writeFile(file, "---\nstatus: [done\n---\n");
    const after = await loadLiveTemplateSnapshot(vault);
    expect(before.templates).toEqual([]);
    expect(after.templates).toEqual([]);
    expect(after.witness).not.toBe(before.witness);
  });

  it("distinguishes unreadable settings from no template folder and keeps best-effort reads", async () => {
    const missing = await loadLiveTemplateSnapshot(vault);
    await writeFile(join(vault, SETTINGS_PATH), "{broken");
    const unreadable = await loadLiveTemplateSnapshot(vault);
    expect(unreadable.templates).toEqual([]);
    expect(unreadable.witness).not.toBe(missing.witness);
    expect(await loadLiveTemplates(vault)).toEqual([]);
    expect(await readLiveTemplates(join(vault, "absent-vault"), "Templates")).toEqual([]);
  });

});
