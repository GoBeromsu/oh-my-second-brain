import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettings } from "../../../test/fixtures/contract-truth-table.js";
import { insideApplyFolder, judge, PATTERN_VALUE_LIMIT } from "./judge.js";
import type { TemplatedContract } from "./legacy.js";
import { decideWrite, judgeContent, judgeReadyTarget, judgeWrite, type WriteTarget } from "./judge-write.js";
import { PATTERN_SOURCE_LIMIT } from "./pattern.js";
import { sealContract, storeRoot } from "./store.js";
import {
  findingsOf, formatDenyReason, formatWarnings, GUIDANCE, GUIDANCE_FOR, SEVERITY_OF, verdictOf, VIOLATION_KINDS, WARNING_PREFIX,
  type ContractView, type PropertyContract,
} from "./types.js";

const SECRET = "SECRET-42";

function property(overrides: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "a property", type: "text", default: false, required: false, rules: [], ...overrides };
}

/** A sealed view; any templates ride along as the legacy projection of an older generation. */
function sealed({ templates, ...contract }: Partial<TemplatedContract>): ContractView {
  const view: ContractView = { state: "sealed", contract: { folders: null, properties: null, ...contract } };
  return templates === undefined ? view : { ...view, legacy: { templates } };
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

  it("formats a deny reason with the first refusal's guidance", () => {
    expect(formatDenyReason([{ field: "contract", kind: "contract-tampered" }, { field: "path", kind: "path-unsafe" }]))
      .toBe('[oms] write denied: [{"field":"contract","kind":"contract-tampered"},{"field":"path","kind":"path-unsafe"}] Run: oms doctor contract');
    expect(formatDenyReason([])).toBe("[oms] write denied: [] Run: oms doctor status");
  });

  it("formats warnings with the warning prefix and the first warning's guidance", () => {
    expect(WARNING_PREFIX).toBe("[oms] write allowed with warnings: ");
    expect(formatWarnings([{ field: "contract", kind: "contract-unreadable" }, { field: "x", kind: "missing" }]))
      .toBe('[oms] write allowed with warnings: [{"field":"contract","kind":"contract-unreadable"},{"field":"x","kind":"missing"}] Run: oms interview');
    expect(formatWarnings([{ field: "x", kind: "missing" }]).startsWith(WARNING_PREFIX)).toBe(true);
    expect(formatWarnings([])).toBe("[oms] write allowed with warnings: [] Run: oms doctor status");
  });
});

describe("SEVERITY_OF", () => {
  it("gives every kind exactly one severity", () => {
    expect(Object.keys(SEVERITY_OF).sort()).toEqual([...VIOLATION_KINDS].sort());
  });

  it("refuses only safety kinds and warns on every axis", () => {
    const refused = VIOLATION_KINDS.filter(kind => SEVERITY_OF[kind] === "refuse").sort();
    expect(refused).toEqual(["contract-tampered", "control-path", "outside-vault", "path-unsafe", "unsupported-input"]);
    for (const kind of VIOLATION_KINDS) if (!refused.includes(kind)) expect(SEVERITY_OF[kind]).toBe("warn");
  });

  it("splits findings into refusals and warnings, with violations as the refusals", () => {
    const verdict = verdictOf([{ field: "x", kind: "missing" }, { field: "path", kind: "path-unsafe" }], ["owner"]);
    expect(verdict).toEqual({
      ok: false,
      refusals: [{ field: "path", kind: "path-unsafe" }],
      warnings: [{ field: "x", kind: "missing" }],
      fixes: [],
      missingDefaults: ["owner"],
      violations: [{ field: "path", kind: "path-unsafe" }],
    });
    expect(findingsOf(verdict)).toEqual([{ field: "path", kind: "path-unsafe" }, { field: "x", kind: "missing" }]);
    expect(verdictOf([{ field: "x", kind: "missing" }]).ok).toBe(true);
  });
});

