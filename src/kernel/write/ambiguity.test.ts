import { describe, expect, it, vi } from "vitest";
import { judgeContent } from "../contract/judge-write.js";
import { verdictOf, type ContractView, type PropertyContract, type Verdict, type VaultContract } from "../contract/types.js";
import { gapAxisOf, resolveTiers, templateChoices, type AmbiguityInput } from "./ambiguity.js";
import { parseLiveTemplate, type LiveTemplate } from "./live-templates.js";

function property(extra: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "", type: "text", default: false, required: false, rules: [], ...extra };
}

function live(name: string, frontmatter: string): LiveTemplate {
  return parseLiveTemplate(`Templates/${name}.md`, `---\n${frontmatter}\n---\n`) as LiveTemplate;
}

const CONTRACT: VaultContract = {
  folders: { Inbox: { meaning: "", searchExclude: false }, Meetings: { meaning: "", searchExclude: false } },
  properties: {
    status: property({ rules: [{ kind: "allowed", values: ["open", "done"] }] }),
    title: property({ required: true }),
    owner: property(),
    tags: property({ type: "list", rules: [{ kind: "count", max: 2 }] }),
  },
};

/** Live templates, sorted by name as `loadLiveTemplates` returns them. */
const TEMPLATES: readonly LiveTemplate[] = [
  live("Review", "folder: Meetings\nstatus: open"),
  live("Solo", "folder: Inbox\nowner: me"),
  live("Standup", "folder: Meetings\nowner: me"),
];

const SEALED: ContractView = { state: "sealed", contract: CONTRACT };

function input(path: string, content: string, extra: Partial<AmbiguityInput> = {}): AmbiguityInput {
  const view = extra.view ?? SEALED;
  const judgeWith = (text: string): Verdict => judgeContent({ path, content: text }, view);
  return { view, path, content, verdict: judgeWith(content), rejudge: judgeWith, ...extra };
}

describe("gapAxisOf", () => {
  it("maps frame violations to an axis and everything else to null", () => {
    expect(gapAxisOf("unregistered-folder")).toBe("folder");
    expect(gapAxisOf("unknown-property")).toBe("property");
    expect(gapAxisOf("count")).toBe("value");
    expect(gapAxisOf("path-unsafe")).toBeNull();
    expect(gapAxisOf("contract-unreadable")).toBeNull();
  });
});

describe("resolveTiers outside a sealed contract", () => {
  it("saves an open or broken vault's note as written with its warning and records nothing", () => {
    const open = input("a.md", "x\n", { view: { state: "open" } });
    expect(open.verdict.warnings).toEqual([{ field: "contract", kind: "contract-open" }]);
    expect(resolveTiers(open)).toEqual({ action: "save", content: "x\n", verdict: open.verdict, findings: [] });
    const broken = input("a.md", "x\n", { view: { state: "unreadable", reason: "broken" } });
    expect(broken.verdict).toMatchObject({ ok: true, warnings: [{ field: "contract", kind: "contract-unreadable" }] });
    expect(resolveTiers(broken)).toEqual({ action: "save", content: "x\n", verdict: broken.verdict, findings: [] });
  });

  it("refuses a tampered vault", () => {
    const tampered = input("a.md", "x\n", { view: { state: "unreadable", reason: "tampered" } });
    expect(tampered.verdict).toMatchObject({ ok: false, refusals: [{ field: "contract", kind: "contract-tampered" }] });
    expect(resolveTiers(tampered)).toEqual({ action: "refuse", reason: "refused" });
  });
});

