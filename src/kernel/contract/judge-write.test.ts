import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../conventions/canonical.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { decideWrite, judgeReadyTarget, resolveWriteTarget, type WriteTarget } from "./judge-write.js";
import { sealLegacyGeneration } from "./legacy-store-fixture.js";
import { bootstrapSnapshots } from "./store.js";
import type { ContractView, PropertyContract } from "./types.js";
import { resolveSealState } from "./vault-id.js";

const directories: string[] = [];

async function tempVault(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oms-judge-write-")));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("resolveWriteTarget seal state failures", () => {
  it("maps a throwing seal resolver to a broken contract that the judge warns on", async () => {
    const vault = await tempVault();
    const resolved = await resolveWriteTarget(vault, join(vault, "a.md"), {
      resolveSealState: async () => { throw new Error("store exploded"); },
    });
    expect(resolved.state).toBe("ready");
    if (resolved.state !== "ready") return;
    expect(resolved.view).toEqual({ state: "unreadable", reason: "broken" });
    expect(judgeReadyTarget(resolved, "---\nstatus: open\n---\nbody\n")).toEqual({
      ok: true,
      refusals: [],
      warnings: [{ field: "contract", kind: "contract-unreadable" }],
      fixes: [],
      missingDefaults: [],
      violations: [],
    });
  });

  it("uses the injected resolver's view when it succeeds", async () => {
    const vault = await tempVault();
    const resolved = await resolveWriteTarget(vault, join(vault, "a.md"), {
      resolveSealState: async () => ({ row: "never-sealed", view: { state: "open" }, vaultId: null, shared: false, settingsInvalid: false }),
    });
    expect(resolved.state === "ready" && resolved.view).toEqual({ state: "open" });
  });
});

describe("a version 2 generation with templates", () => {
  it("loads, and neither the judge nor decideWrite reads its template constraints", async () => {
    const vault = await tempVault();
    const root = await tempVault();
    const vaultId = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    await mkdir(join(vault, ".oms"));
    await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId, templateFolder: "Templates" }));
    const status: PropertyContract = { meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["closed", "done"] }] };
    const revision = await sealLegacyGeneration({
      vaultRealPath: vault,
      vaultId,
      contract: { folders: null, properties: { status } },
      templates: {
        // Its fixed rule contradicts the pool's allowed list, so a leaked read would show as a contradiction.
        Meeting: {
          source: "Templates/Meeting.md", sourceHash: digestBytes("x"), applyFolder: "Projects",
          requiredProperties: ["status", "attendees"], narrowedRules: { status: [{ kind: "fixed", value: "open" }] }, requiredHeadings: ["Agenda"],
        },
      },
    }, root);
    await bootstrapSnapshots(root, vaultId);
    const manifest = join(root, `.${vaultId}.1`, "manifest.json");
    const before = await readFile(manifest, "utf8");

    const resolved = await resolveWriteTarget(vault, join(vault, "Projects/a.md"), { resolveSealState: target => resolveSealState(target, root) });
    if (resolved.state !== "ready" || resolved.view.state !== "sealed") throw new Error("expected a sealed ready target");
    expect(resolved.view.revision).toBe(revision);
    expect(resolved.view.legacy?.templates["Meeting"]?.requiredHeadings).toEqual(["Agenda"]);
    expect(resolved.view.contract).not.toHaveProperty("templates");

    // In the template's applyFolder, breaking its fixed `status`, lacking `attendees` and its heading.
    const obeysPool = "---\nstatus: closed\n---\nno agenda\n";
    expect(judgeReadyTarget(resolved, obeysPool)).toMatchObject({ ok: true, refusals: [], warnings: [], violations: [] });
    expect(decideWrite(resolved, obeysPool, { template: "Meeting" })).toMatchObject({ outcome: "allow", findings: [] });
    expect(decideWrite(resolved, obeysPool, { template: "Meeting" })).not.toHaveProperty("fixedContent");

    // A pool miss is kept as an ordinary warning, not a contradiction the template's rule would imply.
    const decision = decideWrite(resolved, "---\nstatus: pending\n---\nno agenda\n", { template: "Meeting" });
    expect(decision).toMatchObject({ outcome: "allow", findings: [{ axis: "value", kind: "kept", reason: "kept: not-allowed" }] });

    expect(await readFile(manifest, "utf8")).toBe(before);
  });
});

