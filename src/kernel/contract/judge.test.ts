import { describe, expect, it } from "vitest";
import { insideApplyFolder, judge, judgeNote } from "./judge.js";
import type { SealedField, SealedLayer } from "./types.js";

const SEAL = "00000000-0000-4000-8000-000000000001";

function field(name: string, overrides: Partial<SealedField> = {}): SealedField {
  return { name, type: "text", required: false, description: "", rules: [], variable: null, ...overrides };
}

function layer(overrides: Partial<SealedLayer> = {}): SealedLayer {
  return { sealId: SEAL, fields: [], requiredHeadings: [], applyFolder: null, sourcePath: null, sourceHash: null, answers: {}, ...overrides };
}

const base = { body: "", notePath: "Notes/a.md" };

describe("judge", () => {
  it("reports required before type and skips rules on a missing value", () => {
    const layers = [layer({ fields: [field("status", { required: true, rules: [{ kind: "allowed", values: ["open"] }] })] })];
    expect(judge({ ...base, frontmatter: {}, layers })).toEqual([{ field: "status", kind: "required" }]);
    expect(judge({ ...base, frontmatter: { status: "  " }, layers })).toEqual([{ field: "status", kind: "required" }]);
  });

  it("reports type mismatches, including invalid Obsidian tags", () => {
    const layers = [layer({ fields: [field("count", { type: "number" }), field("tags", { type: "tags" }), field("day", { type: "date" })] })];
    expect(judge({ ...base, frontmatter: { count: "3", tags: ["[[link]]"], day: "2024-02-30" }, layers })).toEqual([
      { field: "count", kind: "type" },
      { field: "tags", kind: "type" },
      { field: "day", kind: "type" },
    ]);
    expect(judge({ ...base, frontmatter: { count: 3, tags: ["area/work"], day: "2024-02-29" }, layers })).toEqual([]);
  });

  it("checks allowed, fixed, pattern and range rules without naming values", () => {
    const layers = [layer({
      fields: [
        field("status", { rules: [{ kind: "allowed", values: ["open", "done"] }] }),
        field("kind", { rules: [{ kind: "fixed", value: "project" }] }),
        field("code", { rules: [{ kind: "pattern", regex: "[A-Z]{3}-\\d+" }] }),
        field("score", { type: "number", rules: [{ kind: "range", min: 1, max: 5 }] }),
      ],
    })];
    const bad = judge({ ...base, frontmatter: { status: "wip", kind: "area", code: "ab-1", score: 9 }, layers });
    expect(bad).toEqual([
      { field: "status", kind: "not-allowed" },
      { field: "kind", kind: "not-fixed" },
      { field: "code", kind: "pattern" },
      { field: "score", kind: "range" },
    ]);
    expect(JSON.stringify(bad)).not.toMatch(/open|done|project|\[A-Z\]/);
    expect(judge({ ...base, frontmatter: { status: "done", kind: "project", code: "ABC-12", score: 5 }, layers })).toEqual([]);
  });

  it("compares strings in NFC and checks every list member", () => {
    const layers = [layer({ fields: [field("tags", { type: "tags", rules: [{ kind: "allowed", values: ["café", "work"] }] })] })];
    expect(judge({ ...base, frontmatter: { tags: ["café"] }, layers })).toEqual([]);
    expect(judge({ ...base, frontmatter: { tags: ["work", "home"] }, layers })).toEqual([{ field: "tags", kind: "not-allowed" }]);
  });

  it("treats an invalid regex and a range type mismatch as violations", () => {
    const layers = [layer({ fields: [
      field("code", { rules: [{ kind: "pattern", regex: "(" }] }),
      field("when", { rules: [{ kind: "range", min: 3 }] }),
      field("name", { rules: [{ kind: "range", min: "b", max: "d" }] }),
    ] })];
    expect(judge({ ...base, frontmatter: { code: "x", when: "5", name: "c" }, layers })).toEqual([
      { field: "code", kind: "pattern" },
      { field: "when", kind: "range" },
    ]);
  });

  it("allows extra properties and ignores absent optional fields", () => {
    const layers = [layer({ fields: [field("status", { rules: [{ kind: "fixed", value: "x" }] })] })];
    expect(judge({ ...base, frontmatter: { other: 1 }, layers })).toEqual([]);
  });

  it("reports unsubstituted variables in frontmatter and body", () => {
    expect(judge({ body: "Made <% tp.date.now() %>", notePath: "a.md", frontmatter: { created: "{{date}}", list: ["ok", { deep: "{{x}}" }] }, layers: [] })).toEqual([
      { field: "created", kind: "unsubstituted-variable" },
      { field: "list", kind: "unsubstituted-variable" },
      { field: null, kind: "unsubstituted-variable" },
    ]);
  });

  it("requires headings at any level and in any order, including setext", () => {
    const layers = [layer({ requiredHeadings: ["Summary", "Next steps"] })];
    expect(judge({ ...base, frontmatter: {}, body: "### Next steps\n\nSummary\n=======\n", layers })).toEqual([]);
    expect(judge({ ...base, frontmatter: {}, body: "## Summary\n```\n# Next steps\n```\n", layers })).toEqual([{ field: "Next steps", kind: "heading-missing" }]);
  });

  it("confines notes to the apply folder, nested folders allowed", () => {
    const layers = [layer({ applyFolder: "Projects" })];
    expect(judge({ body: "", frontmatter: {}, notePath: "Projects/2024/a.md", layers })).toEqual([]);
    expect(judge({ body: "", frontmatter: {}, notePath: "ProjectsX/a.md", layers })).toEqual([{ field: null, kind: "outside-apply-folder" }]);
    expect(insideApplyFolder("Projects\\a.md", "Projects/")).toBe(true);
    expect(insideApplyFolder("Projécts/a.md".normalize("NFD"), "Projécts".normalize("NFC"))).toBe(true);
  });

  it("deduplicates the same violation from common and template layers", () => {
    const shared = field("status", { required: true });
    expect(judge({ ...base, frontmatter: {}, layers: [layer({ fields: [shared] }), layer({ fields: [shared] })] })).toEqual([{ field: "status", kind: "required" }]);
  });
});

describe("judgeNote", () => {
  it("reports malformed YAML as the only violation", () => {
    expect(judgeNote({ content: "---\na: [\n---\n", notePath: "a.md", layers: [layer({ requiredHeadings: ["X"] })] })).toEqual([{ field: null, kind: "yaml-syntax" }]);
  });

  it("judges parsed frontmatter and body", () => {
    const layers = [layer({ fields: [field("status", { required: true })], requiredHeadings: ["Log"] })];
    expect(judgeNote({ content: "---\nstatus: open\n---\n# Log\n", notePath: "a.md", layers })).toEqual([]);
  });
});
