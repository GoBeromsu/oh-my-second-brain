import { describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import type { ContractView, PropertyContract, VaultContract } from "../contract/types.js";
import { parseNote } from "../conventions/frontmatter.js";
import { conform, type ConformOptions } from "./conform.js";
import { parseLiveTemplate, selectTemplate, type LiveTemplate } from "./live-templates.js";

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: {
    status: { meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["active", "done"] }] },
    created: { meaning: "creation date", type: "date", default: true, required: false, rules: [] },
    updated: { meaning: "last change", type: "datetime", default: true, required: false, rules: [] },
    due: { meaning: "deadline", type: "date", default: true, required: false, rules: [{ kind: "range", min: "2026-01-01" }] },
    "review date": { meaning: "review", type: "date", default: true, required: false, rules: [] },
    tags: { meaning: "topics", type: "tags", default: true, required: false, rules: [] },
    owner: { meaning: "who owns it", type: "date", default: true, required: true, rules: [] },
  },
};
const SEALED: ContractView = { state: "sealed", contract: CONTRACT };

function live(source: string, text: string): LiveTemplate {
  const template = parseLiveTemplate(source, text);
  if (template === null) throw new Error(`unreadable template ${source}`);
  return template;
}

const PROJECT = live("Templates/project.md", "---\nfolder: Projects\nupdated: 2026-01-01T00:00:00\nstatus: active\nempty:\ntopic: \"{{title}}\"\n---\n## Goals\n\n## 목표\n");
const BARE = live("Templates/bare.md", "Just a body\n");
const TEMPLATES = [BARE, PROJECT];

function chosen(template: LiveTemplate): ConformOptions["scaffold"] {
  return { kind: "template", template };
}

const NOW = new Date(2026, 8, 28, 9, 5, 7);

function options(extra: Partial<ConformOptions> = {}): ConformOptions {
  return { view: SEALED, isNew: false, title: "Alpha", now: NOW, ...extra };
}

function judged(path: string, content: string) {
  const note = parseNote(content);
  return judge({ path, frontmatter: note.frontmatter, body: note.body }, SEALED);
}

