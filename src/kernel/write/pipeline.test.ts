import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTruthTableRow, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import type { VaultContract } from "../contract/types.js";
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
const ISOLATED = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OMS_RUNTIME_ROOT", "OMS_AUTO_UPDATE_STATE_DIR", "OMS_CLAUDE_HOME", "OMS_CODEX_HOME", "OMS_HERMES_HOME", "OMS_VAULT"];

const fixtures: TruthTableFixture[] = [];
const scratch: string[] = [];
let savedEnv: Record<string, string | undefined>;

async function sealedVault(): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow("sealed", CONTRACT);
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
    expect(outcome).toEqual({ kind: "denied", violations: [{ field: "ifMatch", kind: "unsupported-input" }] });
    expect(await readdir(path.join(fixture.vault))).not.toContain("Projects");
  });

  it("denies a note in an unregistered folder and leaves disk untouched", async () => {
    const fixture = await sealedVault();
    const before = await snapshot(fixture.vault);
    const outcome = await runWritePipeline(request(fixture, "Loose/a.md", "x\n"));
    expect(outcome).toMatchObject({ kind: "denied", violations: [{ field: "path", kind: "unregistered-folder" }] });
    expect(await snapshot(fixture.vault)).toEqual(before);
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

  it("still denies a value outside allowed after conform", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "---\nstatus: paused\n---\nBody\n"), { now: () => NOW });
    expect(outcome).toMatchObject({ kind: "denied", violations: [{ field: "status" }] });
    expect(await readdir(fixture.vault)).not.toContain("Projects");
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

  it("returns vanished when ifMatch is given for a note that does not exist", async () => {
    const fixture = await sealedVault();
    const outcome = await runWritePipeline(request(fixture, "Projects/a.md", "x\n", { ifMatch: sha256("x\n") }));
    expect(outcome).toEqual({ kind: "retry", state: "vanished" });
    expect(await readdir(fixture.vault)).not.toContain("Projects");
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
      check: { ok: true, path: "Projects/a.md", revision: sha256("---\nstatus: active\n---\nBody\n"), violations: [], conformed: [] },
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
    expect(checks[2]).toMatchObject({ kind: "checked", check: { ok: false, violations: [{ field: "status" }] } });
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
