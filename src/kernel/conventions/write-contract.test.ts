import { describe, expect, it } from "vitest";
import { digestBytes } from "../templates/canonical.js";
import type { JsonValue, ObsidianContractType, ResolvedContract, ResolvedField } from "../templates/types.js";
import { evaluateResolvedTemplateContract } from "./write-contract.js";

function contract(fields: Readonly<Record<string, ResolvedField>> = {}): ResolvedContract {
  return {
    templateId: null, fields, headings: [], headingOrder: "unordered", semanticCriteria: [],
    approved: { defaultLayer: { templatePath: ".oms/templates/default.md" as ResolvedContract["approved"]["defaultLayer"]["templatePath"], approvedMarkdown: "", approvedMarkdownDigest: digestBytes("") } },
    contractDigest: digestBytes("contract"),
  };
}
function field(type: ObsidianContractType, extra: Partial<ResolvedField> = {}): ResolvedField {
  return { property: "value", type, intent: "Approved user meaning", required: false, ...extra };
}

describe("v4 note mechanical contract", () => {
  it("keeps template-free notes and undeclared properties without inventing field meaning", () => {
    const note = { cover_url: 42, arbitrary: { nested: true }, status: "Unmanaged" };
    const before = structuredClone(note);
    expect(evaluateResolvedTemplateContract(note, contract(), "free prose")).toEqual({ valid: true, violations: [] });
    expect(note).toEqual(before);
  });
  it.each<readonly [ObsidianContractType, JsonValue]>([
    ["text", " x "], ["string", "text"], ["select", "chosen"], ["file", "[[Note]]"],
    ["number", 0], ["boolean", false], ["checkbox", true], ["date", "2024-02-29"],
    ["datetime", "2024-02-29T12:30:00+09:00"], ["list", [1, { k: true }]],
    ["multi", [1, false]], ["multitext", ["a"]], ["tags", ["tag"]], ["aliases", ["Alias"]],
  ])("accepts declared %s values without normalizing them", (type, value) => {
    const note = { value };
    const before = structuredClone(note);
    expect(evaluateResolvedTemplateContract(note, contract({ value: field(type, { required: true }) }), "").valid).toBe(true);
    expect(note).toEqual(before);
  });
  it.each<readonly [ObsidianContractType, JsonValue]>([
    ["text", 1], ["number", "1"], ["number", Infinity], ["boolean", "false"],
    ["date", "2023-02-29"], ["date", "2024-13-01"], ["date", "tomorrow"],
    ["datetime", "2024-02-30T12:00:00Z"], ["datetime", "2024-02-29"], ["datetime", "2024-02-29Tbad"],
    ["tags", [1]], ["multitext", [false]], ["aliases", "one"], ["list", {}],
  ])("rejects incompatible %s values", (type, value) => {
    expect(evaluateResolvedTemplateContract({ value }, contract({ value: field(type) }), "").violations)
      .toEqual([expect.objectContaining({ field: "value", rule: "type" })]);
  });
  it.each([undefined, null, "", "  ", []])("reports missing required values without supplying defaults: %s", value => {
    const note = value === undefined ? {} : { value };
    const before = structuredClone(note);
    expect(evaluateResolvedTemplateContract(note, contract({ value: field("text", { required: true }) }), "").violations)
      .toEqual([expect.objectContaining({ rule: "required" })]);
    expect(note).toEqual(before);
  });
  it("allows absent optional values and applies enum constraints to each list item", () => {
    const policy = contract({ value: field("tags", { allowedValues: ["allowed"] }) });
    expect(evaluateResolvedTemplateContract({}, policy, "").valid).toBe(true);
    expect(evaluateResolvedTemplateContract({ value: null }, policy, "").valid).toBe(true);
    expect(evaluateResolvedTemplateContract({ value: ["allowed"] }, policy, "").valid).toBe(true);
    expect(evaluateResolvedTemplateContract({ value: ["allowed", "other"] }, policy, "").violations)
      .toEqual([expect.objectContaining({ rule: "allowed-values" })]);
    expect(evaluateResolvedTemplateContract({ value: "other" }, contract({ value: field("select", { allowedValues: ["allowed"] }) }), "").valid).toBe(false);
  });
  it("enforces only explicitly declared HTTP(S) URL format", () => {
    const policy = contract({ source: field("text", { format: "url" }) });
    expect(evaluateResolvedTemplateContract({ source: "https://example.org/path" }, policy, "").valid).toBe(true);
    for (const source of ["ftp://example.org", "not a url"]) {
      expect(evaluateResolvedTemplateContract({ source }, policy, "").violations)
        .toEqual([expect.objectContaining({ field: "source", rule: "format" })]);
    }
  });
  it("validates the entire body on every check rather than bypassing append checks", () => {
    const policy: ResolvedContract = { ...contract(), headings: [{ headingId: "approved", title: "Approved section", level: 2, required: true, origin: "default" }] };
    expect(evaluateResolvedTemplateContract({}, policy, "## Approved section\nFree content").valid).toBe(true);
    expect(evaluateResolvedTemplateContract({}, policy, "only new appended text").violations)
      .toEqual([expect.objectContaining({ rule: "heading" })]);
    expect(() => evaluateResolvedTemplateContract({}, policy, undefined as never)).toThrow("complete saved note body");
  });
});
