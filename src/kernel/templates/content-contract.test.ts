import { describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { evaluateTemplateBodyContract } from "./content-contract.js";
import { composeTemplateContract } from "./defaults.js";

function heading(headingId: string, title: string, level: number, origin: "default" | "template") {
  return { headingId, title, level, required: true as const, origin };
}

function contract(headings: ReturnType<typeof heading>[], headingOrder: "unordered" | "strict") {
  return { headings, headingOrder };
}

describe("evaluateTemplateBodyContract", () => {
  it("ignores headings inside fenced code, including a longer unclosed run", () => {
    const required = contract([heading("summary", "Summary", 2, "default")], "unordered");
    const closed = ["```markdown", "# Summary", "## Summary", "```", "## Summary", "### Notes"].join("\n");
    expect(evaluateTemplateBodyContract(closed, required)).toEqual({ valid: true, violations: [] });
    const onlyInside = ["```", "## Summary", "```"].join("\n");
    expect(evaluateTemplateBodyContract(onlyInside, required).violations.map(item => item.ruleId)).toEqual(["HEADING_MISSING"]);
    const longer = ["`````", "## Summary", "```", "## Summary", "`````", "## Real"].join("\n");
    expect(evaluateTemplateBodyContract(longer, contract([heading("real", "Real", 2, "default")], "unordered")).valid).toBe(true);
    expect(evaluateTemplateBodyContract(longer, required).violations[0]).toEqual({
      ruleId: "HEADING_MISSING",
      headingId: "summary",
      message: "Required heading summary (Summary) at level 2 is missing.",
    });
    const unclosed = ["~~~", "## Summary", "~~~ trailing", "# Also hidden"].join("\n");
    expect(evaluateTemplateBodyContract(unclosed, required).violations[0]?.ruleId).toBe("HEADING_MISSING");
    const hiddenThenWrong = ["```", "## Summary", "```", "# Summary"].join("\n");
    expect(evaluateTemplateBodyContract(hiddenThenWrong, required).violations).toEqual([{
      ruleId: "HEADING_LEVEL_MISMATCH",
      headingId: "summary",
      message: "Heading summary (Summary) must be level 2, not 1.",
    }]);
  });

  it("reports a missing heading and a title that occurs only at the wrong level", () => {
    const required = contract([
      heading("summary", "Summary", 2, "default"),
      heading("sources", "Sources", 3, "template"),
    ], "unordered");
    const result = evaluateTemplateBodyContract("# Summary\n", required);
    expect(result.valid).toBe(false);
    expect(result.violations.map(item => [item.ruleId, item.headingId])).toEqual([
      ["HEADING_LEVEL_MISMATCH", "summary"],
      ["HEADING_MISSING", "sources"],
    ]);
    expect(result.violations[0]?.message).toBe("Heading summary (Summary) must be level 2, not 1.");
    expect(evaluateTemplateBodyContract("## summary\n", contract([heading("summary", "Summary", 2, "default")], "unordered")).violations[0]?.ruleId)
      .toBe("HEADING_MISSING");
    expect(evaluateTemplateBodyContract(["Summary", "===="].join("\n"), contract([heading("summary", "Summary", 1, "default")], "unordered")).violations[0]?.ruleId)
      .toBe("HEADING_MISSING");
    expect(evaluateTemplateBodyContract("## {{title}}\n", contract([heading("day", "Monday", 2, "default")], "unordered")).valid).toBe(false);
    expect(evaluateTemplateBodyContract("\uFEFF## Summary ##\n<!-- oms:content -->\n", contract([heading("summary", "Summary", 2, "default")], "unordered")).valid)
      .toBe(true);
    expect(evaluateTemplateBodyContract("## e\u0301\n", contract([heading("accent", "\u00e9", 2, "default")], "unordered")).valid).toBe(true);
    expect(evaluateTemplateBodyContract("", contract([], "unordered"))).toEqual({ valid: true, violations: [] });
    expect(evaluateTemplateBodyContract("# Anything\n```\n# Hidden\n```\n", contract([], "strict")).valid).toBe(true);
  });

  it("enforces strict order and allows unordered bodies with extra descendants", () => {
    const headings = [
      heading("summary", "Summary", 2, "default"),
      heading("sources", "Sources", 2, "template"),
    ];
    const swapped = "## Sources\n### Notes\n## Summary\n";
    const ordered = "## Summary\n### Notes\n# Extra\n## Sources\n";
    expect(evaluateTemplateBodyContract(ordered, contract(headings, "strict"))).toEqual({ valid: true, violations: [] });
    expect(evaluateTemplateBodyContract(ordered, contract(headings, "unordered")).valid).toBe(true);
    const outOfOrder = evaluateTemplateBodyContract(swapped, contract(headings, "strict"));
    expect(outOfOrder.valid).toBe(false);
    expect(outOfOrder.violations).toEqual([{
      ruleId: "HEADING_ORDER_MISMATCH",
      headingId: "sources",
      message: "Heading sources (Sources) must follow summary (Summary) when heading order is strict.",
    }]);
    expect(evaluateTemplateBodyContract(swapped, contract(headings, "unordered")).valid).toBe(true);
    const missingAndOrdered = evaluateTemplateBodyContract("## Summary\n", contract(headings, "strict"));
    expect(missingAndOrdered.violations.map(item => item.ruleId)).toEqual(["HEADING_MISSING"]);
  });

  it("does not mutate the contract or treat optional headings as supported", () => {
    const headings = [heading("summary", "Summary", 2, "default")];
    const source = { headings, headingOrder: "strict" as const };
    const before = structuredClone(source);
    const body = "## Summary\n### Free\n";
    const result = evaluateTemplateBodyContract(body, source);
    expect(result.valid).toBe(true);
    expect(source).toEqual(before);
    expect(source.headings).toBe(headings);
    expect(body).toBe("## Summary\n### Free\n");
    expect(() => evaluateTemplateBodyContract(body, { headings: [{ ...headings[0], required: false }], headingOrder: "unordered" })).toThrow(/required must be true/);
    expect(() => evaluateTemplateBodyContract(body, { headings: [{ ...headings[0], level: 7 }], headingOrder: "unordered" })).toThrow(/CONTENT_CONTRACT_INVALID/);
    expect(() => evaluateTemplateBodyContract(1 as unknown as string, source)).toThrow(/CONTENT_CONTRACT_INVALID: body must be a string/);
  });

  it("evaluates a composed contract without reading headings out of the approved markdown", () => {
    const markdown = "# Not a contract heading\n";
    const raw = {
      version: 4 as const,
      properties: {},
      default: {
        templatePath: ".oms/templates/default.md",
        approvedMarkdown: markdown,
        approvedMarkdownDigest: digestBytes(markdown),
        fields: {},
        headings: [{ headingId: "summary", title: "Summary", level: 2, required: true }],
        semanticCriteria: [],
      },
      templates: {
        literature: {
          templateId: "literature",
          templatePath: ".oms/templates/literature.md",
          approvedMarkdown: "Body\n",
          approvedMarkdownDigest: digestBytes("Body\n"),
          fields: {},
          headings: [{ headingId: "sources", title: "Sources", level: 2, required: true }],
          semanticCriteria: [],
          headingOrder: "strict",
        },
      },
    };
    const composed = composeTemplateContract(raw, "literature");
    expect(composed.approved.defaultLayer.approvedMarkdown).toBe(markdown);
    expect(composed.headings.map(item => item.title)).toEqual(["Summary", "Sources"]);
    expect(evaluateTemplateBodyContract("## Summary\n### Child\n## Sources\n", composed).valid).toBe(true);
    const fenced = evaluateTemplateBodyContract("```\n## Summary\n## Sources\n```\n", composed);
    expect(fenced.valid).toBe(false);
    expect(fenced.violations.map(item => item.headingId)).toEqual(["summary", "sources"]);
    expect(evaluateTemplateBodyContract("## Sources\n## Summary\n", composed).violations[0]?.ruleId).toBe("HEADING_ORDER_MISMATCH");
  });
});