describe("① and ② with an accepting verdict", () => {
  it("saves as written with nothing to record", () => {
    const accepted = input("Inbox/a.md", "---\ntitle: A\n---\nbody\n");
    expect(resolveTiers(accepted)).toEqual({ action: "save", content: accepted.content, verdict: accepted.verdict, findings: [] });
  });

  it("records a template choice for a new note in a folder two live templates match", () => {
    const note = input("Meetings/a.md", "---\ntitle: A\nstatus: open\n---\n", { templates: TEMPLATES, isNew: true });
    expect(resolveTiers(note)).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "template", kind: "choice", chosen: "Review", wanted: { field: "template", value: ["Review", "Standup"] }, reason: "2 templates match the folder and none was selected" }],
    });
    // An existing note, a selected template or no live templates record no choice.
    expect(resolveTiers({ ...note, isNew: false })).toMatchObject({ findings: [] });
    expect(resolveTiers({ ...note, template: "Standup" })).toMatchObject({ findings: [] });
    expect(resolveTiers({ ...note, templates: undefined })).toMatchObject({ findings: [] });
  });

  it("recommends nothing when no candidate fits and records no choice once one is selected or only one applies", () => {
    expect(templateChoices(TEMPLATES, "Meetings/a.md", undefined, { title: "A" })).toMatchObject([{ chosen: null }]);
    expect(templateChoices(TEMPLATES, "Meetings/a.md", undefined, { title: "A", owner: "me", status: "open" })).toMatchObject([{ chosen: "Review" }]);
    expect(templateChoices(TEMPLATES, "Meetings/a.md", undefined, { owner: "me" })).toMatchObject([{ chosen: "Standup" }]);
    expect(templateChoices(TEMPLATES, "Meetings/a.md", "Standup", {})).toEqual([]);
    expect(templateChoices(TEMPLATES, "Inbox/a.md", undefined, {})).toEqual([]);
    expect(templateChoices([live("Loose", "owner: me")], "Inbox/a.md", undefined, {})).toEqual([]);
  });
});

describe("W kept", () => {
  it("saves unknown keys and out-of-rule values as written and records each as kept", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\nstatus: maybe\ntags: [a, b, c]\n---\nbody\n");
    const resolution = resolveTiers(note);
    expect(resolution).toMatchObject({ action: "save", content: note.content, verdict: { ok: true, fixes: [] } });
    expect(resolution.action === "save" && resolution.findings).toEqual([
      { axis: "property", kind: "kept", chosen: null, wanted: { field: "mood", value: "calm" }, reason: "kept: unknown-property" },
      { axis: "value", kind: "kept", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "kept: not-allowed" },
      { axis: "value", kind: "kept", chosen: null, wanted: { field: "tags", value: ["a", "b", "c"] }, reason: "kept: count" },
    ]);
  });

  it("records a non-scalar want by field only", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nowner:\n  name: me\nmood: [{x: 1}]\n---\n");
    const resolution = resolveTiers(note);
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.wanted)).toEqual([{ field: "mood" }, { field: "owner" }]);
  });

  it("keeps a missing key, an unregistered folder and a pattern miss as written", () => {
    expect(resolveTiers(input("Inbox/a.md", "body\n"))).toMatchObject({
      action: "save", content: "body\n",
      findings: [{ axis: "property", kind: "kept", chosen: null, wanted: { field: "title" }, reason: "kept: missing" }],
    });
    expect(resolveTiers(input("Elsewhere/a.md", "---\ntitle: A\n---\n"))).toMatchObject({ action: "save", findings: [{ axis: "folder", kind: "kept", reason: "kept: unregistered-folder" }] });
    const patterned: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, title: property({ required: true, rules: [{ kind: "pattern", regex: "^[A-Z]" }] }) } } };
    expect(resolveTiers(input("Inbox/a.md", "---\ntitle: lower\n---\n", { view: patterned }))).toMatchObject({ action: "save", findings: [{ kind: "kept", reason: "kept: pattern" }] });
  });
});

