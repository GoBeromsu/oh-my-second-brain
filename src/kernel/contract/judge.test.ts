import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettings } from "../../../test/fixtures/contract-truth-table.js";
import { extractTemplate } from "./extract.js";
import { insideApplyFolder, judge, PATTERN_VALUE_LIMIT } from "./judge.js";
import { judgeContent, judgeWrite } from "./judge-write.js";
import { sealContract, storeRoot } from "./store.js";
import {
  formatDenyReason, GUIDANCE, GUIDANCE_FOR, VIOLATION_KINDS,
  type ContractView, type PropertyContract, type VaultContract,
} from "./types.js";

const SECRET = "SECRET-42";

function property(overrides: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "a property", type: "text", default: false, required: false, rules: [], ...overrides };
}

function sealed(contract: Partial<VaultContract>): ContractView {
  return { state: "sealed", contract: { folders: null, properties: null, templates: {}, ...contract } };
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(path);
  return path;
}

describe("GUIDANCE totality", () => {
  it("maps every violation kind to exactly one allowed guidance", () => {
    expect(Object.keys(GUIDANCE_FOR).sort()).toEqual([...VIOLATION_KINDS].sort());
    expect(new Set(VIOLATION_KINDS).size).toBe(VIOLATION_KINDS.length);
    for (const kind of VIOLATION_KINDS) expect(GUIDANCE).toContain(GUIDANCE_FOR[kind]);
  });

  it("formats a deny reason with the first violation's guidance", () => {
    expect(formatDenyReason([{ field: "contract", kind: "contract-unreadable" }, { field: "x", kind: "missing" }]))
      .toBe('[oms] write denied: [{"field":"contract","kind":"contract-unreadable"},{"field":"x","kind":"missing"}] Run: oms contract doctor');
    expect(formatDenyReason([])).toBe("[oms] write denied: [] Run: oms status");
  });
});

describe("base path rules", () => {
  it("denies control paths and unsafe paths even when nothing is sealed", () => {
    const open: ContractView = { state: "open" };
    expect(judge({ path: ".oms/settings.json", frontmatter: {}, body: "" }, open).violations).toEqual([{ field: "path", kind: "control-path" }]);
    expect(judge({ path: "../escape.md", frontmatter: {}, body: "" }, open).violations).toEqual([{ field: "path", kind: "path-unsafe" }]);
  });

  it("passes anything when the vault is open", () => {
    expect(judge({ path: "a.md", frontmatter: { anything: 1 }, body: "{{x}}" }, { state: "open" })).toEqual({ ok: true, violations: [], missingDefaults: [] });
  });

  it("reports malformed frontmatter as yaml-syntax", () => {
    const verdict = judgeContent({ path: "a.md", content: "---\nkey: [unclosed\n---\n" }, { state: "open" });
    expect(verdict.violations).toEqual([{ field: "content", kind: "yaml-syntax" }]);
  });
});

describe("AC2: extraction is deterministic", () => {
  it("returns identical results for the same source", async () => {
    const vault = await temp("oms-judge-extract-");
    await mkdir(join(vault, "Templates"));
    await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\ncreated: \"{{date}}\"\ntags: [meeting]\n---\n## Agenda\n## {{title}}\n");
    const first = await extractTemplate(vault, "Templates/Meeting.md");
    const second = await extractTemplate(vault, "Templates/Meeting.md");
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });
});

describe("AC6: required and default properties", () => {
  const view = sealed({
    properties: {
      status: property({ required: true }),
      owner: property({ default: true }),
      note: property(),
    },
  });

  it("denies a missing or empty required property", () => {
    expect(judge({ path: "a.md", frontmatter: {}, body: "" }, view).violations).toEqual([{ field: "status", kind: "missing" }]);
    expect(judge({ path: "a.md", frontmatter: { status: "  " }, body: "" }, view).violations).toEqual([{ field: "status", kind: "missing" }]);
  });

  it("passes a missing default property and reports it", () => {
    const verdict = judge({ path: "a.md", frontmatter: { status: "x" }, body: "" }, view);
    expect(verdict).toEqual({ ok: true, violations: [], missingDefaults: ["owner"] });
  });
});

