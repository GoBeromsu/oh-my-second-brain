import { describe, expect, it } from "vitest";
import { evaluateTemplateWriteContract, type TemplateWriteContract } from "./write-contract.js";

const contract: TemplateWriteContract = {
  fields: [
    { name: "title", type: "string", required: true, normalize: "trim" },
    { name: "status", type: "string", normalize: "lower", allowedValues: ["draft", "published"] },
    { name: "source-url", type: "url", format: "url" },
  ],
  additionalProperties: "preserve",
};

describe("evaluateTemplateWriteContract", () => {
  it("normalizes declared fields and preserves unknown fields", () => {
    expect(evaluateTemplateWriteContract(
      { title: " A title ", status: "DRAFT", unknown: { retained: true } },
      contract,
    )).toEqual({
      valid: true,
      frontmatter: { title: "A title", status: "draft", unknown: { retained: true } },
      violations: [],
    });
  });

  it("reports required, type, allowed-values, and URL format violations", () => {
    const result = evaluateTemplateWriteContract(
      { title: "", status: "archived", "source-url": "not-a-url" },
      contract,
    );
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title", rule: "required" }),
      expect.objectContaining({ field: "status", rule: "allowed-values" }),
      expect.objectContaining({ field: "source-url", rule: "format" }),
    ]));
  });
});
