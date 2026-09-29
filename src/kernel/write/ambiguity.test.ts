import { describe, expect, it, vi } from "vitest";
import { judgeContent } from "../contract/judge-write.js";
import { verdictOf, type ContractView, type PropertyContract, type TemplateContract, type VaultContract, type Verdict } from "../contract/types.js";
import { dropFrontmatterKeys, gapAxisOf, resolveTiers, templateChoices, type AmbiguityInput } from "./ambiguity.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function property(extra: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "", type: "text", default: false, required: false, rules: [], ...extra };
}

function template(extra: Partial<TemplateContract> = {}): TemplateContract {
  return { source: "Templates/T.md", sourceHash: HASH, requiredProperties: [], narrowedRules: {}, requiredHeadings: [], ...extra };
}

const CONTRACT: VaultContract = {
  folders: { Inbox: { meaning: "", searchExclude: false }, Meetings: { meaning: "", searchExclude: false } },
  properties: {
    status: property({ rules: [{ kind: "allowed", values: ["open", "done"] }] }),
    title: property({ required: true }),
    owner: property(),
    tags: property({ type: "list", rules: [{ kind: "count", max: 2 }] }),
  },
  templates: {
    Standup: template({ applyFolder: "Meetings", requiredProperties: ["owner"] }),
    Review: template({ applyFolder: "Meetings", requiredProperties: ["status"] }),
    Solo: template({ applyFolder: "Inbox" }),
  },
};

const SEALED: ContractView = { state: "sealed", contract: CONTRACT };

function input(path: string, content: string, extra: Partial<AmbiguityInput> = {}): AmbiguityInput {
  const view = extra.view ?? SEALED;
  const judgeWith = (text: string): Verdict => judgeContent({
    path, content: text,
    ...(extra.template === undefined ? {} : { selectedTemplate: extra.template }),
    ...(extra.previousContent === undefined ? {} : { previousContent: extra.previousContent }),
  }, view);
  return { view, path, content, verdict: judgeWith(content), rejudge: judgeWith, ...extra };
}

describe("gapAxisOf", () => {
  it("maps frame violations to an axis and everything else to null", () => {
    expect(gapAxisOf("unregistered-folder")).toBe("folder");
    expect(gapAxisOf("unknown-property")).toBe("property");
    expect(gapAxisOf("count")).toBe("value");
    expect(gapAxisOf("heading-missing")).toBe("template");
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

  it("records a template choice when several templates apply and none was selected", () => {
    const note = input("Meetings/a.md", "---\ntitle: A\nstatus: open\n---\n");
    expect(resolveTiers(note)).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "template", kind: "choice", chosen: "Review", wanted: { field: "template", value: ["Review", "Standup"] }, reason: "2 templates apply to the folder and none was selected" }],
    });
  });

  it("recommends nothing when no candidate fits and records no choice once one is selected or only one applies", () => {
    expect(templateChoices(CONTRACT, "Meetings/a.md", undefined, { title: "A" })).toMatchObject([{ chosen: null }]);
    expect(templateChoices(CONTRACT, "Meetings/a.md", undefined, { title: "A", owner: "me", status: "open" })).toMatchObject([{ chosen: "Review" }]);
    expect(templateChoices(CONTRACT, "Meetings/a.md", "Standup", {})).toEqual([]);
    expect(templateChoices(CONTRACT, "Inbox/a.md", undefined, {})).toEqual([]);
    expect(templateChoices({ ...CONTRACT, templates: { Loose: template() } }, "Inbox/a.md", undefined, {})).toEqual([]);
  });
});

