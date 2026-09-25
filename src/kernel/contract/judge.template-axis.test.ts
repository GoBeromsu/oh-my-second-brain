import { describe, expect, it } from "vitest";
import { judgeContent } from "./judge-write.js";
import type { ContractView, TemplateContract } from "./types.js";

/**
 * The template axis, row by row. X = candidates (templates whose applyFolder covers the
 * path) that the previous content passed; T = the explicitly selected template.
 */

const HASH = `sha256:${"0".repeat(64)}`;

function template(overrides: Partial<TemplateContract> = {}): TemplateContract {
  return { source: "Templates/t.md", sourceHash: HASH, requiredProperties: [], narrowedRules: {}, requiredHeadings: [], ...overrides };
}

function view(templates: Record<string, TemplateContract>): ContractView {
  return { state: "sealed", contract: { folders: null, properties: null, templates } };
}

const A = template({ applyFolder: "Meetings", requiredHeadings: ["Agenda"] });
const B = template({ applyFolder: "Meetings", requiredHeadings: ["Minutes"] });
const PASS_A = "## Agenda\n";
const PASS_B = "## Minutes\n";
const PASS_NONE = "plain\n";

describe("template axis", () => {
  it("1: no candidates, the write passes", () => {
    expect(judgeContent({ path: "Notes/a.md", content: PASS_NONE }, view({ A })).ok).toBe(true);
  });

  it("2: X empty on a new file, content failing the one candidate passes", () => {
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_NONE }, view({ A })).ok).toBe(true);
  });

  it("3: X empty on an edit, old and new content both failing, the write passes", () => {
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_NONE, previousContent: "old\n" }, view({ A })).ok).toBe(true);
  });

  it("4: only templates without applyFolder and none selected, the axis is not applied", () => {
    const loose = template({ requiredHeadings: ["Agenda"] });
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_NONE, previousContent: PASS_A }, view({ loose })).ok).toBe(true);
  });

  it("5: an explicit T without applyFolder that fails is denied", () => {
    const loose = template({ requiredHeadings: ["Agenda"] });
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_NONE, selectedTemplate: "loose" }, view({ loose })).violations)
      .toEqual([{ field: "Agenda", kind: "heading-missing" }]);
  });

  it("6: an empty template in X denies new content with a variable", () => {
    const empty = template({ applyFolder: "Meetings" });
    expect(judgeContent({ path: "Meetings/a.md", content: "{{title}}\n", previousContent: PASS_NONE }, view({ empty })).violations)
      .toEqual([{ field: "content", kind: "unsubstituted-variable" }]);
  });

  it("7: an empty template in X passes content without variables", () => {
    const empty = template({ applyFolder: "Meetings" });
    expect(judgeContent({ path: "Meetings/a.md", content: "changed\n", previousContent: PASS_NONE }, view({ empty })).ok).toBe(true);
  });

  it("8: edit with X={A} where new content passes only B is denied", () => {
    const verdict = judgeContent({ path: "Meetings/a.md", content: PASS_B, previousContent: PASS_A }, view({ A, B }));
    expect(verdict.violations).toEqual([{ field: "Agenda", kind: "heading-missing" }]);
  });

  it("9: edit with X={A,B} where new content passes B, the write passes", () => {
    const both = "## Agenda\n## Minutes\n";
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_B, previousContent: both }, view({ A, B })).ok).toBe(true);
  });

  it("10: an applyFolder mismatch on T is folder-mismatch", () => {
    expect(judgeContent({ path: "Notes/a.md", content: PASS_A, selectedTemplate: "A" }, view({ A })).violations)
      .toEqual([{ field: "path", kind: "folder-mismatch" }]);
  });

  it("11: an edit selecting T outside a non-empty X is template-mismatch", () => {
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_B, previousContent: PASS_A, selectedTemplate: "B" }, view({ A, B })).violations)
      .toEqual([{ field: "template", kind: "template-mismatch" }]);
  });

  it("12: a new file with an explicit T that passes is accepted", () => {
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_A, selectedTemplate: "A" }, view({ A, B })).ok).toBe(true);
  });

  it("13: T passes while another candidate fails, the write passes", () => {
    expect(judgeContent({ path: "Meetings/a.md", content: PASS_B, selectedTemplate: "B" }, view({ A, B })).ok).toBe(true);
  });

  it("breaks least-failing ties by template name", () => {
    const previous = "## Agenda\n## Minutes\n";
    const verdict = judgeContent({ path: "Meetings/a.md", content: PASS_NONE, previousContent: previous }, view({ B, A }));
    expect(verdict.violations).toEqual([{ field: "Agenda", kind: "heading-missing" }]);
  });
});
