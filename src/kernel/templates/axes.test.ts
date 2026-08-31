import { describe, expect, it } from "vitest";
import { deriveTemplateRetrievalAxes } from "./axes.js";
import type { ResolvedConvention } from "./types.js";

const signature = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;

function convention(): ResolvedConvention {
  return {
    base: { fields: {} },
    inputSignature: signature,
    managedSourcePaths: [],
    globalAxes: {
      folders: { kind: "folder", key: "folder", type: "select", members: ["notes", "archive"] },
      links: { kind: "link", key: "related", type: "list", members: ["parent", "child"] },
    },
    templates: {
      beta: {
        id: "beta",
        destinationClass: "managed-default",
        sourcePath: "Templates/OMS/beta.md",
        targetFolder: "Inbox",
        keyOrder: ["zeta"],
        fields: {
          alpha: { type: "text", normalize: "trim" },
          zeta: { type: "select", allowedValues: ["open"], intent: "Workflow state." },
        },
        frontmatterTemplate: {},
        body: "",
        naming: "{{slug}}.md",
        views: [{ name: "ordered", keys: ["zeta", "alpha"] }],
        inputSignature: signature,
        templateSignature: signature,
        managedSourcePaths: [],
      },
      alpha: {
        id: "alpha",
        destinationClass: "managed-default",
        sourcePath: "Templates/OMS/alpha.md",
        targetFolder: "Inbox",
        keyOrder: ["title"],
        fields: { title: { type: "text" } },
        frontmatterTemplate: {},
        body: "",
        naming: "{{slug}}.md",
        views: [],
        inputSignature: signature,
        templateSignature: signature,
        managedSourcePaths: [],
      },
    },
  };
}

describe("deriveTemplateRetrievalAxes", () => {
  it("orders templates by stable template identity", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates.map(item => item.templateId)).toEqual(["alpha", "beta"]);
  });

  it("starts each template with its stable identity axis", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates[0]?.axes[0]).toEqual({ kind: "field", key: "template", type: "string", templateId: "alpha" });
  });

  it("keeps authored field order before lexical remainder order", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates[1]?.axes.map(axis => axis.key)).toEqual(["template", "zeta", "alpha"]);
  });

  it("carries field type and allowed values into the derived axis", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates[1]?.axes[1]).toMatchObject({ key: "zeta", type: "select", allowedValues: ["open"], intent: "Workflow state." });
  });

  it("carries field normalization into the derived axis", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates[1]?.axes[2]).toMatchObject({ key: "alpha", type: "text", normalize: "trim" });
  });

  it("preserves the folder global axis meaning and member order", () => {
    expect(deriveTemplateRetrievalAxes(convention()).globalAxes[0]).toEqual({ kind: "folder", key: "folder", type: "select", members: ["notes", "archive"] });
  });

  it("preserves the link global axis meaning and member order", () => {
    expect(deriveTemplateRetrievalAxes(convention()).globalAxes[1]).toEqual({ kind: "link", key: "related", type: "list", members: ["parent", "child"] });
  });

  it("preserves retrieval view order and declared key order", () => {
    expect(deriveTemplateRetrievalAxes(convention()).templates[1]?.views).toEqual([{ name: "ordered", keys: ["zeta", "alpha"] }]);
  });

  it("rejects a view referencing an undeclared field", () => {
    const current = convention();
    const template = current.templates.beta!;
    const altered: ResolvedConvention = {
      ...current,
      templates: { ...current.templates, beta: { ...template, views: [{ name: "broken", keys: ["missing"] }] } },
    };
    expect(() => deriveTemplateRetrievalAxes(altered)).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD.*beta:view:broken:missing/);
  });

  it("rejects a managed field that cannot define a typed axis", () => {
    const current = convention();
    const template = current.templates.beta!;
    const altered: ResolvedConvention = {
      ...current,
      templates: { ...current.templates, beta: { ...template, fields: { ...template.fields, broken: {} } } },
    };
    expect(() => deriveTemplateRetrievalAxes(altered)).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD.*beta:broken/);
  });

  it("derives byte-for-byte equal metadata for repeated inputs", () => {
    expect(deriveTemplateRetrievalAxes(convention())).toEqual(deriveTemplateRetrievalAxes(convention()));
  });
});