describe("AC7: no value, rule or template name leaves the judge", () => {
  it("keeps secrets out of violations and the deny reason", () => {
    const view = sealed({
      properties: {
        code: property({ rules: [{ kind: "fixed", value: SECRET }] }),
        level: property({ rules: [{ kind: "allowed", values: [SECRET, "other"] }] }),
        id: property({ rules: [{ kind: "pattern", regex: `${SECRET}-\\d+` }] }),
      },
      templates: {
        [SECRET]: { source: "T.md", sourceHash: `sha256:${"0".repeat(64)}`, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] },
      },
    });
    const verdict = judge({ path: "a.md", frontmatter: { code: "wrong", level: "bad", id: "nope" }, body: "", selectedTemplate: "missing" }, view);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      { field: "code", kind: "not-fixed" },
      { field: "id", kind: "pattern" },
      { field: "level", kind: "not-allowed" },
      { field: "template", kind: "template-mismatch" },
    ]);
    const output = `${JSON.stringify(verdict)}\n${formatDenyReason(verdict.violations)}`;
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("wrong");
  });
});

describe("value rules", () => {
  const view = sealed({
    properties: {
      count: property({ type: "number", rules: [{ kind: "range", min: 1, max: 5 }] }),
      when: property({ type: "date" }),
    },
  });

  it("checks type before rules", () => {
    expect(judge({ path: "a.md", frontmatter: { count: "3" }, body: "" }, view).violations).toEqual([{ field: "count", kind: "type" }]);
    expect(judge({ path: "a.md", frontmatter: { count: 9 }, body: "" }, view).violations).toEqual([{ field: "count", kind: "range" }]);
    expect(judge({ path: "a.md", frontmatter: { when: "2026-02-30" }, body: "" }, view).violations).toEqual([{ field: "when", kind: "type" }]);
    expect(judge({ path: "a.md", frontmatter: { count: 3, when: "2026-02-28" }, body: "" }, view).ok).toBe(true);
  });
});