describe("③ gaps", () => {
  it("drops keys this write added that the frame has no place for, saves the repaired form and records each want", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\nstatus: maybe\ntags: [a, b, c]\n---\nbody\n");
    const resolution = resolveTiers(note);
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\n---\nbody\n", verdict: { ok: true } });
    expect(resolution.action === "save" && resolution.findings).toEqual([
      { axis: "property", kind: "no-fit", chosen: null, wanted: { field: "mood", value: "calm" }, reason: "dropped: unknown-property" },
      { axis: "value", kind: "no-fit", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "dropped: not-allowed" },
      { axis: "value", kind: "no-fit", chosen: null, wanted: { field: "tags", value: ["a", "b", "c"] }, reason: "dropped: count" },
    ]);
  });

  it("records a non-scalar want by field only", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nowner:\n  name: me\nmood: [{x: 1}]\n---\n");
    const resolution = resolveTiers(note);
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.wanted)).toEqual([{ field: "mood" }, { field: "owner" }]);
  });

  it("keeps the note as a draft when a key it already had is the problem", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { previousContent: "---\ntitle: A\nstatus: open\n---\n" });
    expect(resolveTiers(note)).toEqual({
      action: "draft",
      findings: [{ axis: "value", kind: "no-fit", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "drafted: not-allowed" }],
      asWritten: [{ axis: "value", kind: "no-fit", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "kept: not-allowed" }],
    });
  });

  it("keeps the note as a draft when the key is required by the property or the selected template", () => {
    const required: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, title: property({ required: true, rules: [{ kind: "pattern", regex: "[A-Z]" }] }) } } };
    expect(resolveTiers(input("Inbox/a.md", "---\ntitle: lower\n---\n", { view: required }))).toMatchObject({ action: "draft", findings: [{ wanted: { field: "title" } }] });
    const byTemplate = input("Meetings/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { template: "Review" });
    expect(resolveTiers(byTemplate)).toMatchObject({ action: "draft", findings: [{ axis: "value", wanted: { field: "status" } }] });
  });

  it("keeps the note as a draft for a violation dropping a key cannot clear", () => {
    expect(resolveTiers(input("Inbox/a.md", "body\n"))).toEqual({
      action: "draft",
      findings: [{ axis: "property", kind: "no-fit", chosen: null, wanted: { field: "title" }, reason: "drafted: missing" }],
      asWritten: [{ axis: "property", kind: "no-fit", chosen: null, wanted: { field: "title" }, reason: "kept: missing" }],
    });
    expect(resolveTiers(input("Elsewhere/a.md", "---\ntitle: A\n---\n"))).toMatchObject({ action: "draft", findings: [{ axis: "folder", reason: "drafted: unregistered-folder" }] });
  });

  it("keeps the note as a draft when the judge still refuses the repaired form, and never skips the second judgment", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\n---\n");
    const rejudge = vi.fn((): Verdict => verdictOf([{ field: "title", kind: "missing" }]));
    expect(resolveTiers({ ...note, rejudge })).toMatchObject({ action: "draft", findings: [{ wanted: { field: "mood" }, reason: "drafted: unknown-property" }] });
    expect(rejudge).toHaveBeenCalledWith("---\ntitle: A\n---\n");
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

  it("④ saves a write whose warning lies on a contradicted field as written and records the contradiction", () => {
    const contradicted: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, owner: property({ rules: [{ kind: "allowed", values: [] }] }) } } };
    const note = input("Inbox/a.md", "---\ntitle: A\nowner: me\n---\n", { view: contradicted });
    expect(note.verdict).toMatchObject({ ok: true, warnings: [{ field: "owner", kind: "not-allowed" }] });
    expect(resolveTiers(note)).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "value", kind: "no-fit", chosen: null, wanted: { field: "owner", value: "me" }, reason: "contradiction: not-allowed" }],
    });
  });
});

describe("repair: false", () => {
  it("saves the content as written and records each new warning as kept", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\n---\n", { repair: false });
    const rejudge = vi.fn(note.rejudge);
    expect(resolveTiers({ ...note, rejudge })).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "property", kind: "no-fit", chosen: null, wanted: { field: "mood", value: "calm" }, reason: "kept: unknown-property" }],
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
    expect(resolution.action).toBe("draft");
    expect(resolution.action === "draft" && resolution.findings.map(finding => finding.wanted.field)).toEqual(["status"]);
  });

  it("records only the warnings the baseline lacks", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\nstatus: maybe\n---\n", { repair: false });
    const baseline = verdictOf([{ field: "mood", kind: "unknown-property" }]);
    const resolution = resolveTiers({ ...note, baseline });
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.reason)).toEqual(["kept: not-allowed"]);
  });
});

describe("dropFrontmatterKeys", () => {
  it("removes only the named keys and keeps the body and the other keys", () => {
    expect(dropFrontmatterKeys("---\na: 1\nb: 2\n---\nbody\n", ["b"])).toBe("---\na: 1\n---\nbody\n");
    expect(dropFrontmatterKeys("---\na: 1\n---\nbody\n", ["missing"])).toBe("---\na: 1\n---\nbody\n");
  });

  it("drops the whole block when no key is left", () => {
    expect(dropFrontmatterKeys("---\na: 1\n---\nbody\n", ["a"])).toBe("body\n");
  });

  it("returns null without frontmatter, with unparseable frontmatter, or with a non-map block", () => {
    expect(dropFrontmatterKeys("body\n", ["a"])).toBeNull();
    expect(dropFrontmatterKeys("---\na: [\n---\n", ["a"])).toBeNull();
    expect(dropFrontmatterKeys("---\n- a\n---\n", ["a"])).toBeNull();
  });
});
