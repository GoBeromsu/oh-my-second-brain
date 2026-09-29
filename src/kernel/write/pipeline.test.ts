import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { openGaps, readGapDraft, readGapLedger } from "../contract/gap-ledger.js";
import { contractRevision } from "../contract/revision.js";
import { sealContract } from "../contract/store.js";
import { formatWarnings, type VaultContract } from "../contract/types.js";
import { resolveSealState, type SealRow } from "../contract/vault-id.js";
import { syncEngineStore } from "../engine/embed/sync.js";
import { engineStorePath } from "../engine/paths.js";
import { runWritePipeline, type WriteRequest } from "./pipeline.js";

const CONTRACT: VaultContract = {
  folders: { Projects: { meaning: "project notes", searchExclude: false } },
  properties: {
    status: { meaning: "where the project stands", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["active", "done"] }] },
    created: { meaning: "creation date", type: "date", default: true, required: false, rules: [] },
  },
  templates: {
    project: {
      source: "Templates/project.md",
      sourceHash: `sha256:${"0".repeat(64)}`,
      meaning: "one project",
      requiredProperties: [],
      narrowedRules: {},
      requiredHeadings: ["Goals"],
    },
  },
};

const NOW = new Date(2026, 8, 28, 9, 30, 0);
/** Frontmatter that does not parse: the only note a sealed vault drafts. */
const BROKEN = "---\nstatus: [active\n---\nx\n";
const ISOLATED = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OMS_RUNTIME_ROOT", "OMS_AUTO_UPDATE_STATE_DIR", "OMS_CLAUDE_HOME", "OMS_CODEX_HOME", "OMS_HERMES_HOME", "OMS_VAULT"];

const fixtures: TruthTableFixture[] = [];
const scratch: string[] = [];
let savedEnv: Record<string, string | undefined>;

async function sealedVault(contract: VaultContract = CONTRACT): Promise<TruthTableFixture> {
  return rowVault("sealed", contract);
}

/** A vault in seal-state `row`, with HOME pointed at its store so the default seal read finds it. */
async function rowVault(row: SealRow, contract: VaultContract = CONTRACT): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow(row, contract);
  fixtures.push(fixture);
  const home = path.join(fixture.base, "home");
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  process.env["XDG_CONFIG_HOME"] = path.join(fixture.base, "config");
  process.env["XDG_CACHE_HOME"] = path.join(fixture.base, "cache");
  process.env["OMS_RUNTIME_ROOT"] = path.join(fixture.base, "runtime");
  return fixture;
}

function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function request(fixture: TruthTableFixture, notePath: string, content: string, extra: Partial<WriteRequest> = {}): WriteRequest {
  return { vault: fixture.vault, source: "explicit", path: notePath, content, ...extra };
}

