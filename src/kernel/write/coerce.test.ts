import { describe, expect, it } from "vitest";
import type { PropertyContract, VaultContract, Violation } from "../contract/types.js";
import { coerceFrontmatter } from "./coerce.js";

const NOW = new Date(2026, 8, 29, 10, 11, 12);

function property(type: PropertyContract["type"], extra: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "a field", type, default: false, required: false, rules: [], ...extra };
}

const CONTRACT: VaultContract = {
  folders: null,
  properties: {
    size: property("number"),
    done: property("checkbox"),
    topics: property("list"),
    day: property("date"),
    label: property("text"),
    mood: property("text", { rules: [{ kind: "allowed", values: ["Calm", "calm ", "Tense"] }] }),
    moods: property("list", { rules: [{ kind: "allowed", values: ["Calm", "Tense"] }] }),
    kind: property("text", { required: true, rules: [{ kind: "fixed", value: "note" }] }),
    kinds: property("list", { required: true, rules: [{ kind: "fixed", value: "note" }] }),
    created: property("date", { default: true }),
    stamped: property("datetime", { default: true }),
    shade: property("text", { default: true }),
  },
  templates: {},
};

function coerce(content: string, warnings: readonly Violation[], isNew = true, contract = CONTRACT) {
  return coerceFrontmatter(content, warnings, { contract, isNew, now: NOW });
}

describe("coerceFrontmatter type fixes", () => {
  it.each([
    ["a number string for a number", "size: \"12\"", "size", "size: 12"],
    ["a negative decimal string for a number", "size: \"-1.5\"", "size", "size: -1.5"],
    ["a boolean string for a checkbox", "done: \"false\"", "done", "done: false"],
    ["a scalar for a list", "topics: ai", "topics", "topics: [ai]"],
    ["a midnight datetime for a date", "day: 2026-09-29T00:00", "day", "day: 2026-09-29"],
    ["a number for a text", "label: 42", "label", "label: \"42\""],
  ])("fixes %s", (_name, line, field, expected) => {
    const result = coerce(`---\n${line}\n---\nBody\n`, [{ field, kind: "type" }]);
    expect(result).toEqual({ content: `---\n${expected}\n---\nBody\n`, fixes: [{ field, kind: "type" }] });
  });

  it.each([
    ["\"12a\" for a number", "size: \"12a\"", "size"],
    ["\"012\" for a number, which would lose the leading zero", "size: \"012\"", "size"],
    ["\"yes\" for a checkbox", "done: \"yes\"", "done"],
    ["a non-midnight datetime for a date", "day: 2026-09-29T10:00", "day"],
    ["a map for a list", "topics:\n  a: 1", "topics"],
    ["1.0 for a text, which would drop the decimal", "label: 1.0", "label"],
    ["01234 for a text, which would drop the leading zero", "label: 01234", "label"],
    ["0x1F for a text, which would become 31", "label: 0x1F", "label"],
    ["an integer past 2^53 for a text, which would lose digits", "label: 12345678901234567890", "label"],
    ["01234 for a list, which would drop the leading zero", "topics: 01234", "topics"],
    ["a tagged string, which cannot be replaced in place", "size: !!str 12", "size"],
  ])("refuses to fix %s", (_name, line, field) => {
    expect(coerce(`---\n${line}\n---\nBody\n`, [{ field, kind: "type" }])).toBeNull();
  });
});

describe("coerceFrontmatter allowed-value spelling", () => {
  it("fixes a value that NFC + trim + case-fold matches exactly one allowed value, keeping its quote style", () => {
    const result = coerce("---\nmood: \" TENSE \"\n---\n", [{ field: "mood", kind: "not-allowed" }]);
    expect(result).toEqual({ content: "---\nmood: \"Tense\"\n---\n", fixes: [{ field: "mood", kind: "not-allowed" }] });
  });

  it("fixes each member of a list", () => {
    const result = coerce("---\nmoods:\n  - calm\n  - Tense\n---\n", [{ field: "moods", kind: "not-allowed" }]);
    expect(result?.content).toBe("---\nmoods:\n  - Calm\n  - Tense\n---\n");
  });

  it("refuses when two allowed values match after case-fold", () => {
    expect(coerce("---\nmood: CALM\n---\n", [{ field: "mood", kind: "not-allowed" }])).toBeNull();
  });

  it("refuses when no allowed value matches", () => {
    expect(coerce("---\nmood: angry\n---\n", [{ field: "mood", kind: "not-allowed" }])).toBeNull();
  });

  it("refuses when one list member has no match", () => {
    expect(coerce("---\nmoods:\n  - calm\n  - angry\n---\n", [{ field: "moods", kind: "not-allowed" }])).toBeNull();
  });
});

