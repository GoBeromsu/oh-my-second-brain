import { describe, expect, it } from "vitest";
import { axisValueEquals, deriveTemplateRetrievalAxes } from "./axes.js";
import type { RetrievalFields, TemplateRetrievalSource } from "./axes.js";
import type { EffectiveFieldV5 } from "./contract-v5.js";
import type { Digest, GlobalAxis } from "./types.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;

function field(overrides: Partial<EffectiveFieldV5> = {}): EffectiveFieldV5 {
  return { property: "title", type: "text", required: true, valuePolicy: "free", ...overrides };
}

function fields(entries: readonly (readonly [string, EffectiveFieldV5])[]): RetrievalFields {
  const record = Object.create(null) as Record<string, EffectiveFieldV5>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function source(overrides: Partial<TemplateRetrievalSource> = {}): TemplateRetrievalSource {
  return {
    generationDigest: DIGEST,
    defaultFields: fields([]),
    templates: Object.create(null) as Record<string, RetrievalFields | null>,
    globalAxes: Object.create(null) as Record<string, GlobalAxis>,
    sourcePaths: [],
    ...overrides,
  };
}

describe("deriveTemplateRetrievalAxes", () => {
  it("keeps declaration order and every effective rule of a field", () => {
    const axes = deriveTemplateRetrievalAxes(source({
      defaultFields: fields([
        ["title", field({ intent: "Default title." })],
        ["tags", field({ property: "tags", type: "tags", required: false, valuePolicy: "suggest", allowedValues: ["flower"], maxItems: 3 })],
        ["score", field({ property: "score", type: "number", required: false, minimum: 0.5, maximum: 10.5 })],
      ]),
    }));
    expect(axes.defaultAxes.map(axis => axis.key)).toEqual(["title", "tags", "score"]);
    expect(axes.defaultAxes[0]).toEqual({ kind: "field", key: "title", property: "title", type: "text", required: true, valuePolicy: "free", intent: "Default title." });
    // A suggested list keeps its policy and cardinality; it never becomes a closed filter.
    expect(axes.defaultAxes[1]).toMatchObject({ valuePolicy: "suggest", allowedValues: ["flower"], maxItems: 3 });
    expect(axes.defaultAxes[2]).toMatchObject({ type: "number", minimum: 0.5, maximum: 10.5 });
    expect(axes.templates).toEqual([]);
  });

  it("orders templates by code point and keeps identity ahead of effective fields", () => {
    const axes = deriveTemplateRetrievalAxes(source({
      templates: {
        beta: fields([["status", field({ property: "status", type: "select", required: false, valuePolicy: "closed", allowedValues: ["open", "done"] })]]),
        alpha: fields([["title", field()]]),
        "\u00e9": fields([]),
      },
    }));
    expect(axes.templates.map(item => item.templateId)).toEqual(["alpha", "beta", "\u00e9"]);
    expect(axes.templates[0]?.axes[0]).toEqual({ kind: "identity", key: "template", type: "string", templateId: "alpha" });
    expect(axes.templates[1]?.axes[1]).toMatchObject({ kind: "field", key: "status", valuePolicy: "closed", allowedValues: ["open", "done"] });
    expect(axes.templates[2]?.axes.map(axis => axis.kind)).toEqual(["identity"]);
  });

  it("treats null metadata as unavailable and fabricates no declaration", () => {
    const unavailable = deriveTemplateRetrievalAxes(source({ defaultFields: null, templates: null, globalAxes: null, sourcePaths: null }));
    expect(unavailable).toEqual({ defaultAxes: [], templates: [], globalAxes: [] });
    // A known identity whose rules are unavailable stays queryable by identity.
    const partial = deriveTemplateRetrievalAxes(source({ defaultFields: null, templates: { note: null } }));
    expect(partial.defaultAxes).toEqual([]);
    expect(partial.templates).toEqual([{ templateId: "note", axes: [{ kind: "identity", key: "template", type: "string", templateId: "note" }] }]);
  });

  it("copies global axes in code point order without sharing caller objects", () => {
    const members = ["Notes", "Sources"];
    const extensions = Object.assign(Object.create(null), { zone: "north" });
    const axes = deriveTemplateRetrievalAxes(source({
      globalAxes: {
        link: { kind: "link", key: "link", type: "string", members: [] },
        folder: { kind: "folder", key: "folder", type: "select", intent: "Placement.", members, extensions },
      },
    }));
    expect(axes.globalAxes.map(axis => axis.key)).toEqual(["folder", "link"]);
    expect(axes.globalAxes[0]?.members).toEqual(members);
    expect(axes.globalAxes[0]?.members).not.toBe(members);
    expect(axes.globalAxes[0]?.extensions).toEqual({ zone: "north" });
  });

  it("rejects an incomplete snapshot, a duplicate identity, or a malformed field", () => {
    expect(() => deriveTemplateRetrievalAxes({ templates: null } as unknown as TemplateRetrievalSource))
      .toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: snapshot must include/);
    expect(() => deriveTemplateRetrievalAxes(source({ templates: { "e\u0301": fields([]), "\u00e9": fields([]) } })))
      .toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: \u00e9:templateId/);
    expect(() => deriveTemplateRetrievalAxes(source({ defaultFields: fields([["title", { property: "title" } as EffectiveFieldV5]]) })))
      .toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: default:title/);
    expect(() => deriveTemplateRetrievalAxes(source({ globalAxes: { folders: { kind: "folder", key: "folder", type: "select" } as GlobalAxis } })))
      .toThrow(/TEMPLATE_AXIS_UNDECLARED_FIELD: global:folders/);
  });
});

describe("axisValueEquals", () => {
  it("compares JSON values by content without coercing numbers or normalization", () => {
    expect(axisValueEquals("e\u0301", "\u00e9")).toBe(true);
    expect(axisValueEquals(1, 1)).toBe(true);
    expect(axisValueEquals(1, "1")).toBe(false);
    expect(axisValueEquals(Number.NaN, Number.NaN)).toBe(false);
    expect(axisValueEquals(["a", "b"], ["a", "b"])).toBe(true);
    expect(axisValueEquals(["b", "a"], ["a", "b"])).toBe(false);
    expect(axisValueEquals({ a: 1 }, { a: 1 })).toBe(true);
    expect(axisValueEquals(undefined, null)).toBe(false);
  });
});
