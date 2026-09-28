import { describe, expect, it } from "vitest";
import { judge } from "../contract/judge.js";
import type { ContractView, VaultContract } from "../contract/types.js";
import { parseNote } from "../conventions/frontmatter.js";
import { conform, type ConformOptions } from "./conform.js";

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
  templates: {
    project: {
      source: "Templates/project.md",
      sourceHash: `sha256:${"0".repeat(64)}`,
      requiredProperties: [],
      narrowedRules: { updated: [{ kind: "fixed", value: "2026-01-01T00:00:00" }] },
      requiredHeadings: ["Goals", "목표"],
    },
    bare: { source: "Templates/bare.md", sourceHash: `sha256:${"0".repeat(64)}`, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] },
  },
};
const SEALED: ContractView = { state: "sealed", contract: CONTRACT };
const NOW = new Date(2026, 8, 28, 9, 5, 7);

function options(extra: Partial<ConformOptions> = {}): ConformOptions {
  return { view: SEALED, isNew: false, title: "Alpha", now: NOW, ...extra };
}

function judged(path: string, content: string, template?: string) {
  const note = parseNote(content);
  return judge({ path, frontmatter: note.frontmatter, body: note.body, ...(template === undefined ? {} : { selectedTemplate: template }) }, SEALED);
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

  it("adds a frontmatter block when a new note has none, and skips template-narrowed defaults", () => {
    const result = conform("Body\n", options({ isNew: true, template: "bare" }));
    expect(result.content).toBe("---\ncreated: 2026-09-28\nupdated: 2026-09-28T09:05:07\n\"review date\": 2026-09-28\n---\nBody\n");
    const narrowed = conform("", options({ isNew: true, template: "project" }));
    expect(narrowed.applied.filter(change => change.action === "default").map(change => change.field)).toEqual(["created", "review date"]);
  });

  it("never adds defaults to malformed frontmatter or an open contract", () => {
    const malformed = "---\n: [\n---\nBody\n";
    expect(conform(malformed, options({ isNew: true }))).toEqual({ content: malformed, applied: [] });
    expect(conform("Body\n", options({ isNew: true, view: { state: "open" } }))).toEqual({ content: "Body\n", applied: [] });
  });

  it("appends the chosen template's missing headings and only when a template is chosen", () => {
    const result = conform("## Goals\nShip it", options({ template: "project" }));
    expect(result.content).toBe("## Goals\nShip it\n\n## 목표\n");
    expect(result.applied).toEqual([{ field: "목표", action: "heading" }]);
    expect(conform("", options({ template: "project" })).content).toBe("## Goals\n\n## 목표\n");
    expect(conform("x\n", options({ template: "project" })).content).toBe("x\n\n## Goals\n\n## 목표\n");
    expect(conform("x\n\n", options({ template: "project" })).content).toBe("x\n\n## Goals\n\n## 목표\n");
    expect(conform("Body\n", options())).toEqual({ content: "Body\n", applied: [] });
    expect(conform("Body\n", options({ template: "bare" }))).toEqual({ content: "Body\n", applied: [] });
    expect(conform("Body\n", options({ template: "missing" }))).toEqual({ content: "Body\n", applied: [] });
  });

  it("does not count a heading inside a code fence as present", () => {
    const result = conform("```\n## Goals\n```\n", options({ template: "project" }));
    expect(result.content).toBe("```\n## Goals\n```\n\n## Goals\n\n## 목표\n");
    expect(judged("Projects/a.md", result.content, "project").violations.filter(violation => violation.kind.includes("heading"))).toEqual([]);
  });

  it("never turns a value outside allowed into a passing note", () => {
    const content = "---\nstatus: paused\n---\n# {{title}}\n";
    const before = judged("Projects/a.md", content);
    const result = conform(content, options({ isNew: true, template: "project" }));
    const after = judged("Projects/a.md", result.content, "project");
    expect(before.ok).toBe(false);
    expect(after.ok).toBe(false);
    expect(after.violations).toContainEqual(expect.objectContaining({ field: "status" }));
    expect(result.content).toContain("status: paused");
  });

  it("never supplies a required property the writer left out", () => {
    const result = conform("Body\n", options({ isNew: true }));
    expect(result.content).not.toContain("owner:");
    expect(judged("Projects/a.md", result.content)).toMatchObject({ ok: false, violations: expect.arrayContaining([expect.objectContaining({ field: "owner" })]) });
  });
});
