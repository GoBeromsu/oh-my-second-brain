import { describe, expect, it } from "vitest";
import { bindContractHeadings, evaluateContractV5, isObsidianTag } from "./contract-check.js";
import { composeContractV5, parseContractPolicyV5, type ContractPolicyV5, type FieldRulesV5, type HeadingV5 } from "./contract-v5.js";

function contract(
  fields: Readonly<Record<string, FieldRulesV5>> = {},
  headings: readonly HeadingV5[] = [],
  order: "strict" | "unordered" = "strict",
  additionalHeadings?: "subordinate" | "allow",
) {
  const policy: ContractPolicyV5 = {
    version: 5, revision: 1,
    properties: { tags: { type: "tags" }, status: { type: "select" }, score: { type: "number" }, source: { type: "text" }, date: { type: "date" }, time: { type: "datetime" }, active: { type: "checkbox" }, items: { type: "list" }, aliases: { type: "aliases" } },
    common: { status: "active", fields, headings, headingOrder: order, ...(additionalHeadings === undefined ? {} : { additionalHeadings }) }, templates: {},
  };
  return composeContractV5(policy, null);
}
function source(identity: string, path: string): ContractPolicyV5["templates"][string] {
  return { status: "active", source: { identity, path, rawDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fields: {} };
}
function rules(common: ContractPolicyV5["common"], templates: ContractPolicyV5["templates"] = {}): ContractPolicyV5 {
  return { version: 5, revision: 1, properties: {}, common, templates };
}

const flower = [
  { headingId: "details", title: "Details", level: 2 },
  { headingId: "record", title: "기록", level: 2 },
  { headingId: "memo", title: "메모", level: 2 },
];

describe("v5 structural properties", () => {
  it("allows previously unobserved values in free and suggest modes, but enforces closed sets", () => {
    for (const valuePolicy of ["free", "suggest", "closed"] as const) {
      const result = evaluateContractV5({ status: "waiting" }, "", contract({ status: { valuePolicy, allowedValues: ["open", "done"] } }));
      expect(result.valid).toBe(valuePolicy !== "closed");
      expect(result.semantic).toBe("not-evaluated");
      if (valuePolicy === "closed") expect(result.violations[0].rule).toBe("allowed-values");
    }
  });

  it("checks list min/max at both boundaries without inventing a fixed tag count", () => {
    const selected = contract({ tags: { minItems: 2, maxItems: 5 } });
    for (const count of [1, 2, 3, 5, 6]) {
      const tags = Array.from({ length: count }, (_, index) => `topic-${index}`);
      const result = evaluateContractV5({ tags }, "", selected);
      expect(result.valid, String(count)).toBe(count >= 2 && count <= 5);
      if (!result.valid) expect(result.violations[0].rule).toBe("cardinality");
    }
    expect(evaluateContractV5({ tags: Array(20).fill("flower") }, "", contract({ tags: {} })).valid).toBe(true);
  });

  it.each(["[[flower]]", "#flower", "two words", "1984", "a.b", "a//b", "/flower", "flower/", ""])("rejects invalid tag %s while values remain open", tag => {
    expect(isObsidianTag(tag)).toBe(false);
    expect(evaluateContractV5({ tags: [tag] }, "", contract({ tags: { valuePolicy: "free" } })).violations.map(item => item.rule)).toContain("tag-syntax");
  });

  it.each(["flower", "topic/sub-topic", "꽃/연구", "y1984", "café", "e\u0301", "symbol-©"])("accepts documented tag characters in %s", tag => {
    expect(evaluateContractV5({ tags: [tag] }, "", contract({ tags: {} })).valid).toBe(true);
  });

  it("separates required, type, enum and format errors without repairing saved values", () => {
    const selected = contract({ tags: { required: true }, source: { required: true, format: "url" }, status: { valuePolicy: "closed", allowedValues: ["open"] } });
    const note = Object.freeze({ tags: "flower", source: "javascript:alert(1)", status: "unknown", unmanaged: { retain: true } });
    const before = JSON.stringify(note);
    expect(evaluateContractV5(note, "", selected).violations.map(item => item.rule)).toEqual(["type", "format", "allowed-values"]);
    expect(JSON.stringify(note)).toBe(before);
    expect(evaluateContractV5({ tags: [], source: " " }, "", selected).violations.map(item => item.rule)).toEqual(["required", "required"]);
    expect(evaluateContractV5({ tags: ["flower"], source: "https://example.org" }, "", selected).valid).toBe(true);
  });

  it("validates decimal bounds inclusively and treats false and zero as present", () => {
    const selected = contract({ score: { required: true, minimum: 0, maximum: 1.5 }, active: { required: true } });
    for (const score of [-0.1, 0, 1.5, 1.6]) {
      const result = evaluateContractV5({ score, active: false }, "", selected);
      expect(result.valid).toBe(score >= 0 && score <= 1.5);
      if (!result.valid) expect(result.violations[0].rule).toBe("range");
    }
    expect(evaluateContractV5({ score: NaN, active: "false" }, "", selected).violations.map(item => item.rule)).toEqual(["type", "type"]);
  });

  it("checks dates, timestamps, typed string lists and untyped JSON lists", () => {
    const selected = contract({ date: {}, time: {}, aliases: {}, items: {} });
    expect(evaluateContractV5({ date: "2024-02-29", time: "2024-02-29T12:30:00Z", aliases: ["A"], items: [1, { ok: true }] }, "", selected).valid).toBe(true);
    expect(evaluateContractV5({ date: "2023-02-29", time: "2024-02-30T12:00:00Z", aliases: [1], items: "x" }, "", selected).violations).toHaveLength(4);
    expect(evaluateContractV5({ date: null, time: null }, "", selected).valid).toBe(true);
  });

  it("checks closed list members individually and never drops extra properties", () => {
    const note = { tags: ["flower", "new"], free: "unchanged" };
    const selected = contract({ tags: { valuePolicy: "closed", allowedValues: ["flower"] } });
    expect(evaluateContractV5(note, "", selected).violations[0].rule).toBe("allowed-values");
    expect(note).toEqual({ tags: ["flower", "new"], free: "unchanged" });
  });
});

describe("v5 heading structure", () => {
  it("validates actual Flower names, levels and order while allowing child headings", () => {
    const selected = contract({}, flower);
    const body = "## Details\n### More detail\nText\n## 기록\n#### Item\n## 메모\n";
    expect(evaluateContractV5({}, body, selected)).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated" });
    expect(evaluateContractV5({}, body.replace("## 기록", "## Other"), selected).violations[0].message).toContain("missing");
    expect(evaluateContractV5({}, body.replace("## 기록", "### 기록"), selected).violations[0].message).toContain("level 2");
    expect(evaluateContractV5({}, "## 기록\n## Details\n## 메모", selected).violations[0].message).toContain("declared order");
    expect(evaluateContractV5({}, "## 기록\n## Details\n## 메모", contract({}, flower, "unordered")).valid).toBe(true);
  });

  it("ignores headings inside fences with correct delimiter length and character", () => {
    const selected = contract({}, [{ headingId: "x", title: "Real", level: 2 }]);
    for (const body of ["```md\n## Real\n```", "~~~~\n## Real\n```\n~~~\n## Real\n~~~~", "````\n## Real\n```\n## Real\n````"]) {
      expect(evaluateContractV5({}, body, selected).valid).toBe(false);
      expect(evaluateContractV5({}, `${body}\n## Real`, selected).valid).toBe(true);
    }
  });

  it("recognizes setext headings but not blockquotes, fenced or indented code", () => {
    const selected = contract({}, [{ headingId: "title", title: "A title", level: 1 }, { headingId: "detail", title: "Details", level: 2 }]);
    expect(evaluateContractV5({}, "A title\n=======\n\nDetails\n-------\n", selected).valid).toBe(true);
    expect(evaluateContractV5({}, "A\ntitle\n===\n\nDetails\n---", selected).valid).toBe(true);
    for (const body of ["> A title\n> =====\n", "    A title\n    =====\n", "```\nA title\n====\n```"]) {
      expect(evaluateContractV5({}, body, selected).valid).toBe(false);
    }
  });

  it("handles repeated names as ordered occurrences rather than confusing earlier extras", () => {
    const selected = contract({}, [{ headingId: "a1", title: "A", level: 2 }, { headingId: "b", title: "B", level: 2 }, { headingId: "a2", title: "A", level: 2 }]);
    expect(evaluateContractV5({}, "## A\n## A\n## B\n## A", selected).violations).toEqual([expect.objectContaining({ field: "body", rule: "heading" })]);
    expect(evaluateContractV5({}, "## A\n## B", selected).valid).toBe(false);
    expect(evaluateContractV5({}, "### A\n## B\n## A", selected).valid).toBe(false);
  });

  it("allows absent optional headings but checks their level/order when present", () => {
    const headings = [{ headingId: "a", title: "A", level: 2, required: false }, { headingId: "b", title: "B", level: 2 }];
    const selected = contract({}, headings);
    expect(evaluateContractV5({}, "## B", selected).valid).toBe(true);
    expect(evaluateContractV5({}, "## B\n## A", selected).valid).toBe(false);
    expect(evaluateContractV5({}, "### A\n## B", selected).valid).toBe(false);
  });

  it("binds dynamic slots before writing and refuses missing or unrelated bindings", () => {
    const selected = contract({}, [{ headingId: "discussed", title: "Discussed", level: 2 }, { headingId: "topic", binding: "meeting-topic", level: 3 }]);
    expect(evaluateContractV5({}, "## Discussed\n### Budget", selected, { "meeting-topic": "Budget" }).valid).toBe(true);
    expect(evaluateContractV5({}, "## Discussed\n### Budget", selected).violations.map(item => item.rule)).toContain("binding");
    expect(evaluateContractV5({}, "## Discussed\n### Other", selected, { "meeting-topic": "Budget" }).valid).toBe(false);
    expect(bindContractHeadings(selected, { "meeting-topic": "Budget", discussed: "Fake" }).violations[0].message).toContain("not a declared");
    expect(bindContractHeadings(selected, { "meeting-topic": "Budget\n## Injected" }).violations[0].rule).toBe("binding");
  });

  it("preserves BOM/CRLF, supports normalized Unicode, and does not review prose", () => {
    const selected = contract({}, [{ headingId: "title", title: "café", level: 2 }]);
    const body = "\uFEFF## cafe\u0301\r\nUnverified prose and {{literal}} example.\r\n";
    expect(evaluateContractV5({}, body, selected)).toMatchObject({ valid: true, semantic: "not-evaluated" });
    expect(body).toContain("\r\n");
  });

  it("fails loudly on oversized content instead of passing a partial scan", () => {
    expect(() => evaluateContractV5({}, "x".repeat(1_048_577), contract())).toThrow("CONTENT_CONTRACT_OVERSIZE");
    expect(() => evaluateContractV5({}, "\n".repeat(100_001), contract())).toThrow("CONTENT_CONTRACT_OVERSIZE");
  });
});

describe("additional heading policy", () => {
  const a2 = { headingId: "a", title: "A", level: 2 };
  const cases = [
    ["P1", [a2], undefined, "## A\n### Child\n", true],
    ["P2", [a2], "subordinate", "## A\n## Peer\n", false],
    ["P3", [a2], "subordinate", "### Before\n## A\n", false],
    ["P4", [a2], "allow", "# Before\n## A\n## Peer\n### Child\n", true],
    ["P6", [], "subordinate", "# Free\n\nPeer\n----\n", true],
    ["R1", [a2, { headingId: "b", title: "B", level: 4 }], "subordinate", "## A\n#### B\n### Child\n", true],
    ["R2", [a2, { headingId: "b", title: "B", level: 4 }], "subordinate", "## A\n#### B\n## Peer\n", false],
    ["R3", [a2, { headingId: "b", title: "B", level: 4 }], "subordinate", "## A\n#### B\n# Root\n### Later\n", false],
    ["D1", [{ headingId: "a1", title: "A", level: 2 }, { headingId: "b", title: "B", level: 2 }, { headingId: "a2", title: "A", level: 2 }], "subordinate", "## A\n## A\n## B\n## A\n", false],
    ["D2", [a2], "subordinate", "## A\n### A\n", true],
    ["D3", [a2, { headingId: "a2", title: "A", level: 2 }], "subordinate", "## A\n### A\n", false],
    ["O1", [{ ...a2, required: false }, { headingId: "b", title: "B", level: 2 }], "subordinate", "## B\n", true],
    ["O2", [{ ...a2, required: false }, { headingId: "b", title: "B", level: 2 }], "subordinate", "## B\n## A\n", false],
    ["O3", [{ ...a2, required: false }, { headingId: "b", title: "B", level: 2 }], "subordinate", "### A\n## B\n", false],
    ["U1", [a2, { headingId: "b", title: "B", level: 2 }], "subordinate", "## B\n### Child\n## A\n", true],
    ["U2", [a2, { headingId: "b", title: "B", level: 2 }], "subordinate", "## B\n## Peer\n## A\n", false],
    ["X1", [{ headingId: "a", title: "A", level: 1 }], "subordinate", "A\n===\n", true],
    ["X2", [a2], "subordinate", "A\n---\n\nPeer\n---\n", false],
    ["F1", [a2], "subordinate", "## A\n```md\n## Peer\nPeer\n---\n```\n", true],
    ["F2", [a2], "subordinate", "## A\n~~~~\n## Peer\nPeer\n---\n```\n~~~\n~~~~\n", true],
    ["F3", [a2], "subordinate", "## A\n````\n## Peer\nPeer\n---\n```\n````\n", true],
    ["F4", [a2], "subordinate", "> A\n> ---\n\n    A\n    ---\n", false],
  ] as const;
  it.each(cases)("%s follows the deterministic heading matrix", (id, headings, mode, body, pass) => {
    const selected = contract({}, headings, id === "U1" || id === "U2" ? "unordered" : "strict", mode);
    const result = evaluateContractV5({}, body, selected);
    expect(result.valid, id).toBe(pass);
    if (id === "P1") expect(selected.additionalHeadings).toBe("subordinate");
    if (!pass && ["P2", "P3", "R2", "R3", "D1", "U2", "X2"].includes(id)) expect(result.violations).toEqual(expect.arrayContaining([expect.objectContaining({ field: "body", rule: "heading" })]));
    if (id === "D3") expect(result.violations[0]).toEqual(expect.objectContaining({ field: "body:a2", rule: "heading", message: "Heading 'A' must be level 2, not 3." }));
    if (id === "O2") expect(result.violations[0]?.message).toContain("declared order");
    if (id === "O3") expect(result.violations[0]?.message).toContain("level 2");
    if (id === "F4") expect(result.violations[0]?.message).toContain("missing");
    if (id === "R3") expect(result.violations.filter(item => item.field === "body" && item.rule === "heading")).toHaveLength(2);
  });

  it("resolves inheritance and explicit individual override separately", () => {
    const headings = [a2];
    const inherited = rules({ status: "active", fields: {}, headings, additionalHeadings: "allow" }, { item: source("source-item", "Templates/item.md") });
    const overridden = rules({ status: "active", fields: {}, headings, additionalHeadings: "allow" }, { item: { ...source("source-item", "Templates/item.md"), additionalHeadings: "subordinate" } });
    expect(composeContractV5(inherited, "item").additionalHeadings).toBe("allow");
    expect(evaluateContractV5({}, "# Before\n## A\n", composeContractV5(inherited, "item")).valid).toBe(true);
    expect(composeContractV5(overridden, "item").additionalHeadings).toBe("subordinate");
    expect(evaluateContractV5({}, "# Before\n## A\n", composeContractV5(overridden, "item")).valid).toBe(false);
    expect(composeContractV5(rules({ status: "active", fields: {}, headings }), null).additionalHeadings).toBe("subordinate");
    expect(composeContractV5(rules({ status: "active", fields: {} }), null)).toMatchObject({ headings: [], additionalHeadings: "subordinate" });
  });

  it("changes only the effective digest when the resolved additional-heading policy changes", () => {
    const base = rules({ status: "active", fields: {}, headings: [a2] });
    const explicit = rules({ status: "active", fields: {}, headings: [a2], additionalHeadings: "subordinate" });
    const allowed = rules({ status: "active", fields: {}, headings: [a2], additionalHeadings: "allow" });
    expect(composeContractV5(base, null).contractDigest).toBe(composeContractV5(explicit, null).contractDigest);
    expect(composeContractV5(base, null).contractDigest).not.toBe(composeContractV5(allowed, null).contractDigest);
  });

  it("rejects unknown additional-heading values on both active scopes", () => {
    for (const value of [null, "open", 1]) {
      expect(() => parseContractPolicyV5(rules({ status: "active", fields: {}, additionalHeadings: value as never }))).toThrow("additionalHeadings");
      expect(() => parseContractPolicyV5(rules({ status: "active", fields: {} }, { item: { ...source("source-item", "Templates/item.md"), additionalHeadings: value as never } }))).toThrow("additionalHeadings");
    }
  });
  it("preserves undeclared unknown and exotic values and reports a declared unsupported type", () => {
    const note = { status: "open", when: new Date("2024-01-02T03:04:05.000Z"), ratio: Number.NaN, free: { nested: true } };
    const before = { ...note, when: note.when };
    const undeclared = evaluateContractV5(note, "", contract({ status: { required: true } }));
    expect(undeclared).toMatchObject({ valid: true, structural: "pass", semantic: "not-evaluated", violations: [] });
    expect(note.when).toBe(before.when);
    expect(Object.is(note.ratio, Number.NaN)).toBe(true);
    expect(note.free).toEqual({ nested: true });
    const declared = evaluateContractV5({ status: new Date("2024-01-02T03:04:05.000Z") }, "", contract({ status: { type: "text", required: true } }));
    expect(declared).toMatchObject({ valid: false, structural: "fail", semantic: "not-evaluated" });
    expect(declared.violations.map(item => item.rule)).toEqual(["type"]);
  });
});