describe("coerceFrontmatter missing values", () => {
  it("fills a required property whose rule fixes its value, as a list for a list type", () => {
    const result = coerce("---\nlabel: a\n---\n", [{ field: "kind", kind: "missing" }, { field: "kinds", kind: "missing" }], false);
    expect(result).toEqual({
      content: "---\nlabel: a\nkind: note\nkinds: [note]\n---\n",
      fixes: [{ field: "kind", kind: "missing" }, { field: "kinds", kind: "missing" }],
    });
  });

  it("fills an unconstrained date and datetime default on a new note only", () => {
    const warnings: Violation[] = [{ field: "created", kind: "missing" }, { field: "stamped", kind: "missing" }];
    expect(coerce("---\nlabel: a\n---\n", warnings)?.content).toBe("---\nlabel: a\ncreated: 2026-09-29\nstamped: 2026-09-29T10:11:12\n---\n");
    expect(coerce("---\nlabel: a\n---\n", warnings, false)).toBeNull();
  });

  it("never invents a default that is not a date", () => {
    expect(coerce("---\nlabel: a\n---\n", [{ field: "shade", kind: "missing" }])).toBeNull();
  });

  it("adds a frontmatter block to a note that has none", () => {
    expect(coerce("Body\n", [{ field: "kind", kind: "missing" }])?.content).toBe("---\nkind: note\n---\nBody\n");
  });
});

describe("coerceFrontmatter leaves notes alone", () => {
  it("returns null when the contract seals no properties", () => {
    expect(coerce("---\nsize: \"12\"\n---\n", [{ field: "size", kind: "type" }], true, { ...CONTRACT, properties: null })).toBeNull();
  });

  it("returns null for frontmatter that does not parse", () => {
    expect(coerce("---\nsize: [\"12\"\n---\n", [{ field: "size", kind: "type" }])).toBeNull();
  });

  it("returns null for a skipped field, an unknown field or a kind it never fixes", () => {
    expect(coerceFrontmatter("---\nsize: \"12\"\n---\n", [{ field: "size", kind: "type" }], { contract: CONTRACT, isNew: true }, new Set(["size"]))).toBeNull();
    expect(coerce("---\nother: \"12\"\n---\n", [{ field: "other", kind: "type" }])).toBeNull();
    expect(coerce("---\nother: 1\n---\n", [{ field: "other", kind: "unknown-property" }])).toBeNull();
  });

  it("changes only the fixed value's bytes, leaving every other key as written", () => {
    const long = `"${"word ".repeat(30).trim()}"`;
    const content = `---\nw: 012\nlist: [a,   b]\nquote: ${long}\nsize: "12"\ntail: 'x' # note\n---\nBody\n`;
    const result = coerce(content, [{ field: "size", kind: "type" }]);
    expect(result?.content).toBe(content.replace("size: \"12\"", "size: 12"));
  });

  it("fills an empty value after its colon and keeps a comment after a fixed value", () => {
    expect(coerce("---\nkind:\nlabel: a\n---\n", [{ field: "kind", kind: "missing" }])?.content).toBe("---\nkind: note\nlabel: a\n---\n");
    expect(coerce("---\nsize: \"12\" # count\n---\n", [{ field: "size", kind: "type" }])?.content).toBe("---\nsize: 12 # count\n---\n");
  });

  it("fills a fixed value as a single value for an untyped property", () => {
    const contract: VaultContract = { ...CONTRACT, properties: { loose: property(null as unknown as PropertyContract["type"], { required: true, rules: [{ kind: "fixed", value: "y" }] }) } };
    expect(coerce("---\na: 1\n---\n", [{ field: "loose", kind: "missing" }], true, contract)?.content).toBe("---\na: 1\nloose: y\n---\n");
  });

  it("applies the fixes it can place when another field's value is tagged", () => {
    const result = coerce("---\nsize: !!str 12\ndone: \"true\"\n---\n", [{ field: "size", kind: "type" }, { field: "done", kind: "type" }]);
    expect(result).toEqual({ content: "---\nsize: !!str 12\ndone: true\n---\n", fixes: [{ field: "done", kind: "type" }] });
  });

  it("keeps the body, other keys and CRLF line endings as written", () => {
    const result = coerce("---\r\nlabel: keep\r\nsize: \"3\"\r\n---\r\nBody\r\n", [{ field: "size", kind: "type" }]);
    expect(result?.content).toBe("---\r\nlabel: keep\r\nsize: 3\r\n---\r\nBody\r\n");
  });
});
