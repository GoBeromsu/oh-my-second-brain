import { describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { composeTemplateContract } from "./defaults.js";
import { contractDigest } from "./policy.js";

function layer(path: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath: path,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

function criterion(id: string, statement = `Statement for ${id}.`) {
  return {
    criterionId: id,
    statement,
    evidenceRequirement: "Quote a bound span.",
    requireByteVerification: true,
    sourceRefs: [{
      kind: "note-span",
      lineSpan: { start: 1, end: 1 },
      sliceDigest: digestBytes("Summary\n"),
    }],
  };
}

function richPolicy(templateFields: Record<string, unknown> = {
  status: { property: "status", allowedValues: ["open"] },
  priority: { property: "priority", required: true },
}) {
  return {
    version: 4 as const,
    properties: {
      status: { type: "select", intent: "Workflow state.", allowedValues: ["later", "closed", "open"] },
      priority: { type: "text", intent: "Priority.", allowedValues: ["low", "high"] },
      source: { type: "text", intent: "Link.", format: "url" },
      unused: { type: "text", intent: "Unused.", note: "inert" },
    },
    default: layer(".oms/templates/default.md", "", {
      fields: {
        status: { property: "status", required: true, allowedValues: ["open", "closed"] },
        source: { property: "source" },
      },
      headings: [{ headingId: "summary", title: "Summary", level: 2, required: true, note: "keep" }],
      semanticCriteria: [criterion("b-rule"), criterion("a-rule")],
    }),
    templates: {
      literature: {
        templateId: "literature",
        ...layer(".oms/templates/literature.md", "Body\n", {
          fields: templateFields,
          headings: [{ headingId: "a-sources", title: "Sources", level: 3, required: true }],
          semanticCriteria: [criterion("0-rule")],
          headingOrder: "strict",
        }),
      },
    },
  };
}

describe("composeTemplateContract", () => {
  it("retains prototype-named managed fields in the effective contract", () => {
    const raw = {
      version: 4,
      properties: { ["__proto__"]: { type: "text", intent: "User-owned property" } },
      default: layer(".oms/templates/default.md", "", {
        fields: { ["__proto__"]: { property: "__proto__", required: true } },
      }),
      templates: {},
    };
    const resolved = composeTemplateContract(raw, null);
    expect(Object.hasOwn(resolved.fields, "__proto__")).toBe(true);
    expect(resolved.fields["__proto__"]).toMatchObject({ property: "__proto__", type: "text", required: true });
    expect(Object.getPrototypeOf(resolved.fields)).toBeNull();
  });

  it("composes an empty unbound default without completion or inferred values", () => {
    const markdown = "\uFEFF{{title}} {{date}}\r\n";
    const raw = {
      version: 4 as const,
      properties: {},
      default: layer(".oms/templates/default.md", markdown),
      templates: {},
    };
    const result = composeTemplateContract(JSON.stringify(raw), null);
    expect(result).toEqual({
      templateId: null,
      headingOrder: "unordered",
      fields: {},
      headings: [],
      semanticCriteria: [],
      approved: {
        defaultLayer: {
          templatePath: ".oms/templates/default.md",
          approvedMarkdown: markdown,
          approvedMarkdownDigest: digestBytes(markdown),
        },
      },
      contractDigest: contractDigest(raw, null, null),
    });
    expect(composeTemplateContract(raw, null).contractDigest).toBe(composeTemplateContract(raw, null, null).contractDigest);
    expect(Object.keys(result).sort()).toEqual([
      "approved",
      "contractDigest",
      "fields",
      "headingOrder",
      "headings",
      "semanticCriteria",
      "templateId",
    ]);
  });

  it("keeps pool metadata, monotonic required, and the narrowest allowed values", () => {
    const narrowed = composeTemplateContract(richPolicy(), "literature");
    expect(Object.keys(narrowed.fields)).toEqual(["status", "source", "priority"]);
    expect(narrowed.fields.status).toEqual({
      property: "status",
      type: "select",
      intent: "Workflow state.",
      required: true,
      allowedValues: ["open"],
    });
    expect(narrowed.fields.source).toEqual({
      property: "source",
      type: "text",
      intent: "Link.",
      required: false,
      format: "url",
    });
    expect(narrowed.fields.priority).toEqual({
      property: "priority",
      type: "text",
      intent: "Priority.",
      required: true,
      allowedValues: ["high", "low"],
    });
    expect(narrowed.fields.unused).toBeUndefined();

    const inherited = composeTemplateContract(richPolicy({
      priority: { property: "priority", required: true },
    }), "literature");
    expect(inherited.fields.status).toMatchObject({ required: true, allowedValues: ["closed", "open"] });
    expect(inherited.headingOrder).toBe("strict");
    expect(composeTemplateContract(richPolicy(), null).headingOrder).toBe("unordered");
  });

  it("rejects dangling pool refs and required or allowed-value weakening", () => {
    expect(() => composeTemplateContract({
      version: 4,
      properties: {},
      default: layer(".oms/templates/default.md", "", {
        fields: { ghost: { property: "ghost" } },
      }),
      templates: {},
    }, null)).toThrow(/TEMPLATE_POLICY_DANGLING_FIELD/);
    expect(() => composeTemplateContract(richPolicy({
      status: { property: "status", required: false },
    }), "literature")).toThrow(/required may only be true/);
    expect(() => composeTemplateContract(richPolicy({
      status: { property: "status", allowedValues: ["open", "later"] },
    }), "literature")).toThrow(/CONTRACT_COMPOSITION_CONFLICT/);
    expect(() => composeTemplateContract(richPolicy({
      status: { property: "status", allowedValues: ["later"] },
    }), "literature")).toThrow(/the intersection is empty/);
    expect(() => composeTemplateContract({
      version: 4,
      properties: { status: { type: "select", intent: "Workflow state.", allowedValues: ["open"] } },
      default: layer(".oms/templates/default.md", "", {
        fields: { status: { property: "status", allowedValues: ["open", "outside"] } },
      }),
      templates: {},
    }, null)).toThrow(/CONTRACT_COMPOSITION_CONFLICT/);
    expect(() => composeTemplateContract(richPolicy(), "missing")).toThrow(/template missing is not registered/);
    expect(() => composeTemplateContract(richPolicy(), null, 1.5)).toThrow(/TEMPLATE_POLICY_INVALID/);
  });

  it("concatenates default then template headings and criteria and preserves approved bytes", () => {
    const markdown = "\uFEFFhello\r\n";
    const raw = richPolicy();
    raw.default = layer(".oms/templates/default.md", markdown, {
      fields: raw.default.fields,
      headings: raw.default.headings,
      semanticCriteria: raw.default.semanticCriteria,
    });
    const result = composeTemplateContract(raw, "literature");
    expect(result.templateId).toBe("literature");
    expect(result.headings.map(heading => [heading.headingId, heading.origin, heading.level])).toEqual([
      ["summary", "default", 2],
      ["a-sources", "template", 3],
    ]);
    expect(result.headings[0]?.extensions).toEqual({ note: "keep" });
    expect(result.semanticCriteria.map(item => item.criterionId)).toEqual(["a-rule", "b-rule", "0-rule"]);
    expect(result.semanticCriteria[0]).toMatchObject({ requireByteVerification: true });
    expect(result.semanticCriteria[0]).not.toHaveProperty("ignore");
    expect(result.approved.defaultLayer.approvedMarkdown).toBe(markdown);
    expect(result.approved.templateLayer?.approvedMarkdown).toBe("Body\n");
    expect(result.contractDigest).toBe(contractDigest(raw, "literature", null));

    const unbound = composeTemplateContract(raw, null);
    expect(unbound.templateId).toBeNull();
    expect(unbound.headings.map(heading => heading.headingId)).toEqual(["summary"]);
    expect(unbound.semanticCriteria.map(item => item.criterionId)).toEqual(["a-rule", "b-rule"]);
    expect(unbound.approved.templateLayer).toBeUndefined();
    expect(Object.keys(unbound.fields)).toEqual(["status", "source"]);
  });

  it("does not mutate the policy or copy a raw source into the resolved contract", () => {
    const raw = richPolicy();
    const sourced = {
      ...raw,
      templates: {
        literature: {
          ...raw.templates.literature,
          source: { path: "Sources/literature.md", identity: "literature-source", rawDigest: digestBytes("source") },
        },
      },
    };
    const before = JSON.stringify(sourced);
    Object.freeze(sourced);
    Object.freeze(sourced.default);
    const result = composeTemplateContract(sourced, "literature");
    expect(JSON.stringify(sourced)).toBe(before);
    expect(result.approved.defaultLayer.approvedMarkdown).toBe(sourced.default.approvedMarkdown);
    expect(result.approved.templateLayer?.approvedMarkdown).toBe("Body\n");
    expect(JSON.stringify(result)).not.toContain("Sources/literature.md");
    expect(result.contractDigest).not.toBe(composeTemplateContract(raw, "literature").contractDigest);
  });

  it("keeps the digest on referenced authority and placement, not completion or other templates", () => {
    const base = richPolicy();
    const repaired = {
      ...base,
      completion: { retryBudget: 0, agentRepair: { enabled: true, contexts: ["post-write"] } },
    };
    expect(composeTemplateContract(repaired, "literature").contractDigest).toBe(composeTemplateContract(base, "literature").contractDigest);
    const other = {
      ...base,
      templates: {
        ...base.templates,
        other: { templateId: "other", ...layer(".oms/templates/other.md", "Changed\n") },
      },
    };
    expect(composeTemplateContract(other, "literature").contractDigest).toBe(composeTemplateContract(base, "literature").contractDigest);
    expect(composeTemplateContract(base, "literature", { folder: "Notes" }).contractDigest)
      .not.toBe(composeTemplateContract(base, "literature").contractDigest);
    expect(() => composeTemplateContract(richPolicy({
      status: { property: "status" },
    }), "literature")).not.toThrow();
    const duplicate = richPolicy();
    duplicate.templates.literature = {
      ...duplicate.templates.literature,
      ...layer(".oms/templates/literature.md", "Body\n", {
        headings: [{ headingId: "summary", title: "Other", level: 2, required: true }],
      }),
    };
    expect(() => composeTemplateContract(duplicate, "literature")).toThrow(/heading summary is already declared/);
    const badLevel = richPolicy();
    badLevel.templates.literature = {
      ...badLevel.templates.literature,
      ...layer(".oms/templates/literature.md", "Body\n", {
        headings: [{ headingId: "notes", title: "Notes", level: 7, required: true }],
      }),
    };
    expect(() => composeTemplateContract(badLevel, "literature")).toThrow(/level must be an integer from 1 to 6/);
  });
});