describe("F fixed", () => {
  const typed: ContractView = {
    state: "sealed",
    contract: {
      ...CONTRACT,
      properties: {
        ...CONTRACT.properties,
        count: property({ type: "number" }),
        tags: property({ type: "list" }),
        kind: property({ required: true, rules: [{ kind: "fixed", value: "note" }] }),
      },
    },
  };

  it("saves the fixed form, lists each fix on the verdict and records the value as written", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nkind: note\ncount: \"12\"\nstatus: Done\n---\nbody\n", { view: typed });
    const resolution = resolveTiers(note);
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\nkind: note\ncount: 12\nstatus: done\n---\nbody\n", verdict: { ok: true, warnings: [] } });
    expect(resolution.action === "save" && resolution.verdict.fixes).toEqual([{ field: "count", kind: "type" }, { field: "status", kind: "not-allowed" }]);
    expect(resolution.action === "save" && resolution.findings).toEqual([
      { axis: "value", kind: "fixed", chosen: null, wanted: { field: "count", value: "12" }, reason: "fixed: type" },
      { axis: "value", kind: "fixed", chosen: null, wanted: { field: "status", value: "Done" }, reason: "fixed: not-allowed" },
    ]);
  });

  it("fixes what it can and keeps the rest", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nkind: note\ncount: \"12a\"\ntags: solo\n---\n", { view: typed });
    const resolution = resolveTiers(note);
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\nkind: note\ncount: \"12a\"\ntags: [solo]\n---\n" });
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.reason)).toEqual(["fixed: type", "kept: type"]);
  });

  it("fills a required fixed value and a date default on a new note, but no date without a time or on an existing note", () => {
    const dated: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { title: property({ required: true }), created: property({ type: "date", default: true, required: true }), kind: property({ required: true, rules: [{ kind: "fixed", value: "note" }] }) } } };
    const now = new Date(2026, 8, 29, 10, 0, 0);
    const fresh = resolveTiers(input("Inbox/a.md", "---\ntitle: A\n---\n", { view: dated, isNew: true, now }));
    expect(fresh).toMatchObject({ action: "save", content: "---\ntitle: A\ncreated: 2026-09-29\nkind: note\n---\n" });
    expect(fresh.action === "save" && fresh.findings.map(finding => finding.reason)).toEqual(["fixed: missing", "fixed: missing"]);
    const existing = resolveTiers(input("Inbox/a.md", "---\ntitle: A\n---\n", { view: dated, now }));
    expect(existing.action === "save" && existing.findings.map(finding => `${finding.wanted.field} ${finding.reason}`).sort()).toEqual(["created kept: missing", "kind fixed: missing"]);
  });

  it("records a number as written, not as the value it parses to", () => {
    const labelled: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, label: property() } } };
    const resolution = resolveTiers(input("Inbox/a.md", "---\ntitle: A\nlabel: 01234\n---\n", { view: labelled }));
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\nlabel: 01234\n---\n" });
    expect(resolution.action === "save" && resolution.findings).toEqual([
      { axis: "value", kind: "kept", chosen: null, wanted: { field: "label", value: "01234" }, reason: "kept: type" },
    ]);
  });

  it("counts a fix only when the rejudged note no longer reports it, once", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nkind: note\ncount: \"12\"\n---\n", { view: typed });
    // A rejudge that still reports the fixed warning: the fix did not clear it.
    const rejudge = vi.fn((): Verdict => verdictOf([{ field: "count", kind: "type" }]));
    const resolution = resolveTiers({ ...note, rejudge });
    expect(resolution).toMatchObject({ action: "save", content: note.content, verdict: { fixes: [] } });
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.reason)).toEqual(["kept: type"]);
    expect(rejudge).toHaveBeenCalledOnce();
  });

  it("keeps a tagged value as written: one kept finding and no fix", () => {
    const resolution = resolveTiers(input("Inbox/a.md", "---\ntitle: A\nkind: note\ncount: !!str 12\n---\n", { view: typed }));
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\nkind: note\ncount: !!str 12\n---\n", verdict: { fixes: [] } });
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.reason)).toEqual(["kept: type"]);
  });

  it("keeps the note as written when the fixed form is refused", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nkind: note\ncount: \"12\"\n---\n", { view: typed });
    const rejudge = vi.fn((): Verdict => verdictOf([{ field: "path", kind: "path-unsafe" }]));
    expect(resolveTiers({ ...note, rejudge })).toEqual({
      action: "save", content: note.content, verdict: { ...note.verdict, fixes: [] },
      findings: [{ axis: "value", kind: "kept", chosen: null, wanted: { field: "count", value: "12" }, reason: "kept: type" }],
    });
    expect(rejudge).toHaveBeenCalledOnce();
  });
});

