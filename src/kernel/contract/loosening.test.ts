import { describe, expect, it } from "vitest";

import { judge } from "./judge.js";
import { isNonLoosening, looseningChanges, unsafePatternChanges } from "./loosening.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import type { PropertyContract, Rule, TemplateContract, VaultContract } from "./types.js";

const HASH = `sha256:${"a".repeat(64)}`;

function property(rules: readonly Rule[], extra: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "", type: "text", default: false, required: false, rules, ...extra };
}

function template(extra: Partial<TemplateContract> = {}): TemplateContract {
  return { source: "Templates/Meeting.md", sourceHash: HASH, requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Agenda"], ...extra };
}

const SEALED: VaultContract = {
  folders: { Inbox: { meaning: "", searchExclude: false }, Private: { meaning: "", searchExclude: true } },
  properties: {
    status: property([{ kind: "allowed", values: ["open", "done"] }], { required: true }),
    code: property([{ kind: "pattern", regex: "[A-Z]{3}" }]),
    owner: property([{ kind: "fixed", value: "me" }]),
    score: property([{ kind: "range", min: 1, max: 10 }], { type: "number" }),
  },
  templates: { Meeting: template({ applyFolder: "Inbox", narrowedRules: { status: [{ kind: "fixed", value: "open" }] } }) },
};

function withProperty(name: string, next: PropertyContract | undefined): VaultContract {
  const properties = { ...SEALED.properties };
  if (next === undefined) delete properties[name];
  else properties[name] = next;
  return { ...SEALED, properties };
}

function withTemplate(next: TemplateContract | undefined): VaultContract {
  return { ...SEALED, templates: next === undefined ? {} : { Meeting: next } };
}

describe("looseningChanges", () => {
  it("accepts the same contract", () => {
    expect(looseningChanges(SEALED, SEALED)).toEqual([]);
    expect(isNonLoosening(SEALED, SEALED)).toBe(true);
  });

  it("accepts additions and tighter rules", () => {
    const next: VaultContract = {
      folders: { ...SEALED.folders, Projects: { meaning: "work", searchExclude: false }, Inbox: { meaning: "changed meaning", searchExclude: true } },
      properties: {
        ...SEALED.properties,
        status: property([{ kind: "allowed", values: ["open"] }, { kind: "pattern", regex: "o.*" }], { required: true, default: true }),
        code: property([{ kind: "pattern", regex: "[A-Z]{3}" }], { required: true }),
        score: property([{ kind: "range", min: 2, max: 9 }], { type: "number" }),
        created: property([]),
      },
      templates: {
        Meeting: SEALED.templates["Meeting"]!,
        Daily: template({ source: "Templates/Daily.md" }),
      },
    };
    expect(looseningChanges(SEALED, next)).toEqual([]);
  });

  it("accepts a first-time applyFolder and a closed axis", () => {
    const open: VaultContract = { folders: null, properties: null, templates: { Meeting: template() } };
    const closed: VaultContract = { folders: { Inbox: { meaning: "", searchExclude: false } }, properties: { status: property([]) }, templates: { Meeting: template({ applyFolder: "Inbox" }) } };
    expect(isNonLoosening(open, closed)).toBe(true);
  });

  it("reports opened axes", () => {
    expect(looseningChanges(SEALED, { ...SEALED, folders: null, properties: null })).toEqual([
      { field: "folders", kind: "axis-opened" },
      { field: "properties", kind: "axis-opened" },
    ]);
  });

  it("reports a removed folder and a dropped search exclusion", () => {
    expect(looseningChanges(SEALED, { ...SEALED, folders: { Private: { meaning: "", searchExclude: false } } })).toEqual([
      { field: "folders.Inbox", kind: "removed" },
      { field: "folders.Private", kind: "search-exclude-dropped" },
    ]);
  });

  it("reports a removed property, a changed type and a dropped requirement", () => {
    expect(looseningChanges(SEALED, withProperty("owner", undefined))).toEqual([{ field: "properties.owner", kind: "removed" }]);
    expect(looseningChanges(SEALED, withProperty("owner", property([{ kind: "fixed", value: "me" }], { type: "tags" })))).toEqual([{ field: "properties.owner", kind: "type-changed" }]);
    expect(looseningChanges(SEALED, withProperty("status", property([{ kind: "allowed", values: ["open", "done"] }])))).toEqual([{ field: "properties.status", kind: "required-dropped" }]);
  });

  it("reports each loosened rule kind", () => {
    const required = { required: true };
    expect(looseningChanges(SEALED, withProperty("status", property([], required)))).toEqual([{ field: "properties.status", kind: "rule-removed" }]);
    expect(looseningChanges(SEALED, withProperty("status", property([{ kind: "allowed", values: ["open", "done", "later"] }], required)))).toEqual([{ field: "properties.status", kind: "allowed-widened" }]);
    expect(looseningChanges(SEALED, withProperty("owner", property([{ kind: "fixed", value: "you" }])))).toEqual([{ field: "properties.owner", kind: "fixed-changed" }]);
    expect(looseningChanges(SEALED, withProperty("code", property([{ kind: "pattern", regex: "[A-Z]+" }])))).toEqual([{ field: "properties.code", kind: "pattern-changed" }]);
    expect(looseningChanges(SEALED, withProperty("code", property([{ kind: "allowed", values: ["ABC"] }])))).toEqual([{ field: "properties.code", kind: "rule-removed" }]);
  });

  it("lets a fixed value and an allowed list stand in for each other only for a single-valued type", () => {
    const required = { required: true };
    expect(looseningChanges(SEALED, withProperty("status", property([{ kind: "fixed", value: "open" }], required)))).toEqual([]);
    expect(looseningChanges(SEALED, withProperty("owner", property([{ kind: "allowed", values: ["me"] }])))).toEqual([]);
    expect(looseningChanges(SEALED, withProperty("status", property([{ kind: "fixed", value: "later" }], required)))).toEqual([{ field: "properties.status", kind: "rule-removed" }]);
    expect(looseningChanges(SEALED, withProperty("owner", property([{ kind: "allowed", values: ["me", "you"] }])))).toEqual([{ field: "properties.owner", kind: "rule-removed" }]);
    expect(looseningChanges(SEALED, withProperty("owner", property([{ kind: "allowed", values: [] }])))).toEqual([{ field: "properties.owner", kind: "rule-removed" }]);
  });

  it("never lets a fixed value and an allowed list stand in for each other for a list type or an unregistered field", () => {
    const list = { type: "list" as const, required: true };
    const sealed = withProperty("status", property([{ kind: "allowed", values: ["open", "done"] }], list));
    expect(looseningChanges(sealed, withProperty("status", property([{ kind: "fixed", value: "open" }], list)))).toEqual([{ field: "properties.status", kind: "rule-removed" }]);
  });

  describe("list values, checked against the judge", () => {
    function listContract(rules: readonly Rule[]): VaultContract {
      return { folders: null, properties: { tags: property(rules, { type: "list" }) }, templates: {} };
    }

    function accepts(contract: VaultContract, tags: readonly string[]): boolean {
      return judge({ path: "a.md", frontmatter: { tags }, body: "" }, { state: "sealed", contract }).warnings.length === 0;
    }

    it("reports an allowed list replaced by fixed members, which would pass an unlisted member", () => {
      const sealed = listContract([{ kind: "allowed", values: ["a", "b"] }]);
      for (const next of [listContract([{ kind: "fixed", value: "a" }]), listContract([{ kind: "fixed", value: "a" }, { kind: "fixed", value: "b" }])]) {
        expect(accepts(sealed, ["a", "b", "evil"])).toBe(false);
        expect(accepts(next, ["a", "b", "evil"])).toBe(true);
        expect(looseningChanges(sealed, next)).toEqual([{ field: "properties.tags", kind: "rule-removed" }]);
      }
    });

    it("accepts a narrower allowed list, which rejects everything the sealed one rejected", () => {
      const sealed = listContract([{ kind: "allowed", values: ["a", "b"] }]);
      const next = listContract([{ kind: "allowed", values: ["a"] }]);
      expect(looseningChanges(sealed, next)).toEqual([]);
      for (const tags of [["a", "evil"], ["b"], ["evil"]]) {
        if (!accepts(sealed, tags)) expect(accepts(next, tags)).toBe(false);
      }
    });
  });

  it("reports a widened, unbounded or retyped range", () => {
    const number = { type: "number" as const };
    for (const range of [{ min: 0, max: 10 }, { min: 1, max: 11 }, { max: 10 }, { min: 1 }, { min: "1", max: 10 }]) {
      expect(looseningChanges(SEALED, withProperty("score", property([{ kind: "range", ...range }], number)))).toEqual([{ field: "properties.score", kind: "range-widened" }]);
    }
  });

  it("accepts a tightened count and reports a widened, unbounded or removed one", () => {
    const tags = (rules: readonly Rule[]) => withProperty("tags", property(rules, { type: "list" }));
    const sealed = tags([{ kind: "count", min: 1, max: 3 }]);
    for (const count of [{ min: 1, max: 3 }, { min: 2, max: 3 }, { min: 1, max: 2 }]) {
      expect(looseningChanges(sealed, tags([{ kind: "count", ...count }]))).toEqual([]);
    }
    for (const count of [{ min: 0, max: 3 }, { min: 1, max: 4 }, { max: 3 }, { min: 1 }]) {
      expect(looseningChanges(sealed, tags([{ kind: "count", ...count }]))).toEqual([{ field: "properties.tags", kind: "count-widened" }]);
    }
    expect(looseningChanges(sealed, tags([]))).toEqual([{ field: "properties.tags", kind: "rule-removed" }]);
    expect(looseningChanges(tags([]), sealed)).toEqual([]);
  });

  it("reports a removed template by field path only, and nothing the judge no longer reads", () => {
    const sealed = SEALED.templates["Meeting"]!;
    expect(looseningChanges(SEALED, withTemplate(undefined))).toEqual([{ field: "templates.Meeting", kind: "removed" }]);
    const { applyFolder: _dropped, ...unscoped } = sealed;
    for (const next of [
      { ...sealed, requiredProperties: [] },
      { ...sealed, requiredProperties: ["status", "created"] },
      { ...sealed, requiredHeadings: [] },
      { ...sealed, requiredHeadings: ["Agenda", "Notes"] },
      { ...sealed, narrowedRules: {} },
      { ...sealed, narrowedRules: { status: [{ kind: "fixed", value: "done" }] } },
      unscoped,
      { ...sealed, applyFolder: "Private" },
    ] satisfies TemplateContract[]) {
      expect(looseningChanges(SEALED, withTemplate(next))).toEqual([]);
    }
    expect(looseningChanges(SEALED, { ...SEALED, templates: { ...SEALED.templates, Daily: template({ source: "Templates/Daily.md", applyFolder: "Inbox" }) } })).toEqual([]);
  });

  it("reports a moved template source, which search exclusion no longer covers", () => {
    const sealed = SEALED.templates["Meeting"]!;
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, source: "Templates/Moved.md" }))).toEqual([{ field: "templates.Meeting.source", kind: "removed" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, source: "Templates//Meeting.md/" }))).toEqual([]);
  });

  it("names sealed patterns the seal screen now refuses by field only", () => {
    const long = `a{1}${"b".repeat(PATTERN_SOURCE_LIMIT)}`;
    const contract: VaultContract = {
      ...SEALED,
      properties: { ...SEALED.properties, code: property([{ kind: "pattern", regex: long }]) },
      templates: { Meeting: template({ narrowedRules: { owner: [{ kind: "pattern", regex: "(a+)+" }] } }) },
    };
    expect(unsafePatternChanges(SEALED)).toEqual([]);
    // A template's narrowed rules are never judged, so only property patterns are named.
    expect(unsafePatternChanges(contract)).toEqual([{ field: "properties.code", kind: "pattern-unsafe" }]);
    expect(JSON.stringify(unsafePatternChanges(contract))).not.toContain("bbb");
  });

  it("never puts a rule value in a change", () => {
    const next = withProperty("owner", property([{ kind: "fixed", value: "secret-value" }]));
    expect(JSON.stringify(looseningChanges(SEALED, next))).not.toMatch(/secret-value|"me"/);
  });
});
