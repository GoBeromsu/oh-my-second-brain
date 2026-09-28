import { describe, expect, it, vi } from "vitest";
import { judgeContent } from "../contract/judge-write.js";
import type { ContractView, PropertyContract, TemplateContract, VaultContract, Verdict } from "../contract/types.js";
import { dropFrontmatterKeys, gapAxisOf, resolveAmbiguity, templateChoices, type AmbiguityInput } from "./ambiguity.js";

const HASH = `sha256:${"a".repeat(64)}`;

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

describe("resolveAmbiguity outside a sealed contract", () => {
  it("saves an accepted note and refuses anything else as unsealed", () => {
    const ok = input("a.md", "x\n", { view: { state: "open" } });
    expect(resolveAmbiguity(ok)).toEqual({ action: "save", content: "x\n", verdict: ok.verdict, findings: [] });
    const denied = input("a.md", "x\n", { view: { state: "unreadable" } });
    expect(denied.verdict.ok).toBe(false);
    expect(resolveAmbiguity(denied)).toEqual({ action: "refuse", reason: "unsealed" });
  });
});

describe("① and ② with an accepting verdict", () => {
  it("saves as written with nothing to record", () => {
    const accepted = input("Inbox/a.md", "---\ntitle: A\n---\nbody\n");
    expect(resolveAmbiguity(accepted)).toEqual({ action: "save", content: accepted.content, verdict: accepted.verdict, findings: [] });
  });

  it("records a template choice when several templates apply and none was selected", () => {
    const note = input("Meetings/a.md", "---\ntitle: A\nstatus: open\n---\n");
    expect(resolveAmbiguity(note)).toEqual({
      action: "save", content: note.content, verdict: note.verdict,
      findings: [{ axis: "template", kind: "choice", chosen: "Review", wanted: { field: "template" }, reason: "2 templates apply to the folder and none was selected" }],
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
    const resolution = resolveAmbiguity(note);
    expect(resolution).toMatchObject({ action: "save", content: "---\ntitle: A\n---\nbody\n", verdict: { ok: true } });
    expect(resolution.action === "save" && resolution.findings).toEqual([
      { axis: "property", kind: "no-fit", chosen: null, wanted: { field: "mood", value: "calm" }, reason: "dropped: unknown-property" },
      { axis: "value", kind: "no-fit", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "dropped: not-allowed" },
      { axis: "value", kind: "no-fit", chosen: null, wanted: { field: "tags", value: ["a", "b", "c"] }, reason: "dropped: count" },
    ]);
  });

  it("records a non-scalar want by field only", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nowner:\n  name: me\nmood: [{x: 1}]\n---\n");
    const resolution = resolveAmbiguity(note);
    expect(resolution.action === "save" && resolution.findings.map(finding => finding.wanted)).toEqual([{ field: "mood" }, { field: "owner" }]);
  });

  it("keeps the note as a draft when a key it already had is the problem", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { previousContent: "---\ntitle: A\nstatus: open\n---\n" });
    expect(resolveAmbiguity(note)).toEqual({
      action: "draft",
      findings: [{ axis: "value", kind: "no-fit", chosen: null, wanted: { field: "status", value: "maybe" }, reason: "drafted: not-allowed" }],
    });
  });

  it("keeps the note as a draft when the key is required by the property or the selected template", () => {
    const required: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, title: property({ required: true, rules: [{ kind: "pattern", regex: "[A-Z]" }] }) } } };
    expect(resolveAmbiguity(input("Inbox/a.md", "---\ntitle: lower\n---\n", { view: required }))).toMatchObject({ action: "draft", findings: [{ wanted: { field: "title" } }] });
    const byTemplate = input("Meetings/a.md", "---\ntitle: A\nstatus: maybe\n---\n", { template: "Review" });
    expect(resolveAmbiguity(byTemplate)).toMatchObject({ action: "draft", findings: [{ axis: "value", wanted: { field: "status" } }] });
  });

  it("keeps the note as a draft for a violation dropping a key cannot clear", () => {
    expect(resolveAmbiguity(input("Inbox/a.md", "body\n"))).toEqual({
      action: "draft",
      findings: [{ axis: "property", kind: "no-fit", chosen: null, wanted: { field: "title" }, reason: "drafted: missing" }],
    });
    expect(resolveAmbiguity(input("Elsewhere/a.md", "---\ntitle: A\n---\n"))).toMatchObject({ action: "draft", findings: [{ axis: "folder", reason: "drafted: unregistered-folder" }] });
  });

  it("keeps the note as a draft when the judge still refuses the repaired form, and never skips the second judgment", () => {
    const note = input("Inbox/a.md", "---\ntitle: A\nmood: calm\n---\n");
    const rejudge = vi.fn((): Verdict => ({ ok: false, violations: [{ field: "title", kind: "missing" }], missingDefaults: [] }));
    expect(resolveAmbiguity({ ...note, rejudge })).toMatchObject({ action: "draft", findings: [{ wanted: { field: "mood" }, reason: "drafted: unknown-property" }] });
    expect(rejudge).toHaveBeenCalledWith("---\ntitle: A\n---\n");
  });
});

describe("refusals", () => {
  it("refuses a violation that is not a gap in the frame", () => {
    const verdict: Verdict = { ok: false, violations: [{ field: "path", kind: "path-unsafe" }], missingDefaults: [] };
    expect(resolveAmbiguity({ ...input("Inbox/a.md", "x\n"), verdict })).toEqual({ action: "refuse", reason: "not-a-gap" });
  });

  it("refuses unparseable frontmatter unless the judge accepted it", () => {
    const broken = input("Inbox/a.md", "---\ntitle: [\n---\n");
    expect(broken.verdict.ok).toBe(false);
    expect(resolveAmbiguity(broken)).toEqual({ action: "refuse", reason: "not-a-gap" });
    const accepted: Verdict = { ok: true, violations: [], missingDefaults: [] };
    expect(resolveAmbiguity({ ...broken, verdict: accepted })).toEqual({ action: "save", content: broken.content, verdict: accepted, findings: [] });
  });

  it("④ refuses a write whose violation lies on a contradicted field and records nothing", () => {
    const contradicted: ContractView = { state: "sealed", contract: { ...CONTRACT, properties: { ...CONTRACT.properties, owner: property({ rules: [{ kind: "allowed", values: [] }] }) } } };
    const note = input("Inbox/a.md", "---\ntitle: A\nowner: me\n---\n", { view: contradicted });
    expect(note.verdict.ok).toBe(false);
    expect(resolveAmbiguity(note)).toEqual({ action: "refuse", reason: "contradiction" });
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
