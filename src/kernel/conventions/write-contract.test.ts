import { describe, expect, it } from "vitest";
import type { BaseContract, ResolvedTemplate } from "../templates/types.js";
import { evaluateResolvedTemplateContract } from "./write-contract.js";

const base: BaseContract = { fields: { created: { type: "date", required: true } } };
const template: ResolvedTemplate = {
  id: "note" as ResolvedTemplate["id"],
  destinationClass: "managed-default",
  sourcePath: "Templates/note.md" as ResolvedTemplate["sourcePath"],
  targetFolder: "notes" as ResolvedTemplate["targetFolder"],
  bom: false,
  eol: "lf",
  finalNewline: true,
  keyOrder: ["title", "source", "status"],
  fields: {
    title: { type: "text", required: true, normalize: "trim" },
    source: { type: "text", format: "url" },
    status: { type: "select", allowedValues: ["draft"] },
  },
  frontmatterTemplate: {},
  body: "",
  naming: "{{slug}}.md",
  views: [],
  inputSignature: "sha256:test" as ResolvedTemplate["inputSignature"],
  templateSignature: "sha256:test" as ResolvedTemplate["templateSignature"],
  managedSourcePaths: [],
};

describe("evaluateResolvedTemplateContract", () => {
  it("accepts declared values while preserving unknown frontmatter at the caller", () => {
    const result = evaluateResolvedTemplateContract(
      { title: "note", source: "https://example.com", status: "draft", created: "2026-08-30", extra: true },
      template,
      base,
    );
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("reports required, allowed-value, and URL-format failures", () => {
    const result = evaluateResolvedTemplateContract(
      { title: "", source: "ftp://example.com", status: "published", created: "2026-08-30" },
      template,
      base,
    );
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title", rule: "required" }),
      expect.objectContaining({ field: "source", rule: "format" }),
      expect.objectContaining({ field: "status", rule: "allowed-values" }),
    ]));
  });

  it("admits a registered writer identifier", () => {
    expect(evaluateResolvedTemplateContract({ title: "note", created: "2026-08-30", created_by: "oms-agent" }, template, base, { field: "created_by", identifiers: ["oms-agent"] })).toEqual({ valid: true, violations: [] });
  });

  it("reports exactly one violation for an unregistered writer identifier", () => {
    const writerTemplate = { ...template, fields: { ...template.fields, created_by: { type: "text", required: true } } };
    const result = evaluateResolvedTemplateContract({ title: "note", created: "2026-08-30", created_by: "unknown-agent" }, writerTemplate, base, { field: "created_by", identifiers: ["oms-agent"] });
    expect(result.violations).toEqual([expect.objectContaining({ field: "created_by", rule: "writer-identity" })]);
    expect(result.violations[0]?.message).toContain("unknown-agent");
  });

  it("reports exactly one violation when a configured writer field is missing", () => {
    const writerTemplate = { ...template, fields: { ...template.fields, created_by: { type: "text", required: true } } };
    const result = evaluateResolvedTemplateContract({ title: "note", created: "2026-08-30" }, writerTemplate, base, { field: "created_by", identifiers: ["oms-agent"] });
    expect(result.violations).toEqual([expect.objectContaining({ field: "created_by", rule: "writer-identity" })]);
  });

  it("does not enforce writer identity without a registry", () => {
    expect(evaluateResolvedTemplateContract({ title: "note", created: "2026-08-30", created_by: "unknown-agent" }, template, base)).toEqual({ valid: true, violations: [] });
  });
});