describe("base path rules", () => {
  it("denies control paths and unsafe paths even when nothing is sealed", () => {
    const open: ContractView = { state: "open" };
    expect(judge({ path: ".oms/settings.json", frontmatter: {}, body: "" }, open).violations).toEqual([{ field: "path", kind: "control-path" }]);
    expect(judge({ path: "../escape.md", frontmatter: {}, body: "" }, open).violations).toEqual([{ field: "path", kind: "path-unsafe" }]);
  });

  it("passes anything when the vault is open, with one contract-open warning", () => {
    expect(judge({ path: "a.md", frontmatter: { anything: 1 }, body: "{{x}}" }, { state: "open" })).toEqual({
      ok: true, refusals: [], warnings: [{ field: "contract", kind: "contract-open" }], fixes: [], missingDefaults: [], violations: [],
    });
  });

  it("reports malformed frontmatter as a yaml-syntax warning", () => {
    const verdict = judgeContent({ path: "a.md", content: "---\nkey: [unclosed\n---\n" }, { state: "open" });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual([{ field: "contract", kind: "contract-open" }, { field: "content", kind: "yaml-syntax" }]);
    const sealedVerdict = judgeContent({ path: "a.md", content: "---\nkey: [unclosed\n---\n" }, sealed({}));
    expect(sealedVerdict.warnings).toEqual([{ field: "content", kind: "yaml-syntax" }]);
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

  it("warns on a missing or empty required property", () => {
    expect(judge({ path: "a.md", frontmatter: {}, body: "" }, view).warnings).toEqual([{ field: "status", kind: "missing" }]);
    expect(judge({ path: "a.md", frontmatter: { status: "  " }, body: "" }, view).warnings).toEqual([{ field: "status", kind: "missing" }]);
  });

  it("passes a missing default property and reports it", () => {
    const verdict = judge({ path: "a.md", frontmatter: { status: "x" }, body: "" }, view);
    expect(verdict).toEqual({ ok: true, refusals: [], warnings: [], fixes: [], missingDefaults: ["owner"], violations: [] });
  });
});

describe("AC7: no value, rule or template name leaves the judge", () => {
  it("keeps secrets out of warnings and the warning line", () => {
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
    const verdict = judge({ path: "a.md", frontmatter: { code: "wrong", level: "bad", id: "nope" }, body: "" }, view);
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual([
      { field: "code", kind: "not-fixed" },
      { field: "id", kind: "pattern" },
      { field: "level", kind: "not-allowed" },
    ]);
    const output = `${JSON.stringify(verdict)}\n${formatWarnings(verdict.warnings)}`;
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
    expect(judge({ path: "a.md", frontmatter: { count: "3" }, body: "" }, view).warnings).toEqual([{ field: "count", kind: "type" }]);
    expect(judge({ path: "a.md", frontmatter: { count: 9 }, body: "" }, view).warnings).toEqual([{ field: "count", kind: "range" }]);
    expect(judge({ path: "a.md", frontmatter: { when: "2026-02-30" }, body: "" }, view).warnings).toEqual([{ field: "when", kind: "type" }]);
    expect(judge({ path: "a.md", frontmatter: { count: 3, when: "2026-02-28" }, body: "" }, view).warnings).toEqual([]);
  });
});

describe("count rule", () => {
  const view = sealed({
    properties: {
      tags: property({ type: "list", rules: [{ kind: "count", min: 1, max: 2 }] }),
      atLeast: property({ type: "list", rules: [{ kind: "count", min: 2 }] }),
      atMost: property({ type: "list", rules: [{ kind: "count", max: 1 }] }),
      one: property({ rules: [{ kind: "count", max: 1 }] }),
      none: property({ rules: [{ kind: "count", max: 0 }] }),
    },
  });
  const verdict = (frontmatter: Record<string, unknown>) => judge({ path: "a.md", frontmatter, body: "" }, view);

  it("counts the items of a list against min and max", () => {
    expect(verdict({ tags: ["a"] }).warnings).toEqual([]);
    expect(verdict({ tags: ["a", "b"] }).warnings).toEqual([]);
    expect(verdict({ tags: ["a", "b", "c"] }).warnings).toEqual([{ field: "tags", kind: "count" }]);
  });

  it("applies a min-only or max-only bound", () => {
    expect(verdict({ atLeast: ["a", "b", "c", "d"] }).warnings).toEqual([]);
    expect(verdict({ atLeast: ["a"] }).warnings).toEqual([{ field: "atLeast", kind: "count" }]);
    expect(verdict({ atMost: [] }).warnings).toEqual([]);
    expect(verdict({ atMost: ["a", "b"] }).warnings).toEqual([{ field: "atMost", kind: "count" }]);
  });

  it("counts a scalar as one member and leaves an absent or empty value to the required check", () => {
    expect(verdict({ one: "x" }).warnings).toEqual([]);
    expect(verdict({ none: "x" }).warnings).toEqual([{ field: "none", kind: "count" }]);
    expect(verdict({}).warnings).toEqual([]);
    expect(verdict({ tags: [] }).warnings).toEqual([]);
    const required = sealed({ properties: { tags: property({ type: "list", required: true, rules: [{ kind: "count", min: 1 }] }) } });
    expect(judge({ path: "a.md", frontmatter: { tags: [] }, body: "" }, required).warnings).toEqual([{ field: "tags", kind: "missing" }]);
  });
});

describe("AC16: an unreadable contract refuses only when tampered", () => {
  it("warns against a broken view and refuses against a tampered one", () => {
    const broken = judge({ path: "Projects/a.md", frontmatter: { anything: 1 }, body: "" }, { state: "unreadable", reason: "broken" });
    expect(broken.ok).toBe(true);
    expect(broken.warnings).toEqual([{ field: "contract", kind: "contract-unreadable" }]);
    const tampered = judge({ path: "Projects/a.md", frontmatter: {}, body: "" }, { state: "unreadable", reason: "tampered" });
    expect(tampered.ok).toBe(false);
    expect(tampered.refusals).toEqual([{ field: "contract", kind: "contract-tampered" }]);
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

    it("passes a sealed write and warns once a store file is altered", async () => {
      expect(storeRoot().startsWith(home)).toBe(true);
      const vault = await temp("oms-judge-vault-");
      const vaultId = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
      await writeSettings(vault, vaultId);
      await mkdir(join(vault, "Projects"));
      await sealContract({ vaultRealPath: vault, vaultId, contract: { folders: { Projects: { meaning: "p", searchExclude: false } }, properties: null } });

      expect((await judgeWrite(vault, "Projects/a.md", "# ok\n")).ok).toBe(true);
      expect((await judgeWrite(vault, "Inbox/a.md", "# ok\n")).warnings).toEqual([{ field: "path", kind: "unregistered-folder" }]);

      const generation = (await readdir(storeRoot())).find(entry => new RegExp(`^\\.${vaultId}\\.(\\d{1,9})$`).test(entry))!;
      await writeFile(join(storeRoot(), generation, "folders.json"), "{\"version\":1,\"folders\":{}}\n");
      expect((await judgeWrite(vault, "Projects/a.md", "# ok\n")).warnings).toEqual([{ field: "contract", kind: "contract-unreadable" }]);
    });

    it("denies a target outside the vault", async () => {
      const vault = await temp("oms-judge-vault-");
      const outside = await temp("oms-judge-outside-");
      await mkdir(dirname(join(outside, "x.md")), { recursive: true });
      expect((await judgeWrite(vault, join(outside, "x.md"), "x")).violations).toEqual([{ field: "path", kind: "outside-vault" }]);
    });
  });
});

describe("apply folders", () => {
  it("inherits into subfolders", () => {
    expect(insideApplyFolder("Meetings/2026/a.md", "Meetings")).toBe(true);
    expect(insideApplyFolder("MeetingsX/a.md", "Meetings")).toBe(false);
  });
});

describe("AC19: registered folders and properties", () => {
  const view = sealed({
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: { status: property() },
  });

  it("warns on an unregistered folder, including the vault root", () => {
    expect(judge({ path: "Inbox/a.md", frontmatter: {}, body: "" }, view).warnings).toEqual([{ field: "path", kind: "unregistered-folder" }]);
    expect(judge({ path: "a.md", frontmatter: {}, body: "" }, view).warnings).toEqual([{ field: "path", kind: "unregistered-folder" }]);
    expect(judge({ path: "Projects/deep/a.md", frontmatter: {}, body: "" }, view).warnings).toEqual([]);
  });

  it("warns on an unknown property", () => {
    expect(judge({ path: "Projects/a.md", frontmatter: { status: "x", extra: 1 }, body: "" }, view).warnings)
      .toEqual([{ field: "extra", kind: "unknown-property" }]);
  });

  it("leaves null axes open", () => {
    expect(judge({ path: "anywhere/a.md", frontmatter: { whatever: 1 }, body: "" }, sealed({})).warnings).toEqual([]);
  });
});

describe("the judge ignores history", () => {
  const view = sealed({
    folders: { Projects: { meaning: "projects", searchExclude: false } },
    properties: {
      status: property({ required: true, rules: [{ kind: "allowed", values: ["open", "done"] }] }),
      owner: property(),
    },
    templates: {
      Meeting: { source: "Templates/Meeting.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Projects", requiredProperties: ["owner"], narrowedRules: { status: [{ kind: "fixed", value: "open" }] }, requiredHeadings: ["Agenda"] },
    },
  });
  const notes = [
    "---\nstatus: open\nowner: me\n---\n## Agenda\n",
    "---\nlegacy: kept\nowner: me\n---\nnew body\n",
    "---\nstatus: wrong\nextra: 1\n---\nbody\n",
    "---\nstatus: \"\"\n---\n",
    "no frontmatter\n",
    "---\nstatus: [unclosed\n---\n",
  ];
  const priors: (string | undefined | null)[] = [undefined, "", ...notes, "---\nlegacy: kept\nextra: 1\nstatus: wrong\n---\n"];

  function ready(path: string, previousContent: string | undefined | null): Extract<WriteTarget, { state: "ready" }> {
    return { state: "ready", vaultRoot: "/vault", path, absolutePath: `/vault/${path}`, previousContent, view };
  }

  it("gives the same verdict for the same note whatever was on disk before", () => {
    for (const path of ["Projects/a.md", "Inbox/a.md"]) {
      for (const content of notes) {
        const expected = judgeContent({ path, content }, view);
        for (const prior of priors.filter(entry => entry !== null)) {
          expect(judgeReadyTarget(ready(path, prior), content)).toEqual(expected);
          expect(decideWrite(ready(path, prior), content).verdict).toEqual(expected);
        }
      }
    }
  });

  it("depends only on the contract, the path and the frontmatter, never the body", () => {
    for (const content of notes) {
      const [head, ...rest] = content.split("\n---\n");
      if (rest.length === 0) continue;
      expect(judgeContent({ path: "Projects/a.md", content: `${head}\n---\nanother body\n` }, view))
        .toEqual(judgeContent({ path: "Projects/a.md", content }, view));
    }
  });

  it("records only the warnings the note did not already have", () => {
    const legacy = "---\nlegacy: kept\nowner: me\n---\nold body\n";
    const bodyOnly = decideWrite(ready("Projects/a.md", legacy), "---\nlegacy: kept\nowner: me\n---\nnew body\n", { repair: false });
    expect(bodyOnly.verdict.warnings).toEqual([{ field: "legacy", kind: "unknown-property" }, { field: "status", kind: "missing" }]);
    expect(bodyOnly).toMatchObject({ outcome: "allow", findings: [] });
    const added = decideWrite(ready("Projects/a.md", legacy), "---\nlegacy: kept\nowner: me\nextra: 1\n---\nold body\n", { repair: false });
    expect(added).toMatchObject({ outcome: "allow", findings: [{ axis: "property", kind: "kept", wanted: { field: "extra", value: 1 } }] });
    const fresh = decideWrite(ready("Projects/a.md", undefined), "---\nlegacy: kept\n---\nbody\n", { repair: false });
    expect(fresh.outcome === "allow" ? fresh.findings.map(finding => finding.wanted.field) : null).toEqual(["legacy", "status"]);
  });
});

describe("a template key", () => {
  it("is judged like an ordinary key", () => {
    const closed = sealed({ properties: { status: property() } });
    const registered = sealed({ properties: { template: property({ rules: [{ kind: "allowed", values: ["Meeting"] }] }) } });
    const judged = (frontmatter: Record<string, unknown>, view: ContractView) => judge({ path: "a.md", frontmatter, body: "" }, view).warnings;
    expect(judged({ template: "Meeting" }, closed)).toEqual([{ field: "template", kind: "unknown-property" }]);
    expect(judged({ template: "Meeting" }, closed)).toEqual(judged({ kind: "Meeting" }, closed).map(warning => ({ ...warning, field: "template" })));
    expect(judged({ template: "Meeting" }, registered)).toEqual([]);
    expect(judged({ template: "Other" }, registered)).toEqual([{ field: "template", kind: "not-allowed" }]);
    expect(judged({ template: "Nonexistent" }, sealed({}))).toEqual([]);
  });

  it("never selects a sealed template's requirements", () => {
    const view = sealed({
      properties: { template: property(), owner: property() },
      templates: {
        Meeting: { source: "Templates/Meeting.md", sourceHash: `sha256:${"0".repeat(64)}`, applyFolder: "Meetings", requiredProperties: ["owner"], narrowedRules: {}, requiredHeadings: ["Agenda"] },
      },
    });
    expect(judge({ path: "Notes/a.md", frontmatter: { template: "Meeting" }, body: "" }, view).warnings).toEqual([]);
  });
});

describe("pattern values are capped", () => {
  it("fails an over-long value without running the pattern", () => {
    const view = sealed({ properties: { id: property({ rules: [{ kind: "pattern", regex: "(a+)+b" }] }) } });
    const long = "a".repeat(PATTERN_VALUE_LIMIT + 1);
    const started = Date.now();
    expect(judge({ path: "a.md", frontmatter: { id: long }, body: "" }, view).warnings).toEqual([{ field: "id", kind: "pattern" }]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never runs a sealed source past the seal-time length cap", () => {
    const atCap = sealed({ properties: { id: property({ rules: [{ kind: "pattern", regex: "a".repeat(PATTERN_SOURCE_LIMIT) }] }) } });
    expect(judge({ path: "a.md", frontmatter: { id: "a".repeat(PATTERN_SOURCE_LIMIT) }, body: "" }, atCap).warnings).toEqual([]);
    const overCap = sealed({ properties: { id: property({ rules: [{ kind: "pattern", regex: "a".repeat(PATTERN_SOURCE_LIMIT + 1) }] }) } });
    expect(judge({ path: "a.md", frontmatter: { id: "a".repeat(PATTERN_SOURCE_LIMIT + 1) }, body: "" }, overCap).warnings).toEqual([{ field: "id", kind: "pattern" }]);
  });
});
