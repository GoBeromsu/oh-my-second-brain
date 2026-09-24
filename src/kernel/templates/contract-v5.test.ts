import { describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { composeContractV5, parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";

function fixture(): ContractPolicyV5 {
  return {
    version: 5,
    revision: 1,
    properties: {
      tags: { type: "tags", valuePolicy: "suggest", allowedValues: ["flower"], maxItems: 3 },
      status: { type: "select", valuePolicy: "closed", allowedValues: ["open", "done"] },
      score: { type: "number", minimum: 0.5, maximum: 10.5 },
    },
    common: {
      status: "active",
      fields: { tags: { required: true }, status: { required: true }, score: {} },
      headings: [{ headingId: "details", title: "Details", level: 2 }],
      headingOrder: "strict",
    },
    templates: {
      flower: {
        status: "active",
        source: { identity: "source-flower", path: "Templates/agent/flower.md", rawDigest: digestBytes("flower source") },
        fields: { tags: { maxItems: 5 }, status: { required: false, allowedValues: ["open", "done", "waiting"] } },
      },
    },
  };
}
function change(mutator: (document: Record<string, unknown>) => void): unknown {
  const document = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
  mutator(document);
  return document;
}

describe("explicit v5 contracts", () => {
  it("uses no physical default Markdown and lets individual declarations relax common rules", () => {
    const common = composeContractV5(fixture(), null);
    const flower = composeContractV5(fixture(), "flower");
    expect(common.fields.tags).toMatchObject({ required: true, maxItems: 3, valuePolicy: "suggest" });
    expect(flower.fields.tags).toMatchObject({ required: true, maxItems: 5 });
    expect(flower.fields.status).toMatchObject({ required: false, allowedValues: ["open", "done", "waiting"] });
    expect(common.fields.status.required).toBe(true);
    expect(common).not.toHaveProperty("approvedMarkdown");
    expect(common).not.toHaveProperty("templatePath");
    expect(common.contractDigest).not.toBe(flower.contractDigest);
  });

  it("distinguishes omitted members, false, null and replacement arrays", () => {
    const policy = fixture();
    const source = policy.templates.flower;
    if (source.status !== "active") throw new Error("fixture");
    const modified: ContractPolicyV5 = { ...policy, templates: { flower: { ...source, fields: {
      tags: { required: false, maxItems: null, allowedValues: null, valuePolicy: "free" },
      status: { allowedValues: ["done"] },
    }, headings: [], headingOrder: "unordered" } } };
    const resolved = composeContractV5(modified, "flower");
    expect(resolved.fields.tags).toMatchObject({ required: false, maxItems: null, allowedValues: null, valuePolicy: "free" });
    expect(resolved.fields.status).toMatchObject({ required: true, allowedValues: ["done"] });
    expect(resolved.headings).toEqual([]);
    expect(resolved.headingOrder).toBe("unordered");
    expect(composeContractV5(policy, "flower").headings).toEqual(policy.common.status === "active" ? policy.common.headings : []);
  });

  it("supports explicit type and format overrides while rejecting incompatible inherited limits", () => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    const clear = { ...policy, templates: { flower: { ...entry, fields: { score: { type: "text" as const, format: "url" as const, minimum: null, maximum: null } } } } };
    expect(composeContractV5(clear, "flower").fields.score).toMatchObject({ type: "text", format: "url", minimum: null });
    const invalid = { ...policy, templates: { flower: { ...entry, fields: { score: { type: "text" as const } } } } };
    expect(() => parseContractPolicyV5(invalid)).toThrow("numeric limits require a number");
  });

  it("replaces headings and permits explicit dynamic slots without changing fixed titles", () => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    const headings = [{ headingId: "topic", binding: "meeting-topic", level: 3, required: true }];
    const modified = { ...policy, templates: { flower: { ...entry, headings } } };
    expect(composeContractV5(modified, "flower").headings).toEqual(headings);
    expect(() => parseContractPolicyV5({ ...modified, templates: { flower: { ...entry, headings: [{ ...headings[0], title: "Fixed" }] } } })).toThrow("exactly one");
  });

  it("preserves unknown JSON and exact text, including decimals and prototype-like keys", () => {
    const input = JSON.parse(JSON.stringify(fixture()));
    input.notes = { decimal: 0.125, accent: "e\u0301", array: [null, false, { any: "kept" }] };
    input.properties.tags.custom = { unit: "labels" };
    Object.defineProperty(input, "__proto__", { value: { safe: true }, enumerable: true });
    const parsed = parseContractPolicyV5(input);
    const output = JSON.parse(serializeContractPolicyV5(parsed));
    expect(output).toEqual(input);
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(output.notes.accent).toBe("e\u0301");
    expect(composeContractV5(parsed, null).fields.score.minimum).toBe(0.5);
    input.properties.tags.type = "number";
    expect(parsed.properties.tags.type).toBe("tags");
  });

  it("does not include operational revision or source acknowledgment in effective rule digest", () => {
    const original = fixture();
    const entry = original.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    const updated = { ...original, revision: 2, templates: { flower: { ...entry, source: { ...entry.source, rawDigest: digestBytes("changed source") } } } };
    expect(composeContractV5(updated, "flower").contractDigest).toBe(composeContractV5(original, "flower").contractDigest);
    const changed = { ...updated, templates: { flower: { ...updated.templates.flower, fields: { tags: { maxItems: 6 } } } } };
    expect(composeContractV5(changed, "flower").contractDigest).not.toBe(composeContractV5(original, "flower").contractDigest);
  });

  it("never treats an unknown or prototype template name as common", () => {
    for (const id of ["missing", "toString", "__proto__"]) expect(() => composeContractV5(fixture(), id)).toThrow("CONTRACT_UNKNOWN_TEMPLATE");
  });

  it("blocks every selection for unresolved common rules without manufacturing an empty contract", () => {
    const policy: ContractPolicyV5 = { ...fixture(), common: { status: "review-required", reasons: ["legacy semantic rule"], legacy: { semanticCriteria: ["original"] } } };
    expect(parseContractPolicyV5(policy).common).toEqual(policy.common);
    for (const selected of [null, "flower"]) expect(() => composeContractV5(policy, selected)).toThrow("CONTRACT_REVIEW_REQUIRED");
  });

  it("isolates a review-required individual while preserving its original evidence", () => {
    const policy: ContractPolicyV5 = { ...fixture(), templates: { ...fixture().templates, missing: { status: "review-required", reasons: ["source evidence missing"], legacy: { source: null } } } };
    expect(composeContractV5(policy, "flower").templateId).toBe("flower");
    expect(composeContractV5(policy, null).templateId).toBeNull();
    expect(() => composeContractV5(policy, "missing")).toThrow("CONTRACT_REVIEW_REQUIRED");
    expect(JSON.parse(serializeContractPolicyV5(policy)).templates.missing.legacy).toEqual({ source: null });
  });

  it.each([
    ["minItems exceeds maxItems", { minItems: 6, maxItems: 5 }],
    ["non-negative safe integer", { minItems: -1 }],
    ["non-negative safe integer", { maxItems: 1.5 }],
    ["non-negative safe integer", { maxItems: Number.MAX_SAFE_INTEGER + 1 }],
    ["closed values require", { valuePolicy: "closed", allowedValues: null }],
    ["string array", { allowedValues: ["flower", 2] }],
    ["duplicates", { allowedValues: ["flower", "flower"] }],
    ["must be boolean", { required: null }],
    ["type is unsupported", { type: "bogus" }],
    ["valuePolicy", { valuePolicy: "auto" }],
    ["format", { format: "email" }],
    ["intent", { intent: false }],
  ])("rejects invalid composed field: %s", (message, field) => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    expect(() => parseContractPolicyV5({ ...policy, templates: { flower: { ...entry, fields: { tags: field } } } })).toThrow(message);
  });

  it("rejects numeric range contradictions and unsupported type-specific limits", () => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    for (const [field, message] of [
      [{ minimum: 11 }, "minimum exceeds maximum"],
      [{ minItems: 1 }, "item limits require a list"],
      [{ format: "url" }, "URL format requires a string"],
    ] as const) {
      expect(() => parseContractPolicyV5({ ...policy, templates: { flower: { ...entry, fields: { score: field } } } })).toThrow(message);
    }
  });

  it.each(["../flower.md", "/tmp/flower.md", ".oms/templates/flower.md", "Templates//flower.md", "Templates/flower.txt"])("rejects unsafe or noncanonical source %s", path => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    expect(() => parseContractPolicyV5({ ...policy, templates: { flower: { ...entry, source: { ...entry.source, path } } } })).toThrow("CONTRACT_POLICY_INVALID");
  });

  it("rejects duplicate source identities and paths", () => {
    const policy = fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    for (const duplicate of [entry, { ...entry, source: { ...entry.source, path: "Templates/another.md" } }, { ...entry, source: { ...entry.source, identity: "another" } }]) {
      expect(() => parseContractPolicyV5({ ...policy, templates: { ...policy.templates, copy: duplicate } })).toThrow("unique source identities and paths");
    }
  });

  it.each([
    [{ headingId: "a", title: "A", level: 0 }],
    [{ headingId: "a", title: "A", level: 7 }],
    [{ headingId: "a", title: "A", level: 2 }, { headingId: "a", title: "B", level: 2 }],
    [{ headingId: "a", binding: "x", level: 2 }, { headingId: "b", binding: "x", level: 2 }],
    [{ headingId: "a", level: 2 }],
    [{ headingId: "a", title: "", level: 2 }],
    [{ headingId: "a", title: "A", level: 2, required: 1 }],
  ])("rejects malformed heading contracts %#", (...headings) => {
    const policy = fixture();
    expect(() => parseContractPolicyV5({ ...policy, common: { status: "active", fields: {}, headings } })).toThrow("CONTRACT_POLICY_INVALID");
  });

  it("rejects malformed policy shapes rather than dropping invalid JSON members", () => {
    const cyclic: Record<string, unknown> = { ...fixture() };
    cyclic.self = cyclic;
    for (const input of [undefined, [], null, "{", cyclic, { ...fixture(), extra: undefined }, { ...fixture(), extra: NaN }, { ...fixture(), extra: new Date() }, { ...fixture(), extra: Symbol("x") }]) {
      expect(() => parseContractPolicyV5(input)).toThrow("CONTRACT_POLICY_INVALID");
    }
    expect(() => parseContractPolicyV5({ ...fixture(), version: 4 })).toThrow("CONTRACT_VERSION_UNSUPPORTED");
    expect(() => parseContractPolicyV5({ ...fixture(), revision: -1 })).toThrow("revision");
    expect(() => parseContractPolicyV5(change(root => { root.common = { status: "review-required", reasons: [], legacy: {} }; }))).toThrow("reasons");
    expect(() => parseContractPolicyV5(change(root => { root.common = { status: "review-required", reasons: ["review"] }; }))).toThrow("legacy evidence");
    expect(() => parseContractPolicyV5(change(root => { root.common = { status: "active", fields: { missing: {} } }; }))).toThrow("unknown property");
    expect(() => parseContractPolicyV5(change(root => { root.properties = { tags: {} }; }))).toThrow("type is required");
    expect(() => parseContractPolicyV5(change(root => { root.common = { status: "active", fields: {}, headingOrder: "random" }; }))).toThrow("headingOrder");
  });

  it("rejects raw duplicate JSON members instead of admitting last-wins authority", () => {
    const unique = serializeContractPolicyV5(fixture());
    const parsed = parseContractPolicyV5(unique);
    expect(parsed).toEqual(fixture());
    expect(parsed.version).toBe(5);
    expect(parseContractPolicyV5(unique.replace(/\n/g, "\r\n"))).toEqual(fixture());
    expect(parseContractPolicyV5(unique.replaceAll('"flower"', '"꽃"')).templates).toHaveProperty("꽃");
    expect(parseContractPolicyV5(unique.replace('[\n        "flower"\n      ]', '[\n        "flower",\n        "flower-note"\n      ]')).properties.tags.allowedValues).toEqual(["flower", "flower-note"]);

    const ambiguous = (raw: string) => {
      expect(raw).not.toBe(unique);
      let thrown: unknown;
      try { parseContractPolicyV5(raw); }
      catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "CONTRACT_POLICY_INVALID", message: expect.stringMatching(/ambiguous or duplicate/) });
    };
    const duplicates = [
      unique.replace('"version": 5', '"version": 4,\n  "version": 5'),
      unique.replace('"version": 5', '"version": 5,\n  "version": 4'),
      unique.replace('"revision": 1', '"revision": 1,\n  "revision": 1'),
      unique.replace('"common": {', '"common": {\n    "status": "active"\n  },\n  "common": {'),
      unique.replace('"fields": {', '"fields": {\n      "score": {}\n    },\n    "fields": {'),
      unique.replace('"tags": {\n          "maxItems": 5\n        }', '"tags": {\n          "maxItems": 4\n        },\n        "tags": {\n          "maxItems": 5\n        }'),
      unique.replace('"path": "Templates/agent/flower.md"', '"path": "Templates/other.md",\n        "path": "Templates/agent/flower.md"'),
      unique.replace('"templates": {\n    "flower": {', `"templates": {\n    "kept": ${JSON.stringify({ status: "review-required", reasons: ["kept"], legacy: {} })},\n    "flower": ${JSON.stringify({ status: "active", fields: {}, source: { identity: "other", path: "Templates/other.md", rawDigest: digestBytes("other source") } })},\n    "flower": {`),
    ];
    expect(new Set(duplicates).size).toBe(duplicates.length);
    for (const raw of duplicates) ambiguous(raw);

    const literal = unique.replace('"title": "Details"', '"title": "{\\"version\\": 4, \\"version\\": 5}"');
    expect(parseContractPolicyV5(literal).common).toMatchObject({ headings: [{ title: '{"version": 4, "version": 5}' }] });
    expect(() => parseContractPolicyV5("{")).toThrow("policy is not valid JSON");
    expect(() => parseContractPolicyV5({ ...fixture(), version: 4 })).toThrow("CONTRACT_VERSION_UNSUPPORTED");
  });
});
