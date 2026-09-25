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

  it("reports a sealed template made stricter, which the judge would stop enforcing on notes that fail it", () => {
    const sealed = SEALED.templates["Meeting"]!;
    const stricter = { ...sealed, requiredProperties: ["status", "created"], requiredHeadings: ["Agenda", "Notes"], narrowedRules: { ...sealed.narrowedRules, code: [{ kind: "fixed", value: "ABC" }] } } satisfies TemplateContract;
    expect(looseningChanges(SEALED, withTemplate(stricter))).toEqual([
      { field: "templates.Meeting.requiredProperties.created", kind: "template-tightened" },
      { field: "templates.Meeting.narrowedRules.code", kind: "template-tightened" },
      { field: "templates.Meeting.requiredHeadings.Notes", kind: "template-tightened" },
    ]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, narrowedRules: { status: [{ kind: "fixed", value: "open" }, { kind: "pattern", regex: "o.*" }] } })))
      .toEqual([{ field: "templates.Meeting.narrowedRules.status", kind: "template-tightened" }]);
  });

  it("reports a narrowed rule whose property type becomes known, since the judge then checks that type", () => {
    const open: VaultContract = { folders: null, properties: null, templates: { Meeting: template({ narrowedRules: { status: [] } }) } };
    expect(looseningChanges(open, { ...open, properties: { status: property([]) } }))
      .toEqual([{ field: "templates.Meeting.narrowedRules.status", kind: "template-tightened" }]);
  });

  it("keeps a template equal when only its heading normalization or a single-valued fixed/allowed spelling differs", () => {
    const sealed: VaultContract = { ...SEALED, templates: { Meeting: template({ applyFolder: "Inbox", requiredHeadings: ["Caf\u00e9"], narrowedRules: { owner: [{ kind: "fixed", value: "me" }] } }) } };
    const next: VaultContract = { ...SEALED, templates: { Meeting: template({ applyFolder: "Inbox", requiredHeadings: ["Cafe\u0301"], narrowedRules: { owner: [{ kind: "allowed", values: ["me"] }] } }) } };
    expect(looseningChanges(sealed, next)).toEqual([]);
    expect(looseningChanges(next, sealed)).toEqual([]);
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
    const open: VaultContract = { ...SEALED, properties: null };
    expect(looseningChanges(open, { ...open, templates: { Meeting: template({ applyFolder: "Inbox", narrowedRules: { status: [{ kind: "allowed", values: ["open"] }] } }) } }))
      .toEqual([{ field: "templates.Meeting.narrowedRules.status", kind: "rule-removed" }]);
  });

  describe("list values, checked against the judge", () => {
    function listContract(rules: readonly Rule[]): VaultContract {
      return { folders: null, properties: { tags: property(rules, { type: "list" }) }, templates: {} };
    }

    function accepts(contract: VaultContract, tags: readonly string[], selectedTemplate?: string): boolean {
      const input = { path: "a.md", frontmatter: { tags }, body: "", ...selectedTemplate === undefined ? {} : { selectedTemplate } };
      return judge(input, { state: "sealed", contract }).ok;
    }

    it("reports an allowed list replaced by fixed members, which would pass an unlisted member", () => {
      const sealed = listContract([{ kind: "allowed", values: ["a", "b"] }]);
      for (const next of [listContract([{ kind: "fixed", value: "a" }]), listContract([{ kind: "fixed", value: "a" }, { kind: "fixed", value: "b" }])]) {
        expect(accepts(sealed, ["a", "b", "evil"])).toBe(false);
        expect(accepts(next, ["a", "b", "evil"])).toBe(true);
        expect(looseningChanges(sealed, next)).toEqual([{ field: "properties.tags", kind: "rule-removed" }]);
      }
    });

    it("reports a fixed member replaced by a one-value allowed list, which would pass an empty list", () => {
      const scoped = (rules: readonly Rule[]): VaultContract => ({
        folders: null, properties: null,
        templates: { Tagged: template({ applyFolder: "", requiredProperties: [], requiredHeadings: [], narrowedRules: { tags: rules } }) },
      });
      const sealed = scoped([{ kind: "fixed", value: "a" }]);
      const next = scoped([{ kind: "allowed", values: ["a"] }]);
      expect(accepts(sealed, [], "Tagged")).toBe(false);
      expect(accepts(next, [], "Tagged")).toBe(true);
      expect(looseningChanges(sealed, next)).toEqual([{ field: "templates.Tagged.narrowedRules.tags", kind: "rule-removed" }]);
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

  it("reports template loosening by field path only", () => {
    const sealed = SEALED.templates["Meeting"]!;
    expect(looseningChanges(SEALED, withTemplate(undefined))).toEqual([{ field: "templates.Meeting", kind: "removed" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, requiredProperties: [] }))).toEqual([{ field: "templates.Meeting.requiredProperties.status", kind: "required-dropped" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, requiredHeadings: [] }))).toEqual([{ field: "templates.Meeting.requiredHeadings.Agenda", kind: "heading-dropped" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, narrowedRules: {} }))).toEqual([{ field: "templates.Meeting.narrowedRules.status", kind: "rule-removed" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, narrowedRules: { status: [{ kind: "fixed", value: "done" }] } }))).toEqual([{ field: "templates.Meeting.narrowedRules.status", kind: "fixed-changed" }]);
    const { applyFolder: _dropped, ...unscoped } = sealed;
    expect(looseningChanges(SEALED, withTemplate(unscoped))).toEqual([{ field: "templates.Meeting.applyFolder", kind: "apply-folder-changed" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, applyFolder: "Private" }))).toEqual([{ field: "templates.Meeting.applyFolder", kind: "apply-folder-changed" }]);
  });

  it("reports a moved template source, which search exclusion no longer covers", () => {
    const sealed = SEALED.templates["Meeting"]!;
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, source: "Templates/Moved.md" }))).toEqual([{ field: "templates.Meeting.source", kind: "removed" }]);
    expect(looseningChanges(SEALED, withTemplate({ ...sealed, source: "Templates//Meeting.md/" }))).toEqual([]);
  });

  it("compares apply folders after NFC and separator normalization", () => {
    const decomposed = "Cafe\u0301";
    const sealed: VaultContract = { ...SEALED, templates: { Meeting: template({ applyFolder: `${decomposed.normalize("NFC")}/Notes` }) } };
    for (const applyFolder of [`${decomposed}/Notes`, `${decomposed}\\Notes/`, `./${decomposed}//Notes`]) {
      expect(looseningChanges(sealed, { ...sealed, templates: { Meeting: template({ applyFolder }) } })).toEqual([]);
    }
    expect(looseningChanges(sealed, { ...sealed, templates: { Meeting: template({ applyFolder: "Cafe/Notes" }) } })).toEqual([{ field: "templates.Meeting.applyFolder", kind: "apply-folder-changed" }]);
  });

  it("keeps an edit to a note that fails a tightened template judged by the sealed template", () => {
    const sealed: VaultContract = { ...SEALED, properties: null };
    const next: VaultContract = { ...sealed, templates: { Meeting: template({ ...sealed.templates["Meeting"]!, requiredHeadings: ["Agenda", "Notes"] }) } };
    const edit = { path: "Inbox/a.md", frontmatter: {}, body: "no headings\n", previousContent: "---\nstatus: open\n---\n## Agenda\n" };
    expect(judge(edit, { state: "sealed", contract: sealed }).ok).toBe(false);
    expect(judge(edit, { state: "sealed", contract: next }).ok).toBe(true);
    expect(looseningChanges(sealed, next)).toEqual([{ field: "templates.Meeting.requiredHeadings.Notes", kind: "template-tightened" }]);
  });

  describe("apply folder overlap", () => {
    function withScoped(applyFolder: string): VaultContract {
      return { ...SEALED, templates: { ...SEALED.templates, Daily: template({ source: "Templates/Daily.md", applyFolder }) } };
    }

    it("reports a new template scoped to the same, an enclosing or an enclosed folder", () => {
      for (const folder of ["Inbox", "", "Inbox/Sub"]) {
        expect(looseningChanges(SEALED, withScoped(folder))).toEqual([{ field: "templates.Daily.applyFolder", kind: "apply-folder-overlap" }]);
      }
    });

    it("accepts a new template scoped to a folder that does not overlap", () => {
      expect(looseningChanges(SEALED, withScoped("Private"))).toEqual([]);
      expect(looseningChanges(SEALED, withScoped("Inboxes"))).toEqual([]);
    });

    it("reports a sealed unscoped template gaining an overlapping folder", () => {
      const sealed: VaultContract = { ...SEALED, templates: { ...SEALED.templates, Daily: template({ source: "Templates/Daily.md" }) } };
      expect(looseningChanges(sealed, withScoped("Inbox"))).toEqual([{ field: "templates.Daily.applyFolder", kind: "apply-folder-overlap" }]);
      expect(looseningChanges(sealed, withScoped("Private"))).toEqual([]);
    });

    it("keeps an overlapping edit rejected by the sealed template", () => {
      const next = withScoped("Inbox");
      const previousContent = "---\nstatus: open\n---\n## Agenda\n";
      const edit = { path: "Inbox/a.md", frontmatter: { status: "done" }, body: "## Agenda\n", previousContent };
      expect(judge(edit, { state: "sealed", contract: SEALED }).ok).toBe(false);
      expect(judge(edit, { state: "sealed", contract: next }).ok).toBe(true);
    });
  });

  it("reads narrowed rules only as own properties", () => {
    const sealed = SEALED.templates["Meeting"]!;
    const next = withTemplate({ ...sealed, narrowedRules: { status: [{ kind: "fixed", value: "open" }] } });
    const withConstructor: VaultContract = { ...SEALED, templates: { Meeting: { ...sealed, narrowedRules: { ...sealed.narrowedRules, constructor: [{ kind: "fixed", value: "x" }] } } } };
    expect(looseningChanges(withConstructor, next)).toEqual([{ field: "templates.Meeting.narrowedRules.constructor", kind: "rule-removed" }]);
  });

  it("names sealed patterns the seal screen now refuses by field only", () => {
    const long = `a{1}${"b".repeat(PATTERN_SOURCE_LIMIT)}`;
    const contract: VaultContract = {
      ...SEALED,
      properties: { ...SEALED.properties, code: property([{ kind: "pattern", regex: long }]) },
      templates: { Meeting: template({ narrowedRules: { owner: [{ kind: "pattern", regex: "(a+)+" }] } }) },
    };
    expect(unsafePatternChanges(SEALED)).toEqual([]);
    expect(unsafePatternChanges(contract)).toEqual([
      { field: "properties.code", kind: "pattern-unsafe" },
      { field: "templates.Meeting.narrowedRules.owner", kind: "pattern-unsafe" },
    ]);
    expect(JSON.stringify(unsafePatternChanges(contract))).not.toContain("bbb");
  });

  it("never puts a rule value in a change", () => {
    const next = withProperty("owner", property([{ kind: "fixed", value: "secret-value" }]));
    expect(JSON.stringify(looseningChanges(SEALED, next))).not.toMatch(/secret-value|"me"/);
  });
});