/** Every file under `root` with the sha256 of its bytes; mtimes are ignored on purpose. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files[path.relative(root, full)] = sha256(await readFile(full));
      else files[path.relative(root, full)] = "link";
    }
  }
  await walk(root);
  return files;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_")) delete process.env[key];
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ISOLATED) delete process.env[key];
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("runWritePipeline", () => {
  it("rejects a vault inferred from the current directory before touching disk", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "oms-pipeline-cwd-")));
    scratch.push(cwd);
    const outcome = await runWritePipeline({ vault: cwd, source: "cwd", path: "a.md", content: "x\n" });
    expect(outcome).toMatchObject({ kind: "rejected", rejection: { code: "target-unverified" } });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("denies a malformed ifMatch before resolving the target", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "x\n", { ifMatch: "abc" }));
    expect(outcome).toEqual({ kind: "denied", refusals: [{ field: "ifMatch", kind: "unsupported-input" }] });
    expect(await readdir(path.join(fixture.vault))).not.toContain("Projects");
  });

  it("saves a note in an unregistered folder where it was named and records the folder as kept", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Loose/a.md", "x\n"), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome).toMatchObject({ kind: "written", receipt: { path: "Loose/a.md", warnings: [{ field: "path", kind: "unregistered-folder" }], fixes: [], gaps: [{ axis: "folder", kind: "kept", field: "path" }] } });
    expect(await readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).toBe("---\ncreated: 2026-09-28\n---\nx\n");
    const [gap] = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    expect(gap).toMatchObject({ axis: "folder", kind: "kept", wanted: { field: "path" }, reason: "kept: unregistered-folder" });
  });

  it("writes a new note without ifMatch and returns a receipt with conform changes", async () => {
    const fixture = await sealedVault();
    const updateIndex = vi.fn(async () => "skipped" as const);
    const outcome = await runWritePipeline(
      request(fixture, "Projects/Alpha.md", "---\nstatus: active\n---\n# {{title}}\n"),
      { updateIndex, now: () => NOW },
    );
    const written = await readFile(path.join(fixture.vault, "Projects", "Alpha.md"), "utf8");
    expect(written).toBe("---\nstatus: active\ncreated: 2026-09-28\n---\n# Alpha\n");
    expect(outcome).toMatchObject({
      kind: "written",
      receipt: {
        ok: true,
        path: "Projects/Alpha.md",
        revision: sha256(written),
        index: { keyword: "skipped", vector: "disabled" },
        conformed: [{ field: "content", action: "variable" }, { field: "created", action: "default" }],
        missingDefaults: [],
      },
    });
    expect(updateIndex).toHaveBeenCalledWith({ vault: fixture.vault, relPath: "Projects/Alpha.md" });
  });

  it("saves a value no allowed value spells as written, and records it as kept", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "---\nstatus: paused\n---\nBody\n"),
      { now: () => NOW, updateIndex: async () => "skipped", gapLedger: { now: () => 7, newId: () => "gap-1" } },
    );
    const written = await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8");
    expect(written).toBe("---\nstatus: paused\ncreated: 2026-09-28\n---\nBody\n");
    expect(outcome).toMatchObject({ kind: "written", receipt: { revision: sha256(written), warnings: [{ field: "status", kind: "not-allowed" }], fixes: [], gaps: [{ id: "gap-1", axis: "value", kind: "kept", field: "status" }] } });
    const receipt = outcome.kind === "written" ? outcome.receipt : null;
    const ledger = await readGapLedger(fixture.root, fixture.vaultId);
    expect(ledger).toEqual({
      corrupt: [],
      events: [{
        type: "gap",
        id: "gap-1",
        at: 7,
        notePath: "Projects/a.md",
        noteRevision: sha256(written),
        contractRevision: receipt?.contractRevision,
        axis: "value",
        kind: "kept",
        chosen: null,
        wanted: { field: "status", value: "paused" },
        reason: "kept: not-allowed",
      }],
    });
  });

  it("keeps a note whose frontmatter does not parse as a draft beside the ledger and leaves the vault untouched", async () => {
    const fixture = await sealedVault();
    const before = await snapshot(fixture.vault);
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", BROKEN), { now: () => NOW, gapLedger: { newId: () => "00000000-0000-4000-8000-000000000001" } });
    expect(outcome).toEqual({
      kind: "drafted",
      draftRef: "draft-00000000-0000-4000-8000-000000000001.md",
      warnings: [expect.objectContaining({ field: "content", kind: "yaml-syntax" })],
    });
    expect(await snapshot(fixture.vault)).toEqual(before);
    expect(await readGapDraft(fixture.root, fixture.vaultId, "draft-00000000-0000-4000-8000-000000000001.md")).toBe(BROKEN);
    const [gap] = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    expect(gap).toMatchObject({ axis: "value", kind: "no-fit", notePath: "Projects/a.md", noteRevision: sha256(BROKEN), draftRef: "draft-00000000-0000-4000-8000-000000000001.md", reason: "drafted: yaml-syntax" });
  });

  it("saves the note as written when the draft cannot be kept", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", BROKEN), { now: () => NOW, updateIndex: async () => "skipped", gapLedger: { newId: () => "not-a-uuid" } });
    expect(outcome).toMatchObject({ kind: "written", receipt: { path: "Projects/a.md", warnings: [{ field: "content", kind: "yaml-syntax" }] } });
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe(BROKEN);
    expect((await readdir(path.join(fixture.base, "home", ".oms", "vaults", fixture.vaultId))).filter(name => name.startsWith("draft"))).toEqual([]);
  });

  it("saves the note as written when the sealed vault has no id to file the gap under", async () => {
    const fixture = await sealedVault();
    const resolveSeal = vi.fn(async (vault: string) => ({ ...(await resolveSealState(vault, fixture.root)), vaultId: null }));
    const outcome = await runWritePipeline(request(fixture, "Loose/a.md", "x\n"), { now: () => NOW, updateIndex: async () => "skipped", resolveSealState: resolveSeal });
    expect(outcome).toMatchObject({ kind: "written", receipt: { gapLedger: "unavailable", warnings: [{ field: "path", kind: "unregistered-folder" }] } });
    expect(outcome.kind === "written" ? outcome.receipt.gaps : "absent").toEqual([{ axis: "folder", kind: "kept", field: "path" }]);
    expect(await readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).toBe("---\ncreated: 2026-09-28\n---\nx\n");
    expect(resolveSeal).toHaveBeenCalledTimes(1);
    expect((await readGapLedger(fixture.root, fixture.vaultId)).events).toEqual([]);
  });

  it("saves the note and marks the receipt when its gaps cannot be recorded", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "---\nstatus: paused\n---\nBody\n"),
      { now: () => NOW, updateIndex: async () => "skipped", gapLedger: { newId: () => { throw new Error("no ids"); } } },
    );
    expect(outcome).toMatchObject({ kind: "written", receipt: { ok: true, gapLedger: "failed" } });
    // The kept field is still reported, without an id, so the gap is never silent.
    expect(outcome.kind === "written" ? outcome.receipt.gaps : "absent").toEqual([{ axis: "value", kind: "kept", field: "status" }]);
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("---\nstatus: paused\ncreated: 2026-09-28\n---\nBody\n");
  });

  it("saves the note as written and lists the kept fields without ids when the vault has no ledger", async () => {
    const fixture = await sealedVault();
    const resolveSeal = vi.fn(async (vault: string) => ({ ...(await resolveSealState(vault, fixture.root)), vaultId: null }));
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "---\nstatus: paused\nmood: calm\n---\nBody\n"),
      { now: () => NOW, updateIndex: async () => "skipped", resolveSealState: resolveSeal },
    );
    expect(outcome).toMatchObject({ kind: "written", receipt: { ok: true, gapLedger: "unavailable" } });
    expect(outcome.kind === "written" ? outcome.receipt.gaps : "absent").toEqual([
      { axis: "property", kind: "kept", field: "mood" },
      { axis: "value", kind: "kept", field: "status" },
    ]);
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("---\nstatus: paused\nmood: calm\ncreated: 2026-09-28\n---\nBody\n");
    expect((await readGapLedger(fixture.root, fixture.vaultId)).events).toEqual([]);
  });

  it("still returns the draft ref when the draft is kept but its gaps cannot be recorded", async () => {
    const fixture = await sealedVault();
    const uuid = "00000000-0000-4000-8000-000000000002";
    const newId = vi.fn().mockReturnValueOnce(uuid).mockImplementation(() => { throw new Error("no ids"); });
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", BROKEN), { now: () => NOW, gapLedger: { newId } });
    expect(outcome).toEqual({ kind: "drafted", draftRef: `draft-${uuid}.md`, warnings: [expect.objectContaining({ kind: "yaml-syntax" })] });
    expect(await readGapDraft(fixture.root, fixture.vaultId, `draft-${uuid}.md`)).toBe(BROKEN);
    expect((await readGapLedger(fixture.root, fixture.vaultId)).events).toEqual([]);
  });

  it("checks the ifMatch before drafting, so a stale or missing ifMatch keeps no draft and records nothing", async () => {
    const fixture = await sealedVault({ ...CONTRACT, properties: { ...CONTRACT.properties!, status: { ...CONTRACT.properties!["status"]!, required: true } } });
    await mkdir(path.join(fixture.vault, "Projects"));
    const target = path.join(fixture.vault, "Projects", "a.md");
    await writeFile(target, "---\nstatus: active\n---\noriginal\n");
    const store = path.join(fixture.base, "home", ".oms");
    const before = await snapshot(store);
    // Frontmatter that does not parse would be drafted.
    const content = "---\nstatus: [paused\n---\nchanged\n";
    const checked = await runWritePipeline(request(fixture, "Projects/a.md", content, { check: true }), { now: () => NOW });
    expect(checked).toMatchObject({ kind: "checked", check: { resolution: { action: "draft", wouldDraft: false, precondition: "if-match-required" } } });
    expect(await runWritePipeline(request(fixture, "Projects/a.md", content), { now: () => NOW })).toEqual({ kind: "if-match-required" });
    expect(await runWritePipeline(request(fixture, "Projects/a.md", content, { ifMatch: sha256("stale\n") }), { now: () => NOW })).toEqual({ kind: "retry", state: "changed" });
    expect(await runWritePipeline(request(fixture, "Projects/b.md", content, { ifMatch: sha256("stale\n") }), { now: () => NOW })).toEqual({ kind: "retry", state: "absent" });
    expect(await snapshot(store)).toEqual(before);
    expect(await readFile(target, "utf8")).toBe("---\nstatus: active\n---\noriginal\n");
  });

  it("check folds the ifMatch precondition into its prediction and still writes nothing", async () => {
    const fixture = await sealedVault({ ...CONTRACT, properties: { ...CONTRACT.properties!, status: { ...CONTRACT.properties!["status"]!, required: true } } });
    await mkdir(path.join(fixture.vault, "Projects"));
    const original = "---\nstatus: active\n---\noriginal\n";
    await writeFile(path.join(fixture.vault, "Projects", "a.md"), original);
    const store = path.join(fixture.base, "home", ".oms");
    const before = { vault: await snapshot(fixture.vault), store: await snapshot(store) };
    const content = "---\nstatus: [paused\n---\nchanged\n";
    const check = async (notePath: string, ifMatch?: string) => {
      const outcome = await runWritePipeline(request(fixture, notePath, content, { check: true, ...(ifMatch === undefined ? {} : { ifMatch }) }), { now: () => NOW });
      return outcome.kind === "checked" ? outcome.check.resolution : null;
    };
    expect(await check("Projects/a.md")).toEqual({ action: "draft", gaps: expect.any(Array), wouldDraft: false, precondition: "if-match-required" });
    expect(await check("Projects/a.md", sha256("stale\n"))).toMatchObject({ action: "draft", wouldDraft: false, precondition: "changed" });
    expect(await check("Projects/b.md", sha256("stale\n"))).toMatchObject({ action: "draft", wouldDraft: false, precondition: "absent" });
    const valid = await check("Projects/a.md", sha256(original));
    expect(valid).toMatchObject({ action: "draft", wouldDraft: true });
    expect(valid).not.toHaveProperty("precondition");
    expect({ vault: await snapshot(fixture.vault), store: await snapshot(store) }).toEqual(before);
  });

  it("check folds the ifMatch precondition into a save as well", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    const original = "---\nstatus: active\n---\noriginal\n";
    await writeFile(path.join(fixture.vault, "Projects", "a.md"), original);
    const before = await snapshot(fixture.vault);
    const content = "---\nstatus: active\nmood: calm\n---\nchanged\n";
    const check = async (ifMatch?: string) => {
      const outcome = await runWritePipeline(request(fixture, "Projects/a.md", content, { check: true, ...(ifMatch === undefined ? {} : { ifMatch }) }), { now: () => NOW });
      return outcome.kind === "checked" ? outcome.check.resolution : null;
    };
    expect(await check()).toMatchObject({ action: "save", wouldDraft: false, precondition: "if-match-required" });
    expect(await check(sha256("stale\n"))).toMatchObject({ action: "save", precondition: "changed" });
    const valid = await check(sha256(original));
    expect(valid).toMatchObject({ action: "save", gaps: [{ field: "mood", kind: "kept" }] });
    expect(valid).not.toHaveProperty("precondition");
    expect(await snapshot(fixture.vault)).toEqual(before);
  });

  it("check gives a refusal no precondition, even with a stale ifMatch", async () => {
    const fixture = await rowVault("vault-id-tampered");
    await mkdir(path.join(fixture.vault, "Projects"));
    await writeFile(path.join(fixture.vault, "Projects", "a.md"), "---\nstatus: active\n---\noriginal\n");
    const refused = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: paused\n---\n", { check: true, ifMatch: sha256("stale\n") }), { now: () => NOW });
    expect(refused).toMatchObject({ kind: "checked", check: { ok: false, refusals: [{ kind: "contract-tampered" }], resolution: { action: "refuse" } } });
    expect(refused.kind === "checked" ? refused.check.resolution : null).not.toHaveProperty("precondition");
  });

  it("check predicts the write for an extra optional key: the same action and kept fields, with nothing written", async () => {
    const fixture = await sealedVault();
    const store = path.join(fixture.base, "home", ".oms");
    const before = { vault: await snapshot(fixture.vault), store: await snapshot(store) };
    const content = "---\nstatus: active\nmood: calm\n---\nBody\n";
    const checked = await runWritePipeline(request(fixture, "Projects/a.md", content, { check: true }), { now: () => NOW });
    expect(checked).toMatchObject({
      kind: "checked",
      check: {
        ok: true,
        refusals: [],
        warnings: [{ field: "mood", kind: "unknown-property" }],
        fixes: [],
        violations: [],
        resolution: { action: "save", gaps: [{ axis: "property", kind: "kept", field: "mood" }], wouldDraft: false },
      },
    });
    expect({ vault: await snapshot(fixture.vault), store: await snapshot(store) }).toEqual(before);

    const written = await runWritePipeline(request(fixture, "Projects/a.md", content), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(written.kind).toBe("written");
    const receipt = written.kind === "written" ? written.receipt : null;
    const predicted = checked.kind === "checked" ? checked.check.resolution.gaps : [];
    expect(receipt?.gaps?.map(({ id: _id, ...gap }) => gap)).toEqual(predicted);
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("---\nstatus: active\nmood: calm\ncreated: 2026-09-28\n---\nBody\n");
  });

  it("check reports a refusal, and a draft with no ledger to go to as a save as written", async () => {
    const tampered = await rowVault("vault-id-tampered");
    const refused = await runWritePipeline(request(tampered, "Projects/a.md", "---\nstatus: active\n---\n", { check: true }), { now: () => NOW });
    expect(refused).toMatchObject({
      kind: "checked",
      check: { ok: false, refusals: [{ kind: "contract-tampered" }], violations: [{ kind: "contract-tampered" }], resolution: { action: "refuse", gaps: [], wouldDraft: false } },
    });
    const fixture = await sealedVault();
    const resolveSeal = vi.fn(async (vault: string) => ({ ...(await resolveSealState(vault, fixture.root)), vaultId: null }));
    const unfiled = await runWritePipeline(request(fixture, "Loose/a.md", "x\n", { check: true }), { now: () => NOW, resolveSealState: resolveSeal });
    expect(unfiled).toMatchObject({
      kind: "checked",
      check: { ok: true, warnings: [{ field: "path", kind: "unregistered-folder" }], resolution: { action: "save", gaps: [{ axis: "folder", field: "path" }], wouldDraft: false } },
    });
    const noLedger = await runWritePipeline(request(fixture, "Projects/a.md", BROKEN, { check: true }), { now: () => NOW, resolveSealState: resolveSeal });
    expect(noLedger).toMatchObject({ kind: "checked", check: { ok: true, resolution: { action: "save", gaps: [{ axis: "value", kind: "kept", field: "content" }], wouldDraft: false } } });
    const drafted = await runWritePipeline(request(fixture, "Projects/a.md", BROKEN, { check: true }), { now: () => NOW });
    expect(drafted).toMatchObject({ kind: "checked", check: { resolution: { action: "draft", gaps: [{ axis: "value", kind: "no-fit", field: "content" }], wouldDraft: true } } });
  });

  it("records an open template choice and saves the note as written", async () => {
    const template = CONTRACT.templates["project"]!;
    const fixture = await sealedVault({
      ...CONTRACT,
      templates: {
        project: { ...template, applyFolder: "Projects", requiredHeadings: [] },
        review: { ...template, source: "Templates/review.md", applyFolder: "Projects", requiredHeadings: [] },
      },
    });
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: active\n---\nBody\n"), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome).toMatchObject({ kind: "written", receipt: { gaps: [{ axis: "template", kind: "choice", field: "template" }] } });
    const [gap] = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    expect(gap).toMatchObject({ chosen: "project", reason: "2 templates apply to the folder and none was selected" });
  });

  it("saves a write the contract contradicts on the field as written and records the contradiction", async () => {
    const fixture = await sealedVault({
      ...CONTRACT,
      properties: { ...CONTRACT.properties!, status: { ...CONTRACT.properties!["status"]!, rules: [{ kind: "allowed", values: [] }] } },
    });
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: active\n---\nBody\n"), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome).toMatchObject({ kind: "written", receipt: { warnings: [{ field: "status", kind: "not-allowed" }], fixes: [], gaps: [{ axis: "value", kind: "kept", field: "status" }] } });
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe("---\nstatus: active\ncreated: 2026-09-28\n---\nBody\n");
    const [gap] = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    expect(gap).toMatchObject({ axis: "value", kind: "kept", wanted: { field: "status", value: "active" }, reason: "contradiction: not-allowed" });
  });

  it("saves under a broken contract with a warning whose guidance names oms interview", async () => {
    const fixture = await rowVault("index-without-store");
    const outcome = await runWritePipeline(request(fixture, "Loose/a.md", "---\nmood: calm\n---\nBody\n"), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome).toMatchObject({ kind: "written", receipt: { path: "Loose/a.md", contractRevision: null } });
    expect(outcome.kind === "written" ? outcome.receipt.gaps ?? [] : null).toEqual([]);
    const warnings = outcome.kind === "written" ? outcome.receipt.warnings : [];
    expect(warnings).toEqual([expect.objectContaining({ kind: "contract-unreadable" })]);
    expect(formatWarnings(warnings.map(({ field, kind }) => ({ field, kind: kind as "contract-unreadable" })))).toMatch(/Run: oms interview$/);
    expect(await readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).toBe("---\nmood: calm\n---\nBody\n");
  });

  it("denies a write under a tampered contract and leaves disk untouched", async () => {
    const fixture = await rowVault("vault-id-tampered");
    const before = { vault: await snapshot(fixture.vault), store: await snapshot(fixture.root) };
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: active\n---\nBody\n"), { now: () => NOW });
    expect(outcome).toEqual({ kind: "denied", refusals: [expect.objectContaining({ kind: "contract-tampered" })] });
    expect({ vault: await snapshot(fixture.vault), store: await snapshot(fixture.root) }).toEqual(before);
  });

  it("drafts a note with broken YAML under a sealed contract", async () => {
    const fixture = await sealedVault();
    const before = await snapshot(fixture.vault);
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: [active\n---\nBody\n"), { now: () => NOW });
    expect(outcome).toMatchObject({ kind: "drafted", draftRef: expect.stringMatching(/^draft-/) });
    expect(outcome.kind === "drafted" ? outcome.warnings : []).toContainEqual(expect.objectContaining({ kind: "yaml-syntax" }));
    expect(await snapshot(fixture.vault)).toEqual(before);
    const [gap] = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    expect(gap).toMatchObject({ axis: "value", reason: "drafted: yaml-syntax", draftRef: outcome.kind === "drafted" ? outcome.draftRef : "" });
  });

  it("saves a note with broken YAML under an open contract, with the warning", async () => {
    const fixture = await rowVault("never-sealed");
    const content = "---\nstatus: [active\n---\nBody\n";
    const outcome = await runWritePipeline(request(fixture, "Loose/a.md", content), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome.kind === "written" ? outcome.receipt.gaps ?? [] : null).toEqual([]);
    const warnings = outcome.kind === "written" ? outcome.receipt.warnings.map(warning => warning.kind) : [];
    expect(warnings).toEqual(expect.arrayContaining(["contract-open", "yaml-syntax"]));
    expect(await readFile(path.join(fixture.vault, "Loose", "a.md"), "utf8")).toBe(content);
  });

  it("carries the full warning set in the receipt, including warnings the note already had", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Loose"));
    const original = "---\ncreated: 2026-09-01\n---\noriginal\n";
    await writeFile(path.join(fixture.vault, "Loose", "a.md"), original);
    // The folder warning is not new, so nothing is recorded or drafted, but the receipt still reports it.
    const outcome = await runWritePipeline(
      request(fixture, "Loose/a.md", "---\ncreated: 2026-09-01\n---\nchanged\n", { ifMatch: sha256(original) }),
      { now: () => NOW, updateIndex: async () => "skipped" },
    );
    expect(outcome).toMatchObject({ kind: "written", receipt: { warnings: [{ field: "path", kind: "unregistered-folder" }], fixes: [] } });
    expect(outcome.kind === "written" ? outcome.receipt.gaps ?? [] : null).toEqual([]);
    expect((await readGapLedger(fixture.root, fixture.vaultId)).events).toEqual([]);

    const repaired = await runWritePipeline(
      request(fixture, "Projects/b.md", "---\nstatus: Active\nmood: calm\n---\nBody\n"),
      { now: () => NOW, updateIndex: async () => "skipped" },
    );
    // The spelling is fixed and reported as a fix; the unknown key is kept and stays a warning on the saved note.
    expect(await readFile(path.join(fixture.vault, "Projects", "b.md"), "utf8")).toBe("---\nstatus: active\nmood: calm\ncreated: 2026-09-28\n---\nBody\n");
    expect(repaired.kind).toBe("written");
    if (repaired.kind !== "written") return;
    expect(repaired.receipt.fixes).toEqual([{ field: "status", kind: "not-allowed" }]);
    expect(repaired.receipt.warnings).toEqual([{ field: "mood", kind: "unknown-property" }]);
  });

  it("names one contract revision in the receipt and every gap when a seal lands mid-write", async () => {
    const fixture = await sealedVault();
    const vaultRealPath = await realpath(fixture.vault);
    const resealed: VaultContract = {
      ...CONTRACT,
      properties: { ...CONTRACT.properties!, created: { ...CONTRACT.properties!["created"]!, meaning: "creation date, resealed" } },
    };
    const seen: string[] = [];
    const resolveSeal = vi.fn(async (vault: string) => {
      const state = await resolveSealState(vault, fixture.root);
      seen.push(String(contractRevision(state.view)));
      // Another process seals a new contract right after this write read the seal state.
      await sealContract({ vaultRealPath, vaultId: fixture.vaultId, contract: resealed }, fixture.root);
      return state;
    });
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "---\nstatus: paused\n---\nBody\n"),
      { now: () => NOW, updateIndex: async () => "skipped", resolveSealState: resolveSeal },
    );
    expect(resolveSeal).toHaveBeenCalledTimes(1);
    const [sealedRevision] = seen;
    expect(sealedRevision).toMatch(/^sha256:/);
    expect(contractRevision((await resolveSealState(fixture.vault, fixture.root)).view)).not.toBe(sealedRevision);
    expect(outcome).toMatchObject({ kind: "written", receipt: { contractRevision: sealedRevision } });
    const events = (await readGapLedger(fixture.root, fixture.vaultId)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ contractRevision: sealedRevision });
  });

  it("requires ifMatch to overwrite an existing note and leaves its bytes unchanged", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    const target = path.join(fixture.vault, "Projects", "a.md");
    await writeFile(target, "original\n");
    const updateIndex = vi.fn(async () => "updated" as const);
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "changed\n"), { updateIndex });
    expect(outcome).toEqual({ kind: "if-match-required" });
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect(updateIndex).not.toHaveBeenCalled();
  });

  it("returns changed when ifMatch names a different revision", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    const target = path.join(fixture.vault, "Projects", "a.md");
    await writeFile(target, "original\n");
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "changed\n", { ifMatch: sha256("something else\n") }));
    expect(outcome).toEqual({ kind: "retry", state: "changed" });
    expect(await readFile(target, "utf8")).toBe("original\n");
  });

  it("overwrites when ifMatch names the revision on disk", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    const target = path.join(fixture.vault, "Projects", "a.md");
    await writeFile(target, "original\n");
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "changed\n", { ifMatch: sha256("original\n") }),
      { updateIndex: async () => "updated" },
    );
    expect(outcome).toMatchObject({ kind: "written", receipt: { revision: sha256("changed\n"), index: { keyword: "updated", vector: "pending" }, conformed: [] } });
    expect(await readFile(target, "utf8")).toBe("changed\n");
  });

  it("returns absent when ifMatch is given for a note that does not exist, and creates it without ifMatch", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "x\n", { ifMatch: sha256("x\n") }), { now: () => NOW });
    expect(outcome).toEqual({ kind: "retry", state: "absent" });
    expect(await readdir(fixture.vault)).not.toContain("Projects");
    const retried = await runWritePipeline(request(fixture, "Projects/a.md", "x\n"), { updateIndex: async () => "skipped", now: () => NOW });
    expect(retried).toMatchObject({ kind: "written", receipt: { path: "Projects/a.md" } });
  });

  it("never defaults a date property a template requires, and never judges the template's requirement", async () => {
    const required: VaultContract = {
      ...CONTRACT,
      templates: { project: { ...CONTRACT.templates["project"]!, requiredProperties: ["created"] } },
    };
    const fixture = await sealedVault(required);
    const content = "---\nstatus: active\n---\n## Goals\n";
    for (const template of ["project", undefined]) {
      const extra = template === undefined ? {} : { template };
      const checked = await runWritePipeline(request(fixture, "Projects/a.md", content, { ...extra, check: true }), { now: () => NOW });
      expect(checked).toMatchObject({ kind: "checked", check: { ok: true, violations: [], warnings: [], conformed: [] } });
    }
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", content, { template: "project" }), { now: () => NOW, updateIndex: async () => "skipped" });
    expect(outcome).toMatchObject({ kind: "written", receipt: { warnings: [] } });
    expect(await readFile(path.join(fixture.vault, "Projects", "a.md"), "utf8")).toBe(content);
  });

  it("records nothing when an edit keeps a legacy note's unknown key, and exactly one gap for a second unknown key", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    const target = path.join(fixture.vault, "Projects", "a.md");
    const legacy = "---\ncreated: 2026-09-01\nlegacy: kept\n---\noriginal\n";
    await writeFile(target, legacy);
    const options = { now: () => NOW, updateIndex: async () => "skipped" as const, gapLedger: { now: () => 7, newId: () => "gap-1" } };

    const edited = "---\ncreated: 2026-09-01\nlegacy: kept\n---\nchanged\n";
    const kept = await runWritePipeline(request(fixture, "Projects/a.md", edited, { ifMatch: sha256(legacy) }), options);
    expect(kept).toMatchObject({ kind: "written", receipt: { warnings: [{ field: "legacy", kind: "unknown-property" }] } });
    expect(kept.kind === "written" ? kept.receipt.gaps ?? [] : null).toEqual([]);
    expect(await readFile(target, "utf8")).toBe(edited);
    expect((await readGapLedger(fixture.root, fixture.vaultId)).events).toEqual([]);

    const added = await runWritePipeline(
      request(fixture, "Projects/a.md", "---\ncreated: 2026-09-01\nlegacy: kept\nextra: new\n---\nchanged\n", { ifMatch: sha256(edited) }),
      options,
    );
    expect(added).toMatchObject({ kind: "written", receipt: { gaps: [{ id: "gap-1", axis: "property", kind: "kept", field: "extra" }] } });
    expect(await readFile(target, "utf8")).toBe("---\ncreated: 2026-09-01\nlegacy: kept\nextra: new\n---\nchanged\n");
    const events = (await readGapLedger(fixture.root, fixture.vaultId)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "gap", kind: "kept", wanted: { field: "extra", value: "new" }, reason: "kept: unknown-property" });
  });

  it("returns changed when another writer creates the note between the judge and the save", async () => {
    const fixture = await sealedVault();
    const target = path.join(fixture.vault, "Projects", "a.md");
    const updateIndex = vi.fn(async () => "updated" as const);
    const outcome = await runWritePipeline(
      request(fixture, "Projects/a.md", "mine\n"),
      { updateIndex, noteWrite: { beforePublish: async () => writeFile(target, "theirs\n") } },
    );
    expect(outcome).toEqual({ kind: "retry", state: "changed" });
    expect(await readFile(target, "utf8")).toBe("theirs\n");
    expect(updateIndex).not.toHaveBeenCalled();
  });

  it("check mode judges and reports the frame without changing the vault, store or queue", async () => {
    const fixture = await sealedVault();
    await mkdir(path.join(fixture.vault, "Projects"));
    await writeFile(path.join(fixture.vault, "Projects", "a.md"), "---\nstatus: active\n---\nBody\n");
    const synced = await syncEngineStore({ vault: fixture.vault, embed: false });
    expect(synced.available).toBe(true);
    const cache = path.dirname(engineStorePath(fixture.vault));
    const store = path.join(fixture.base, "home", ".oms");
    const before = { vault: await snapshot(fixture.vault), cache: await snapshot(cache), store: await snapshot(store) };
    expect(Object.keys(before.cache).length).toBeGreaterThan(0);

    const updateIndex = vi.fn(async () => "updated" as const);
    const checks = await Promise.all([
      runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: done\n---\nNew\n", { check: true }), { updateIndex, now: () => NOW }),
      runWritePipeline(request(fixture, "Projects/b.md", "Body\n", { check: true, template: "project" }), { updateIndex, now: () => NOW }),
      runWritePipeline(request(fixture, "Projects/c.md", "---\nstatus: paused\n---\n", { check: true }), { updateIndex, now: () => NOW }),
    ]);

    expect(checks[0]).toMatchObject({
      kind: "checked",
      check: { ok: true, path: "Projects/a.md", revision: sha256("---\nstatus: active\n---\nBody\n"), refusals: [], warnings: [], fixes: [], violations: [], conformed: [] },
    });
    expect(checks[1]).toMatchObject({
      kind: "checked",
      check: {
        ok: true,
        revision: null,
        conformed: [{ field: "created", action: "default" }, { field: "Goals", action: "heading" }],
        frame: { contract: "sealed", folder: { path: "Projects", meaning: "project notes" }, template: { name: "project", meaning: "one project", requiredHeadings: ["Goals"] } },
      },
    });
    expect(checks[2]).toMatchObject({
      kind: "checked",
      check: { ok: true, violations: [], warnings: [{ field: "status", kind: "not-allowed" }], resolution: { action: "save", gaps: [{ axis: "value", kind: "kept", field: "status" }], wouldDraft: false } },
    });
    for (const check of checks) {
      expect(check.kind === "checked" ? check.check.contractRevision : null).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(updateIndex).not.toHaveBeenCalled();
    expect({ vault: await snapshot(fixture.vault), cache: await snapshot(cache), store: await snapshot(store) }).toEqual(before);
  });

  it("check mode diagnoses a cwd-inferred target without writing", async () => {
    const fixture = await sealedVault();
    const before = await snapshot(fixture.vault);
    const outcome = await runWritePipeline({ vault: fixture.vault, source: "cwd", path: "Projects/a.md", content: "x\n", check: true });
    expect(outcome).toMatchObject({ kind: "checked", check: { ok: true, revision: null } });
    expect(await snapshot(fixture.vault)).toEqual(before);
  });
});

/** One key per tier row: each is judged alone so a finding names exactly the row under test. */
const TIERS: VaultContract = {
  folders: { Notes: { meaning: "notes", searchExclude: false } },
  properties: {
    size: { meaning: "a count", type: "number", default: false, required: false, rules: [] },
    done: { meaning: "finished", type: "checkbox", default: false, required: false, rules: [] },
    topics: { meaning: "topics", type: "list", default: false, required: false, rules: [] },
    day: { meaning: "a day", type: "date", default: false, required: false, rules: [] },
    label: { meaning: "a label", type: "text", default: false, required: false, rules: [] },
    mood: { meaning: "a mood", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: ["Calm", "calm ", "Tense"] }] },
    kind: { meaning: "note kind", type: "text", default: false, required: true, rules: [{ kind: "fixed", value: "note" }] },
    code: { meaning: "a code", type: "text", default: false, required: false, rules: [{ kind: "pattern", regex: "^[A-Z]+$" }] },
    score: { meaning: "a score", type: "number", default: false, required: false, rules: [{ kind: "range", max: 10 }] },
    refs: { meaning: "references", type: "list", default: false, required: false, rules: [{ kind: "count", max: 2 }] },
    created: { meaning: "creation date", type: "date", default: true, required: false, rules: [] },
  },
  templates: {},
};