type ReadyTarget = Extract<WriteTarget, { readonly state: "ready" }>;

function property(overrides: Partial<PropertyContract> = {}): PropertyContract {
  return { meaning: "a property", type: "text", default: false, required: false, rules: [], ...overrides };
}

const SEALED: ContractView = {
  state: "sealed",
  contract: { folders: null, properties: { status: property({ required: true }), owner: property() } },
};

function ready(view: ContractView, previousContent: string | undefined | null = undefined): ReadyTarget {
  return { state: "ready", vaultRoot: "/vault", path: "a.md", absolutePath: "/vault/a.md", previousContent, view };
}

describe("judgeReadyTarget", () => {
  it("warns that an existing target could not be read", () => {
    const verdict = judgeReadyTarget(ready({ state: "open" }, null), "body\n");
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual([{ field: "contract", kind: "contract-open" }, { field: "content", kind: "contract-unreadable" }]);
  });

  it("refuses against a tampered contract without adding the unreadable-target warning", () => {
    const verdict = judgeReadyTarget(ready({ state: "unreadable", reason: "tampered" }, null), "body\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals).toEqual([{ field: "contract", kind: "contract-tampered" }]);
    expect(verdict.warnings).toEqual([]);
  });
});

describe("decideWrite", () => {
  it("denies only on a refusal", () => {
    const decision = decideWrite(ready({ state: "unreadable", reason: "tampered" }), "---\nstatus: open\n---\n");
    expect(decision.outcome).toBe("deny");
    expect(decision.verdict.refusals).toEqual([{ field: "contract", kind: "contract-tampered" }]);
  });

  it("allows anything against an open vault, carrying the contract-open warning", () => {
    const decision = decideWrite(ready({ state: "open" }), "---\nanything: 1\n---\n");
    expect(decision).toMatchObject({ outcome: "allow", findings: [] });
    if (decision.outcome !== "allow") return;
    expect(decision.fixedContent).toBeUndefined();
    expect(decision.verdict.warnings).toEqual([{ field: "contract", kind: "contract-open" }]);
  });

  it("allows a clean sealed write as written", () => {
    const decision = decideWrite(ready(SEALED), "---\nstatus: open\n---\nbody\n");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "allow") return;
    expect(decision.fixedContent).toBeUndefined();
    expect(decision.verdict.warnings).toEqual([]);
  });

  it("saves a new unknown key as written and records it as kept", () => {
    const decision = decideWrite(ready(SEALED), "---\nstatus: open\nextra: 1\n---\nbody\n");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "allow") return;
    expect(decision.verdict.warnings).toEqual([{ field: "extra", kind: "unknown-property" }]);
    expect(decision.fixedContent).toBeUndefined();
    expect(decision.saved.warnings).toEqual([{ field: "extra", kind: "unknown-property" }]);
    expect(decision.findings.map(finding => `${finding.kind} ${finding.reason}`)).toEqual(["kept kept: unknown-property"]);
  });

  it("returns the fixed content and the saved verdict's fixes for a lossless fix", () => {
    const typed: ContractView = { state: "sealed", contract: { folders: null, properties: { status: property({ required: true }), size: property({ type: "number" }) } } };
    const decision = decideWrite(ready(typed), "---\nstatus: open\nsize: \"12\"\n---\nbody\n");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "allow") return;
    expect(decision.verdict.warnings).toEqual([{ field: "size", kind: "type" }]);
    expect(decision.fixedContent).toBe("---\nstatus: open\nsize: 12\n---\nbody\n");
    expect(decision.saved).toMatchObject({ warnings: [], fixes: [{ field: "size", kind: "type" }] });
    expect(decision.findings).toMatchObject([{ kind: "fixed", wanted: { field: "size", value: "12" }, reason: "fixed: type" }]);
  });

  it("fills a date default only on a new note and only with a time", () => {
    const dated: ContractView = { state: "sealed", contract: { folders: null, properties: { created: property({ type: "date", default: true, required: true }) } } };
    const now = new Date(2026, 8, 29, 9, 30);
    const fresh = decideWrite(ready(dated), "body\n", { now });
    expect(fresh.outcome === "allow" && fresh.fixedContent).toBe("---\ncreated: 2026-09-29\n---\nbody\n");
    const existing = decideWrite(ready(dated, "old\n"), "body\n", { now });
    expect(existing.outcome === "allow" && existing.fixedContent).toBeUndefined();
    const timeless = decideWrite(ready(dated), "body\n");
    expect(timeless.outcome === "allow" && timeless.fixedContent).toBeUndefined();
  });

  it("drafts only frontmatter that does not parse", () => {
    const decision = decideWrite(ready(SEALED), "---\nstatus: [\n---\nbody\n");
    expect(decision.outcome).toBe("draft");
    if (decision.outcome !== "draft") return;
    expect(decision.findings.map(finding => finding.reason)).toContain("drafted: yaml-syntax");
    expect(decision.asWritten.map(finding => finding.reason)).toContain("kept: yaml-syntax");
    const missing = decideWrite(ready(SEALED), "---\nowner: me\n---\nbody\n");
    expect(missing).toMatchObject({ outcome: "allow", findings: [{ kind: "kept", reason: "kept: missing" }] });
  });

  it("never drafts or repairs when repair is off", () => {
    for (const content of ["---\nowner: me\n---\nbody\n", "---\nstatus: open\nextra: 1\n---\nbody\n"]) {
      const decision = decideWrite(ready(SEALED), content, { repair: false });
      expect(decision.outcome).toBe("allow");
      if (decision.outcome !== "allow") continue;
      expect(decision.fixedContent).toBeUndefined();
      expect(decision.findings.every(finding => finding.reason.startsWith("kept: "))).toBe(true);
    }
  });

  it("does not treat a warning the note already had as new", () => {
    const view: ContractView = { state: "sealed", contract: { folders: { Projects: { meaning: "p", searchExclude: false } }, properties: null } };
    const unfiled = decideWrite(ready(view), "new body\n");
    expect(unfiled).toMatchObject({ outcome: "allow", findings: [{ axis: "folder", kind: "kept" }] });
    const decision = decideWrite(ready(view, "old body\n"), "new body\n");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "allow") return;
    expect(decision.verdict.warnings).toEqual([{ field: "path", kind: "unregistered-folder" }]);
    expect(decision.fixedContent).toBeUndefined();
    expect(decision.findings).toEqual([]);
  });
});