describe("conform", () => {
  it("substitutes title, date and time variables in the body", () => {
    const result = conform("# {{title}}\n{{date}} {{ date:YYYY/MM/DD HH:mm:ss }} {{time}}\n", options());
    expect(result.content).toBe("# Alpha\n2026-09-28 2026/09/28 09:05:07 09:05\n");
    expect(result.applied).toEqual([{ field: "content", action: "variable" }]);
  });

  it("leaves unknown formats and formatted title or time variables for the judge", () => {
    const content = "{{date:dddd}} {{title:upper}} {{time:HH}} {{other}}\n";
    expect(conform(content, options())).toEqual({ content, applied: [] });
  });

  it("names the frontmatter key a variable sat in and quotes a title that is not plain YAML", () => {
    const result = conform("---\naliases:\n  - {{title}}\nname: \"{{title}}\"\nother: '{{title}}'\nplain: {{title}}\n---\n", options({ title: "It's: \"x\"" }));
    expect(result.content).toBe("---\naliases:\n  - \"It's: \\\"x\\\"\"\nname: \"It's: \\\"x\\\"\"\nother: 'It''s: \"x\"'\nplain: \"It's: \\\"x\\\"\"\n---\n");
    expect(result.applied).toEqual([
      { field: "aliases", action: "variable" },
      { field: "name", action: "variable" },
      { field: "other", action: "variable" },
      { field: "plain", action: "variable" },
    ]);
  });

  it("adds date and datetime defaults to a new note only, skipping constrained, required and present fields", () => {
    const content = "---\nstatus: active\ncreated: 2020-01-01\n---\nBody\n";
    const fresh = conform(content, options({ isNew: true }));
    expect(fresh.content).toBe("---\nstatus: active\ncreated: 2020-01-01\nupdated: 2026-09-28T09:05:07\n\"review date\": 2026-09-28\n---\nBody\n");
    expect(fresh.applied).toEqual([{ field: "updated", action: "default" }, { field: "review date", action: "default" }]);
    expect(conform(content, options())).toEqual({ content, applied: [] });
  });

  it("adds a frontmatter block when a new note has none, after the template's own values", () => {
    const result = conform("Body\n", options({ isNew: true, scaffold: chosen(BARE) }));
    expect(result.content).toBe("---\ncreated: 2026-09-28\nupdated: 2026-09-28T09:05:07\n\"review date\": 2026-09-28\n---\nBody\n");
    const scaffolded = conform("", options({ isNew: true, scaffold: chosen(PROJECT) }));
    // The template's own `updated` wins over the date default, and its filled variable is kept.
    expect(scaffolded.content).toBe("---\nupdated: 2026-01-01T00:00:00\nstatus: active\ntopic: \"Alpha\"\ncreated: 2026-09-28\n\"review date\": 2026-09-28\n---\n\n## Goals\n\n## 목표\n");
    expect(scaffolded.applied.filter(change => change.action === "default").map(change => change.field)).toEqual(["updated", "status", "topic", "created", "review date"]);
  });

  it("adds the value a default's only fixed rule names, as a list for a list type, on a new note only", () => {
    const fixedView: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: {
      stage: { meaning: "stage", type: "text", default: true, required: false, rules: [{ kind: "fixed", value: "draft" }] },
      kinds: { meaning: "kinds", type: "list", default: true, required: false, rules: [{ kind: "fixed", value: "note" }] },
      picked: { meaning: "pick one", type: "text", default: true, required: false, rules: [{ kind: "allowed", values: ["a", "b"] }] },
      both: { meaning: "two rules", type: "text", default: true, required: false, rules: [{ kind: "fixed", value: "x" }, { kind: "pattern", regex: "^x$" }] },
      // An untyped property takes the fixed value as a single value, not a list.
      loose: { meaning: "untyped", type: null as unknown as PropertyContract["type"], default: true, required: false, rules: [{ kind: "fixed", value: "y" }] },
    } } };
    const result = conform("Body\n", options({ view: fixedView, isNew: true }));
    expect(result.content).toBe("---\nstage: \"draft\"\nkinds: [\"note\"]\nloose: \"y\"\n---\nBody\n");
    expect(result.applied).toEqual([{ field: "stage", action: "default" }, { field: "kinds", action: "default" }, { field: "loose", action: "default" }]);
    expect(conform("Body\n", options({ view: fixedView }))).toEqual({ content: "Body\n", applied: [] });
  });

  it("never adds defaults to malformed frontmatter or an open contract", () => {
    const malformed = "---\n: [\n---\nBody\n";
    expect(conform(malformed, options({ isNew: true }))).toEqual({ content: malformed, applied: [] });
    expect(conform("Body\n", options({ isNew: true, view: { state: "open" } }))).toEqual({ content: "Body\n", applied: [] });
  });

  it("scaffolds a new note from the chosen live template and leaves an existing note alone", () => {
    const result = conform("## Goals\nShip it", options({ isNew: true, scaffold: chosen(PROJECT), view: { state: "open" } }));
    expect(result.content).toBe("---\nupdated: 2026-01-01T00:00:00\nstatus: active\ntopic: \"Alpha\"\n---\n## Goals\nShip it\n\n## 목표\n");
    expect(result.applied).toEqual([
      { field: "updated", action: "default" },
      { field: "status", action: "default" },
      { field: "topic", action: "default" },
      { field: "목표", action: "heading" },
    ]);
    const kept = conform("---\nstatus: done\n---\nx\n\n", options({ isNew: true, scaffold: chosen(PROJECT), view: { state: "open" } }));
    expect(kept.content).toBe("---\nstatus: done\nupdated: 2026-01-01T00:00:00\ntopic: \"Alpha\"\n---\nx\n\n## Goals\n\n## 목표\n");
    expect(conform("Body\n", options({ scaffold: chosen(PROJECT) }))).toEqual({ content: "Body\n", applied: [] });
    expect(conform("Body\n", options({ view: { state: "open" }, isNew: true, scaffold: chosen(BARE) }))).toEqual({ content: "Body\n", applied: [] });
  });

  it("selects the explicit template first, then the unique folder match, and never a choice", () => {
    const meeting = live("Templates/meeting.md", "---\nfolder: Projects\n---\n## Agenda\n");
    expect(selectTemplate(TEMPLATES, { explicit: "bare", folder: "Projects" })).toEqual({ kind: "template", template: BARE });
    expect(selectTemplate(TEMPLATES, { explicit: "Templates/bare.md" })).toEqual({ kind: "template", template: BARE });
    expect(selectTemplate(TEMPLATES, { folder: "Projects" })).toEqual({ kind: "template", template: PROJECT });
    expect(selectTemplate(TEMPLATES, { folder: "Areas/bare" })).toEqual({ kind: "template", template: BARE });
    expect(selectTemplate([...TEMPLATES, meeting], { folder: "Projects" })).toEqual({ kind: "choice", candidates: ["project", "meeting"] });
    expect(selectTemplate(TEMPLATES, { folder: "Areas" })).toEqual({ kind: "none" });
    expect(selectTemplate(TEMPLATES, {})).toEqual({ kind: "none" });
    const open = options({ view: { state: "open" }, isNew: true });
    expect(conform("Body\n", { ...open, scaffold: { kind: "choice", candidates: ["project", "meeting"] } })).toEqual({ content: "Body\n", applied: [] });
    expect(conform("Body\n", { ...open, scaffold: { kind: "none" } })).toEqual({ content: "Body\n", applied: [] });
  });

  it("warns that a named template is missing and scaffolds nothing, for new and existing notes", () => {
    const selection = selectTemplate(TEMPLATES, { explicit: "gone", folder: "Projects" });
    expect(selection).toEqual({ kind: "missing", name: "gone" });
    for (const isNew of [true, false]) {
      const result = conform("Body\n", options({ view: { state: "open" }, isNew, scaffold: selection }));
      expect(result).toEqual({ content: "Body\n", applied: [{ field: "gone", action: "template-missing" }] });
    }
  });

  it("leaves out a template key whose variable it cannot fill, and scaffolds nothing into malformed frontmatter", () => {
    const odd = live("Templates/odd.md", "---\nwhen: \"{{date:dddd}}\"\nkind: log\n---\n");
    expect(conform("", options({ view: { state: "open" }, isNew: true, scaffold: chosen(odd) })).content).toBe("---\nkind: log\n---\n");
    const malformed = "---\n: [\n---\nBody\n";
    expect(conform(malformed, options({ view: { state: "open" }, isNew: true, scaffold: chosen(PROJECT) }))).toEqual({ content: malformed, applied: [] });
  });

  it("leaves out a Templater value or heading, since conform never runs Templater", () => {
    const templater = live("Templates/tp.md", "---\ncreated: <% tp.date.now() %>\ntitle: \"<% tp.file.title %>\"\nkind: log\n---\n# <% tp.file.title %>\n\n## Notes\n");
    const result = conform("", options({ view: { state: "open" }, isNew: true, scaffold: chosen(templater) }));
    expect(result.content).toBe("---\nkind: log\n---\n\n## Notes\n");
    expect(result.applied).toEqual([{ field: "kind", action: "default" }, { field: "Notes", action: "heading" }]);
  });

  it("does not count a heading inside a code fence as present", () => {
    const result = conform("```\n## Goals\n```\n", options({ view: { state: "open" }, isNew: true, scaffold: chosen(live("Templates/h.md", "## Goals\n\n## 목표\n")) }));
    expect(result.content).toBe("```\n## Goals\n```\n\n## Goals\n\n## 목표\n");
  });

  it("never turns a value outside allowed into a passing note", () => {
    const content = "---\nstatus: paused\n---\n# {{title}}\n";
    const before = judged("Projects/a.md", content);
    const result = conform(content, options({ isNew: true, scaffold: chosen(PROJECT) }));
    const after = judged("Projects/a.md", result.content);
    expect(before.warnings).not.toEqual([]);
    expect(after.warnings).toContainEqual(expect.objectContaining({ field: "status" }));
    expect(result.content).toContain("status: paused");
  });

  it("never judges a note against its template: a scaffolded key is only a default", () => {
    const content = "---\nstatus: done\n---\nBody\n";
    const result = conform(content, options({ isNew: true, scaffold: chosen(PROJECT) }));
    expect(result.content).toContain("status: done");
    const note = parseNote(result.content);
    const verdict = judge({ path: "Projects/a.md", frontmatter: note.frontmatter, body: note.body }, SEALED);
    // `topic` is not a sealed property, so it is a property warning like any unknown key.
    expect(verdict.refusals).toEqual([]);
    expect(verdict.warnings).not.toContainEqual(expect.objectContaining({ field: "status" }));
  });

  it("inserts defaults with the note's own CRLF line endings", () => {
    const result = conform("---\r\nstatus: active\r\n---\r\nBody\r\n", options({ isNew: true, scaffold: chosen(BARE) }));
    expect(result.content).toBe("---\r\nstatus: active\r\ncreated: 2026-09-28\r\nupdated: 2026-09-28T09:05:07\r\n\"review date\": 2026-09-28\r\n---\r\nBody\r\n");
    expect(conform("Body\r\n", options({ isNew: true, scaffold: chosen(BARE) })).content).toBe("---\r\ncreated: 2026-09-28\r\nupdated: 2026-09-28T09:05:07\r\n\"review date\": 2026-09-28\r\n---\r\nBody\r\n");
  });

  it("inserts a multi-line template value with the note's CRLF line endings", () => {
    const listed = live("Templates/list.md", "---\ntags:\n  - a\n  - b\nkind: log\n---\n");
    const result = conform("---\r\nstatus: active\r\n---\r\nBody\r\n", options({ view: { state: "open" }, isNew: true, scaffold: chosen(listed) }));
    expect(result.content).toBe("---\r\nstatus: active\r\ntags:\r\n  - a\r\n  - b\r\nkind: log\r\n---\r\nBody\r\n");
  });

  it("never supplies a required property the writer left out", () => {
    const result = conform("Body\n", options({ isNew: true }));
    expect(result.content).not.toContain("owner:");
    expect(judged("Projects/a.md", result.content)).toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ field: "owner" })]) });
  });
});