describe("AC16: an unreadable contract denies every write", () => {
  it("denies against an unreadable view", () => {
    expect(judge({ path: "Projects/a.md", frontmatter: {}, body: "" }, { state: "unreadable" }).violations)
      .toEqual([{ field: "contract", kind: "contract-unreadable" }]);
  });

  describe("judgeWrite against a tampered store", () => {
    let home: string;
    let previousHome: string | undefined;

    beforeEach(async () => {
      home = await temp("oms-judge-home-");
      previousHome = process.env["HOME"];
      process.env["HOME"] = home;
    });

    afterEach(() => {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    });

    it("passes a sealed write and denies once a store file is altered", async () => {
      expect(storeRoot().startsWith(home)).toBe(true);
      const vault = await temp("oms-judge-vault-");
      const vaultId = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
      await writeSettings(vault, vaultId);
      await mkdir(join(vault, "Projects"));
      await sealContract({ vaultRealPath: vault, vaultId, contract: { folders: { Projects: { meaning: "p", searchExclude: false } }, properties: null, templates: {} } });

      expect((await judgeWrite(vault, "Projects/a.md", "# ok\n")).ok).toBe(true);
      expect((await judgeWrite(vault, "Inbox/a.md", "# ok\n")).violations).toEqual([{ field: "path", kind: "unregistered-folder" }]);

      const generation = (await readdir(storeRoot())).find(entry => entry.startsWith(`.${vaultId}.`))!;
      await writeFile(join(storeRoot(), generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
      expect((await judgeWrite(vault, "Projects/a.md", "# ok\n")).violations).toEqual([{ field: "contract", kind: "contract-unreadable" }]);
    });

    it("denies a target outside the vault", async () => {
      const vault = await temp("oms-judge-vault-");
      const outside = await temp("oms-judge-outside-");
      await mkdir(dirname(join(outside, "x.md")), { recursive: true });
      expect((await judgeWrite(vault, join(outside, "x.md"), "x")).violations).toEqual([{ field: "path", kind: "outside-vault" }]);
    });
  });
});

describe("AC18: folder-mismatch for an explicit template", () => {
  const view = sealed({
    templates: {
      Meeting: { source: "Templates/Meeting.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Meetings", requiredProperties: [], narrowedRules: {}, requiredHeadings: [] },
    },
  });

  it("inherits into subfolders", () => {
    expect(insideApplyFolder("Meetings/2026/a.md", "Meetings")).toBe(true);
    expect(insideApplyFolder("MeetingsX/a.md", "Meetings")).toBe(false);
    expect(judge({ path: "Meetings/2026/a.md", frontmatter: {}, body: "", selectedTemplate: "Meeting" }, view).ok).toBe(true);
  });

  it("denies a note outside the apply folder", () => {
    expect(judge({ path: "Notes/a.md", frontmatter: {}, body: "", selectedTemplate: "Meeting" }, view).violations)
      .toEqual([{ field: "path", kind: "folder-mismatch" }]);
  });
});

describe("AC19: registered folders and properties", () => {
  const view = sealed({
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: { status: property() },
  });

  it("denies an unregistered folder, including the vault root", () => {
    expect(judge({ path: "Inbox/a.md", frontmatter: {}, body: "" }, view).violations).toEqual([{ field: "path", kind: "unregistered-folder" }]);
    expect(judge({ path: "a.md", frontmatter: {}, body: "" }, view).violations).toEqual([{ field: "path", kind: "unregistered-folder" }]);
    expect(judge({ path: "Projects/deep/a.md", frontmatter: {}, body: "" }, view).ok).toBe(true);
  });

  it("denies an unknown property", () => {
    expect(judge({ path: "Projects/a.md", frontmatter: { status: "x", extra: 1 }, body: "" }, view).violations)
      .toEqual([{ field: "extra", kind: "unknown-property" }]);
  });

  it("leaves null axes open", () => {
    expect(judge({ path: "anywhere/a.md", frontmatter: { whatever: 1 }, body: "" }, sealed({})).ok).toBe(true);
  });
});

describe("edits judge only what they change", () => {
  const view = sealed({
    properties: {
      status: property({ required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] }),
      owner: property(),
    },
  });
  const legacy = "---\nlegacy: kept\nowner: me\n---\nold body\n";

  it("allows a body-only edit of a legacy note with an unregistered key and a missing required key", () => {
    const verdict = judgeContent({ path: "a.md", content: "---\nlegacy: kept\nowner: me\n---\nnew body\n", previousContent: legacy }, view);
    expect(verdict).toEqual({ ok: true, violations: [], missingDefaults: [] });
  });

  it("denies an edit that adds an unknown key", () => {
    const verdict = judgeContent({ path: "a.md", content: "---\nlegacy: kept\nowner: me\nextra: 1\n---\nold body\n", previousContent: legacy }, view);
    expect(verdict.violations).toEqual([{ field: "extra", kind: "unknown-property" }]);
  });

  it("denies an edit that removes or empties a required key", () => {
    const previous = "---\nstatus: open\n---\nbody\n";
    expect(judgeContent({ path: "a.md", content: "---\nowner: me\n---\nbody\n", previousContent: previous }, view).violations)
      .toEqual([{ field: "status", kind: "missing" }]);
    expect(judgeContent({ path: "a.md", content: "---\nstatus: \"\"\n---\nbody\n", previousContent: previous }, view).violations)
      .toEqual([{ field: "status", kind: "missing" }]);
  });

  it("denies changing a value to an invalid one but keeps an unchanged legacy value", () => {
    const previous = "---\nstatus: stale\n---\nbody\n";
    expect(judgeContent({ path: "a.md", content: "---\nstatus: stale\n---\nedited\n", previousContent: previous }, view).ok).toBe(true);
    expect(judgeContent({ path: "a.md", content: "---\nstatus: wrong\n---\nbody\n", previousContent: "---\nstatus: open\n---\nbody\n" }, view).violations)
      .toEqual([{ field: "status", kind: "not-allowed" }]);
  });

  it("still judges a new note in full", () => {
    const verdict = judgeContent({ path: "a.md", content: "---\nlegacy: kept\n---\nbody\n" }, view);
    expect(verdict.violations).toEqual([{ field: "legacy", kind: "unknown-property" }, { field: "status", kind: "missing" }]);
  });
});

describe("pattern values are capped", () => {
  it("fails an over-long value without running the pattern", () => {
    const view = sealed({ properties: { id: property({ rules: [{ kind: "pattern", regex: "(a+)+b" }] }) } });
    const long = "a".repeat(PATTERN_VALUE_LIMIT + 1);
    const started = Date.now();
    expect(judge({ path: "a.md", frontmatter: { id: long }, body: "" }, view).violations).toEqual([{ field: "id", kind: "pattern" }]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
