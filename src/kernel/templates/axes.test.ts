import { describe, expect, it } from "vitest";
import { axisValueEquals, deriveTemplateRetrievalAxes } from "./axes.js";
import type { TemplateRetrievalSource } from "./axes.js";
import type { Digest, GlobalAxis, ManagedTemplatePath, ResolvedContract, ResolvedField, TemplateId, TemplatePolicy } from "./types.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
const STALE = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Digest;

function mapping<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function field(property: string, overrides: Record<string, unknown> = {}): ResolvedField {
  return {
    property,
    type: "string",
    intent: property,
    required: false,
    ...overrides,
  } as ResolvedField;
}

function contract(templateId: string | null, fields: Record<string, ResolvedField>): ResolvedContract {
  return {
    templateId: templateId as TemplateId | null,
    headingOrder: "unordered",
    fields,
    headings: [],
    semanticCriteria: [],
    approved: {
      defaultLayer: {
        templatePath: ".oms/templates/default.md" as ManagedTemplatePath,
        approvedMarkdown: "",
        approvedMarkdownDigest: DIGEST,
      },
    },
    contractDigest: DIGEST,
  };
}

function policy(): TemplatePolicy {
  return {
    version: 4,
    properties: {},
    default: {
      templatePath: ".oms/templates/default.md" as ManagedTemplatePath,
      approvedMarkdown: "",
      approvedMarkdownDigest: DIGEST,
      fields: {},
      headings: [],
      semanticCriteria: [],
    },
    templates: {},
    completion: { retryBudget: 2, agentRepair: { enabled: false } },
  };
}

function source(overrides: Partial<TemplateRetrievalSource> = {}): TemplateRetrievalSource {
  return {
    defaultContract: contract(null, {}),
    templates: {},
    globalAxes: {},
    generationDigest: DIGEST,
    policy: policy(),
    ...overrides,
  };
}

function sample(overrides: Partial<TemplateRetrievalSource> = {}): TemplateRetrievalSource {
  return source({
    defaultContract: contract(null, mapping([
      ["title", field("title", { intent: "Default title.", required: true })],
      ["status", field("status", { type: "select", intent: "Default status.", allowedValues: ["open", "closed"] })],
    ])),
    templates: {
      beta: contract("beta", mapping([
        ["zeta", field("zeta", { type: "select", intent: "Workflow state.", required: true, allowedValues: ["open"] })],
        ["alpha", field("alpha", { type: "text", intent: "Body.", format: "url", normalize: "trim" })],
      ])),
      alpha: contract("alpha", mapping([
        ["title", field("title", { intent: "Title." })],
      ])),
    },
    globalAxes: {
      links: { kind: "link", key: "related", type: "list", members: ["parent", "child"] },
      folders: {
        kind: "folder",
        key: "folder",
        type: "select",
        intent: "Placement.",
        members: ["notes", "archive"],
        extensions: Object.assign(Object.create(null), { zone: "north" }),
      },
    },
    ...overrides,
  });
}