describe("runWritePipeline tiers (rows 14-23)", () => {
  async function write(content: string, notePath = "Notes/a.md") {
    const fixture = await sealedVault(TIERS);
    const outcome = await runWritePipeline(request(fixture, notePath, content), { now: () => NOW, updateIndex: async () => "skipped" });
    if (outcome.kind !== "written") throw new Error(`expected a save, got ${outcome.kind}`);
    const saved = await readFile(path.join(fixture.vault, notePath), "utf8");
    const gaps = openGaps((await readGapLedger(fixture.root, fixture.vaultId)).events);
    return { receipt: outcome.receipt, saved, gaps };
  }

  it("fixes \"12\" for a number key to 12 with one value/fixed gap that keeps the written value", async () => {
    const { receipt, saved, gaps } = await write("---\nkind: note\nsize: \"12\"\n---\nBody\n");
    expect(saved).toBe("---\nkind: note\nsize: 12\ncreated: 2026-09-28\n---\nBody\n");
    expect(receipt).toMatchObject({ warnings: [], fixes: [{ field: "size", kind: "type" }], gaps: [{ axis: "value", kind: "fixed", field: "size" }] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ axis: "value", kind: "fixed", wanted: { field: "size", value: "12" }, reason: "fixed: type" });
    expect(receipt.revision).toBe(sha256(saved));
  });

  it.each([
    ["a boolean string for a checkbox", "done: \"true\"", "done: true", "done"],
    ["a scalar for a list", "topics: ai", "topics: [ai]", "topics"],
    ["a midnight datetime for a date", "day: 2026-09-29T00:00", "day: 2026-09-29", "day"],
    ["a number for a text key", "label: 42", "label: \"42\"", "label"],
  ])("row 17: fixes %s", async (_name, written, expected, field) => {
    const { receipt, saved } = await write(`---\nkind: note\n${written}\n---\nBody\n`);
    expect(saved).toBe(`---\nkind: note\n${expected}\ncreated: 2026-09-28\n---\nBody\n`);
    expect(receipt).toMatchObject({ warnings: [], fixes: [{ field, kind: "type" }] });
  });

  it.each([
    ["a number string with trailing text", "size: 12a", "size"],
    ["a datetime with a time for a date", "day: 2026-09-29T10:00", "day"],
  ])("row 17: keeps %s as written", async (_name, written, field) => {
    const { receipt, saved, gaps } = await write(`---\nkind: note\n${written}\n---\nBody\n`);
    expect(saved).toBe(`---\nkind: note\n${written}\ncreated: 2026-09-28\n---\nBody\n`);
    expect(receipt).toMatchObject({ warnings: [{ field, kind: "type" }], fixes: [] });
    expect(gaps[0]).toMatchObject({ axis: "value", kind: "kept", reason: "kept: type" });
  });

  it("row 18: fixes a spelling that matches one allowed value and keeps one that matches two", async () => {
    const one = await write("---\nkind: note\nmood: TENSE\n---\nBody\n");
    expect(one.saved).toBe("---\nkind: note\nmood: Tense\ncreated: 2026-09-28\n---\nBody\n");
    expect(one.receipt).toMatchObject({ warnings: [], fixes: [{ field: "mood", kind: "not-allowed" }] });
    expect(one.gaps[0]).toMatchObject({ kind: "fixed", wanted: { field: "mood", value: "TENSE" }, reason: "fixed: not-allowed" });
    const two = await write("---\nkind: note\nmood: CALM\n---\nBody\n");
    expect(two.saved).toBe("---\nkind: note\nmood: CALM\ncreated: 2026-09-28\n---\nBody\n");
    expect(two.receipt).toMatchObject({ warnings: [{ field: "mood", kind: "not-allowed" }], fixes: [] });
    expect(two.gaps[0]).toMatchObject({ kind: "kept", reason: "kept: not-allowed" });
  });

  it("row 16: fills a missing required key with its fixed value", async () => {
    const { receipt, saved, gaps } = await write("Body\n");
    expect(saved).toBe("---\ncreated: 2026-09-28\nkind: note\n---\nBody\n");
    expect(receipt).toMatchObject({ warnings: [], fixes: [{ field: "kind", kind: "missing" }] });
    expect(gaps[0]).toMatchObject({ axis: "property", kind: "fixed", reason: "fixed: missing" });
  });

  it.each([
    ["row 19: a value other than the fixed one", "kind: other", "kind", "not-fixed"],
    ["row 20: a value outside the pattern", "code: abc", "code", "pattern"],
    ["row 21: a value outside the range", "score: 11", "score", "range"],
    ["row 22: a list over its count", "refs:\n  - a\n  - b\n  - c", "refs", "count"],
  ])("%s is saved as written and recorded as kept", async (_name, written, field, kind) => {
    const head = field === "kind" ? "" : "kind: note\n";
    const { receipt, saved, gaps } = await write(`---\n${head}${written}\n---\nBody\n`);
    expect(saved).toBe(`---\n${head}${written}\ncreated: 2026-09-28\n---\nBody\n`);
    expect(receipt).toMatchObject({ warnings: [{ field, kind }], fixes: [] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "kept", reason: `kept: ${kind}` });
  });

  it("rows 9 and 15: an unknown key in an unregistered folder is saved verbatim with one property/kept", async () => {
    const { receipt, saved, gaps } = await write("---\nkind: note\nextra: \"  as written \"\n---\nBody\n", "Loose/a.md");
    expect(saved).toBe("---\nkind: note\nextra: \"  as written \"\ncreated: 2026-09-28\n---\nBody\n");
    expect(receipt).toMatchObject({ fixes: [] });
    expect(gaps.map(gap => [gap.axis, gap.kind, gap.wanted.field])).toEqual([["folder", "kept", "path"], ["property", "kept", "extra"]]);
  });

  it("row 14: fills a known template variable in the frontmatter before the judge", async () => {
    const { receipt, saved } = await write("---\nkind: note\nlabel: \"{{title}}\"\n---\nBody\n");
    expect(saved).toBe("---\nkind: note\nlabel: \"a\"\ncreated: 2026-09-28\n---\nBody\n");
    expect(receipt).toMatchObject({ warnings: [], fixes: [] });
  });
});
