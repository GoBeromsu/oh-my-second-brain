import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { engineGraphCachePath, engineNodeCachePath, engineStorePath, vaultCacheRoot } from "../kernel/engine/paths.js";
import * as engineAssembly from "../kernel/engine/assemble.js";
import { writeApprovedVault } from "../kernel/templates/approved-vault-fixture.js";
import { runGraphCommand } from "./graph-command.js";
import { runStatusCommand } from "./status-command.js";

const roots: string[] = [];
const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function freshVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-graph-command-"));
  roots.push(vault);
  await writeApprovedVault(vault, {
    properties: { status: { type: "text", intent: "Workflow state." } },
    templates: {
      note: {
        fields: ["status"],
        optionalFields: ["status"],
        approvedMarkdown: "---\ntemplate: note\nstatus: active\n---\n\nBody\n",
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Notes." } },
    obsidianTypes: { status: "text" },
    notes: {
      "notes/alpha.md": "---\ntemplate: note\nstatus: active\n---\nAlpha links [[beta]].\n",
      "notes/beta.md": "---\ntemplate: note\nstatus: reference\n---\nBeta note.\n",
    },
  });
  return vault;
}

async function fileSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[`${child}/`] = "directory";
      Object.assign(result, await fileSnapshot(root, child));
    } else {
      result[child] = digest((await readFile(path.join(root, child))).toString("base64"));
    }
  }
  return result;
}