describe("deriveTemplateRetrievalAxes", () => {
  it("derives default field axes in contract order without an identity axis", () => {
    expect(deriveTemplateRetrievalAxes(sample()).defaultAxes).toEqual([
      { kind: "field", key: "title", type: "string", intent: "Default title.", required: true },
      { kind: "field", key: "status", type: "select", intent: "Default status.", required: false, allowedValues: ["open", "closed"] },
    ]);
  });

  it("orders each template by code point and keeps identity ahead of effective fields", () => {
    const axes = deriveTemplateRetrievalAxes(sample());
    expect(axes.templates.map(item => item.templateId)).toEqual(["alpha", "beta"]);
    expect(axes.templates[0]).toEqual({
      templateId: "alpha",
      axes: [
        { kind: "identity", key: "template", type: "string", templateId: "alpha" },
        { kind: "field", key: "title", type: "string", intent: "Title.", required: false },
      ],
    });
    expect(axes.templates[1]).toEqual({
      templateId: "beta",
      axes: [
        { kind: "identity", key: "template", type: "string", templateId: "beta" },
        { kind: "field", key: "zeta", type: "select", intent: "Workflow state.", required: true, allowedValues: ["open"] },
        { kind: "field", key: "alpha", type: "text", intent: "Body.", required: false, format: "url" },
      ],
    });
  });

  it("sorts normalized template ids by Unicode code point", () => {
    const axes = deriveTemplateRetrievalAxes(source({
      templates: {
        "\u00e9": contract("\u00e9", mapping([["title", field("title")]])),
        f: contract("f", mapping([["title", field("title")]])),
        "a\u0301": contract("\u00e1", mapping([["title", field("title", { intent: "Accent." })]])),
      },
    }));
    expect(axes.templates.map(item => item.templateId)).toEqual(["f", "\u00e1", "\u00e9"]);
    expect(axes.templates[1]?.axes[1]).toMatchObject({ key: "title", intent: "Accent." });
  });

  it("copies global axes by registry key without retaining caller arrays or prototypes", () => {
    const allowed = ["open"];
    const members = ["notes", "archive"];
    const extensions = Object.assign(Object.create(null), { zone: "north" });
    const axes = deriveTemplateRetrievalAxes(source({
      templates: {
        beta: contract("beta", mapping([
          ["zeta", field("zeta", { type: "select", intent: "Workflow state.", required: true, allowedValues: allowed })],
        ])),
      },
      globalAxes: {
        links: { kind: "link", key: "related", type: "list", members: ["parent", "child"] },
        folders: { kind: "folder", key: "folder", type: "select", intent: "Placement.", members, extensions },
      },
    }));
    allowed.push("closed");
    members.push("secret");
    extensions.zone = "south";
    expect(axes.globalAxes).toEqual([
      {
        kind: "folder",
        key: "folder",
        type: "select",
        intent: "Placement.",
        members: ["notes", "archive"],
        extensions: { zone: "north" },
      },
      { kind: "link", key: "related", type: "list", members: ["parent", "child"] },
    ]);
    expect(axes.globalAxes[0]?.members).not.toBe(members);
    expect(Object.getPrototypeOf(axes.globalAxes[0]?.extensions)).toBe(null);
    expect(axes.templates[0]?.axes[1]).toMatchObject({ allowedValues: ["open"] });
    expect(axes.templates[0]?.axes[1]?.kind === "field" && axes.templates[0].axes[1].allowedValues).not.toBe(allowed);
  });

  it("does not derive axes from the generation digest or policy", () => {
    const changed = policy();
    expect(deriveTemplateRetrievalAxes(sample())).toEqual(deriveTemplateRetrievalAxes(sample({
      generationDigest: STALE,
      policy: { ...changed, completion: { retryBudget: 9, agentRepair: { enabled: true } } },
    })));
  });

  it("rejects an incomplete snapshot, a bound default layer, a mismatched id, or an undeclared field", () => {
    expect(() => deriveTemplateRetrievalAxes({ templates: {} } as TemplateRetrievalSource)).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: snapshot must include/);
    expect(() => deriveTemplateRetrievalAxes(source({
      defaultContract: contract("note", mapping([["title", field("title")]])),
    }))).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: default:templateId/);
    expect(() => deriveTemplateRetrievalAxes(source({
      templates: { beta: contract("alpha", mapping([["title", field("title")]])) },
    }))).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: beta:templateId/);
    expect(() => deriveTemplateRetrievalAxes(source({
      templates: { beta: contract("beta", mapping([["zeta", { property: "zeta" } as ResolvedField]])) },
    }))).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: beta:zeta/);
    expect(() => deriveTemplateRetrievalAxes(source({
      globalAxes: { folders: { kind: "folder", key: "folder", type: "select" } as GlobalAxis },
    }))).toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: global:folders/);
  });
});

describe("axisValueEquals", () => {
  it("compares JSON note values without imposing contract-hash number limits", () => {
    expect(axisValueEquals(undefined, null)).toBe(false);
    expect(axisValueEquals(null, null)).toBe(true);
    expect(axisValueEquals({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(axisValueEquals(["b", "a"], ["a", "b"])).toBe(false);
    expect(axisValueEquals("a\u0301", "\u00e1")).toBe(true);
    expect(axisValueEquals(-0, 0)).toBe(true);
    expect(axisValueEquals(1.5, 1)).toBe(false);
    expect(axisValueEquals(1.5, 1.5)).toBe(true);
    expect(axisValueEquals(1e30, 1e30)).toBe(true);
    expect(axisValueEquals(Infinity, Infinity)).toBe(false);
    expect(axisValueEquals({ score: [1.5, -0] }, { score: [1.5, 0] })).toBe(true);
    expect(axisValueEquals(mapping([["__proto__", 1.5]]), JSON.parse('{"__proto__":1.5}'))).toBe(true);
    expect(axisValueEquals({ value: false }, { other: false })).toBe(false);
    expect(axisValueEquals({ value: 1 }, [1])).toBe(false);
    expect(axisValueEquals({ "á": 1, "á": 2 }, { "á": 2 })).toBe(false);
  });
});