describe("decideWrite on a legacy view", () => {
  it("decides exactly as on the same axes without templates, choices and contradictions included", () => {
    const axes = { folders: { Notes: { meaning: "notes", searchExclude: false } }, properties: { size: property({ type: "number" }) } };
    const legacyTemplate = (source: string, narrowedRules = {}) => ({
      source, sourceHash: `sha256:${"a".repeat(64)}` as const, applyFolder: "Notes", requiredProperties: [], narrowedRules, requiredHeadings: [],
    });
    const legacy: ContractView = {
      state: "sealed",
      contract: axes,
      // Two templates on one folder would offer a choice; A's empty allowed list would contradict `size`.
      legacy: { templates: { A: legacyTemplate("Templates/A.md", { size: [{ kind: "allowed", values: [] }] }), B: legacyTemplate("Templates/B.md") } },
    };
    const v3: ContractView = { state: "sealed", contract: axes };
    const at = (view: ContractView): ReadyTarget => ({ ...ready(view), path: "Notes/a.md", absolutePath: "/vault/Notes/a.md" });
    const content = "---\nsize: \"12\"\n---\nbody\n";

    const decision = decideWrite(at(legacy), content);
    expect(decision).toEqual(decideWrite(at(v3), content));
    expect(decision).toMatchObject({ outcome: "allow", fixedContent: "---\nsize: 12\n---\nbody\n" });
    expect(decision.findings).toMatchObject([{ axis: "value", kind: "fixed", reason: expect.stringContaining("type") }]);
    expect(decision.findings.some(finding => finding.axis === "template" || finding.reason?.startsWith("contradiction"))).toBe(false);
  });
});