beforeEach(async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "oms-status-model-cache-"));
  roots.push(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubEnv("OMS_EMBEDDING_PROVIDER", undefined);
  vi.stubEnv("OMS_EMBEDDING_MODEL", undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph command", () => {
  it("keeps status read-only and delegates a real build to the verified doctor operation", async () => {
    const vault = await freshVault();
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    const before = await fileSnapshot(vault);
    const cacheRoot = vaultCacheRoot(vault);
    const externalBefore = existsSync(cacheRoot) ? await fileSnapshot(cacheRoot) : {};
    await runGraphCommand(["status", "--vault", vault]);
    expect(output.pop()).toEqual({ available: false, reason: "Graph cache not built" });
    expect(process.exitCode).toBe(1);
    expect(await fileSnapshot(vault)).toEqual(before);
    expect(existsSync(cacheRoot) ? await fileSnapshot(cacheRoot) : {}).toEqual(externalBefore);

    await runGraphCommand(["build", "--vault", vault]);
    const built = output.pop() as Record<string, unknown>;
    expect(built).toMatchObject({
      available: true,
      notes: 2,
      edges: 3,
      receipt: {
        operation: "build-graph",
        resolvedVault: vault,
        resolutionSource: "explicit",
        written: { summary: { notes: 2, edges: 3 } },
        postcondition: { kind: "template-graph-cache", notes: 2, edges: 3 },
      },
    });
    expect(process.exitCode).toBe(0);

    const afterBuild = await fileSnapshot(vault);
    await runGraphCommand(["status", "--vault", vault]);
    expect(output.pop()).toMatchObject({ available: true, notes: 2, edges: 3 });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(afterBuild);
    const externalAfter = await fileSnapshot(cacheRoot);
    expect(afterBuild).toEqual(before);
    expect(externalAfter).not.toEqual(externalBefore);
    expect(externalAfter).toHaveProperty(path.relative(vaultCacheRoot(vault), engineGraphCachePath(vault)));
    expect(externalAfter).toHaveProperty(path.relative(vaultCacheRoot(vault), engineNodeCachePath(vault)));
    expect(externalAfter).not.toHaveProperty(path.basename(engineStorePath(vault)));
  });

  it("reports current convention, runtime history, and ephemeral engine availability without a store", async () => {
    const vault = await freshVault();
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));
    const before = await fileSnapshot(vault);

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toMatchObject({
      vault,
      source: "explicit",
      convention: { templates: { note: {} } },
      history: { events: 0 },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false, reason: "Graph cache not built" },
    });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(before);
  });

  it("reports an absent convention and current read-only health without changing an empty vault", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-status-empty-"));
    roots.push(vault);
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));
    const before = await fileSnapshot(vault);

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toEqual({
      vault,
      source: "explicit",
      convention: {
        status: "absent",
        diagnostics: [{
          code: "TEMPLATE_POLICY_ABSENT",
          remediation: `No template convention exists at "${path.join(vault, ".oms", "template-policy.json")}".`,
        }],
      },
      history: {
        events: 0,
        uses: 0,
        verifications: 0,
        gaps: 0,
        templates: {},
      },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false, reason: "Graph cache not built" },
    });
    expect(process.exitCode).toBe(0);
    expect(await fileSnapshot(vault)).toEqual(before);
  });

  it("retains history, engine, and graph evidence when the convention is invalid", async () => {
    const vault = await freshVault();
    await writeFile(path.join(vault, ".oms", "template-policy.json"), "{");
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toMatchObject({
      vault,
      convention: { status: "invalid", diagnostics: [{ code: "CONTRACT_UNVERIFIABLE" }] },
      history: { events: 0 },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false },
    });
    expect(process.exitCode).toBe(0);
  });

  it("retains convention, engine, and graph evidence when runtime history is unavailable", async () => {
    const vault = await freshVault();
    const originalRuntimeRoot = process.env["OMS_RUNTIME_ROOT"];
    process.env["OMS_RUNTIME_ROOT"] = vault;
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));
    try {
      await runStatusCommand(["--vault", vault]);
    } finally {
      if (originalRuntimeRoot === undefined) delete process.env["OMS_RUNTIME_ROOT"];
      else process.env["OMS_RUNTIME_ROOT"] = originalRuntimeRoot;
    }

    expect(output.pop()).toMatchObject({
      vault,
      convention: { status: "approved", templates: { note: {} } },
      history: { status: "unavailable", diagnostics: [{ code: "LEDGER_ROOT_INSIDE_VAULT" }] },
      engine: { available: false, reason: "Engine store not found" },
      graph: { available: false },
    });
    expect(process.exitCode).toBe(0);
  });

  it("retains convention, history, and graph evidence when the engine store is invalid", async () => {
    const vault = await freshVault();
    mkdirSync(path.dirname(engineStorePath(vault)), { recursive: true });
    await writeFile(engineStorePath(vault), "not sqlite");
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toMatchObject({
      vault,
      convention: { status: "approved", templates: { note: {} } },
      history: { events: 0 },
      engine: {
        available: false,
        diagnostics: [{ code: expect.stringContaining("is corrupt or unreadable") }],
      },
      graph: { available: false },
    });
    expect(process.exitCode).toBe(0);
  });

  it("retains convention, history, and engine evidence when graph assembly fails", async () => {
    const vault = await freshVault();
    vi.spyOn(engineAssembly, "assembleGraphOnlyEngine").mockImplementation(() => {
      throw new Error("GRAPH_READ_FAILED: synthetic graph boundary failure");
    });
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    await runStatusCommand(["--vault", vault]);

    expect(output.pop()).toMatchObject({
      vault,
      convention: { status: "approved", templates: { note: {} } },
      history: { events: 0 },
      engine: { available: false, reason: "Engine store not found" },
      graph: {
        available: false,
        reason: "GRAPH_READ_FAILED: synthetic graph boundary failure",
        diagnostics: [{
          code: "GRAPH_READ_FAILED",
          remediation: "GRAPH_READ_FAILED: synthetic graph boundary failure",
        }],
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it("leaves the whole vault byte-identical while reading status from an active WAL store", async () => {
    const vault = await freshVault();
    await syncEngineStore({ vault, embed: false });
    const writer = new Database(engineStorePath(vault), { fileMustExist: true });
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.prepare("UPDATE engine_meta SET updated_at = ? WHERE id = 1").run(
        "2026-09-06T00:00:00.000Z",
      );
      const before = await fileSnapshot(vault);
      const storeRoot = path.dirname(engineStorePath(vault));
      const externalBefore = await fileSnapshot(storeRoot);
      expect(externalBefore).toHaveProperty(`${path.basename(engineStorePath(vault))}-wal`);
      expect(externalBefore).toHaveProperty(`${path.basename(engineStorePath(vault))}-shm`);
      const output: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

      await runStatusCommand(["--vault", vault]);

      expect(output.pop()).toMatchObject({
        vault,
        convention: { status: "approved", templates: { note: {} } },
        history: { events: 0 },
        engine: { available: true },
        graph: { available: false },
      });
      expect(process.exitCode).toBe(0);
      expect(await fileSnapshot(vault)).toEqual(before);
      expect(await fileSnapshot(storeRoot)).toEqual(externalBefore);
    } finally {
      writer.close();
    }
  });

  it("rejects unknown flags and does not invent a repair verb", async () => {
    const output: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(JSON.parse(String(value))));

    await runGraphCommand(["repair"]);

    expect(process.exitCode).toBe(1);
    expect(output.pop()).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "GRAPH_ARGS_INVALID" }],
    });
  });
});