describe("refusals and contradictions", () => {
  it("refuses only a verdict that carries a refusal", () => {
    const verdict = verdictOf([{ field: "path", kind: "path-unsafe" }]);
    expect(resolveTiers({ ...input("Inbox/a.md", "x\n"), verdict })).toEqual({ action: "refuse", reason: "refused" });
  });

  it("warns on unparseable frontmatter on the value axis and drafts it, never refusing", () => {
    const broken = input("Inbox/a.md", "---\ntitle: [\n---\n");
    expect(broken.verdict.ok).toBe(true);
    expect(broken.verdict.warnings.map(warning => warning.kind)).toContain("yaml-syntax");
    expect(gapAxisOf("yaml-syntax")).toBe("value");
    const resolution = resolveTiers(broken);
    expect(resolution.action).toBe("draft");
    expect(resolution.action === "draft" && resolution.findings.some(finding => finding.axis === "value" && finding.reason === "drafted: yaml-syntax")).toBe(true);
    const accepted = verdictOf([]);
    expect(resolveTiers({ ...broken, verdict: accepted })).toEqual({ action: "save", content: broken.content, verdict: accepted, findings: [] });
  });

  it("④ never fixes a contradicted field: an allowed list that is empty has no value to fix toward", () => {
    const contradicted: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, count: property({ type: "number", rules: [{ kind: "allowed", values: [] }] }) } } };
    const note = input("Inbox/a.md", "---\ntitle: A\ncount: \"12\"\n---\n", { view: contradicted });
    const resolution = resolveTiers(note);
    expect(resolution).toMatchObject({ action: "save", content: note.content });
    expect(resolution.action === "save" && resolution.findings.every(finding => finding.reason.startsWith("contradiction: "))).toBe(true);
  });

  it("④ saves a write whose warning lies on a contradicted field as written and records the contradiction", () => {
    const contradicted: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, owner: property({ rules: [{ kind: "allowed", values: [] }] }) } } };
    const note = input("Inbox/a.md", "---\ntitle: A\nowner: me\n---\n", { view: contradicted });
    expect(note.verdict).toMatchObject({ ok: true, warnings: [{ field: "owner", kind: "not-allowed" }] });
    expect(resolveTiers(note)).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "value", kind: "kept", chosen: null, wanted: { field: "owner", value: "me" }, reason: "contradiction: not-allowed" }],
    });
  });
});

describe("repair: false", () => {
  it("fixes nothing: a would-be fix is saved as written and recorded as kept", () => {
    const typed: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, count: property({ type: "number" }) } } };
    const note = input("Inbox/a.md", "---\ntitle: A\ncount: \"12\"\n---\n", { view: typed, repair: false });
    expect(resolveTiers(note)).toMatchObject({ action: "save", content: note.content, verdict: note.verdict, findings: [{ kind: "kept", reason: "kept: type" }] });
  });

  it("saves the content as written and records each new warning as kept", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\n---\n", { repair: false });
    const rejudge = vi.fn(note.rejudge);
    expect(resolveTiers({ ...note, rejudge })).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "property", kind: "kept", chosen: null, wanted: { field: "mood", value: "calm" }, reason: "kept: unknown-property" }],
    });
    expect(rejudge).not.toHaveBeenCalled();
  });
});

describe("the warning delta", () => {
  it("records nothing for a warning the previous note already had", () => {
    const previous = "---\ntitle: A\nstatus: bogus\n---\n";
    const note = input("Inbox/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { previousContent: previous });
    const baseline = judgeContent({ path: "Inbox/a.md", content: previous }, SEALED);
    expect(baseline.warnings).toEqual([{ field: "status", kind: "not-allowed" }]);
    expect(note.verdict.warnings).toEqual([{ field: "status", kind: "not-allowed" }]);
    expect(resolveTiers({ ...note, baseline })).toEqual({ action: "save", content: note.content, verdict: note.verdict, findings: [] });
  });

  it("treats every warning as new when there is no readable previous note", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { previousContent: "---\ntitle: A\nstatus: bogus\n---\n" });
    const resolution = resolveTiers(note);
    expect(resolution.action).toBe("save");
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.wanted.field)).toEqual(["status"]);
  });

  it("records only the warnings the baseline lacks", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\nstatus: maybe\n---\n", { repair: false });
    const baseline = verdictOf([{ field: "mood", kind: "unknown-property" }]);
    const resolution = resolveTiers({ ...note, baseline });
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.reason)).toEqual(["kept: not-allowed"]);
  });
});
