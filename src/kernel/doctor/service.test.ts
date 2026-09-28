import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleCoreSemanticEngine, assembleGraphOnlyEngine } from "../engine/assemble.js";
import * as engineStoreRepair from "../engine/embed/repair.js";
import { engineGraphCachePath, engineNodeCachePath, engineStorePath } from "../engine/paths.js";
import { writeContractVault } from "../contract/contract-vault-fixture.js";
import { appendLineageEvents, LINEAGE_FILE } from "../contract/lineage.js";
import { stateDir } from "../contract/state-dir.js";
import { sealContract, storeRoot, writeIndexEntry } from "../contract/store.js";
import * as lineageHealthModule from "../contract/lineage-health.js";
import { lineageHealth, type LineageHealth } from "../contract/lineage-health.js";
import type { VaultContract } from "../contract/types.js";
import * as vaultIdModule from "../contract/vault-id.js";
import { resolveSealState } from "../contract/vault-id.js";
import { serializeVaultSettings } from "../vault/settings.js";
import { syncEngineStore } from "../engine/embed/sync.js";
import { listDirtyQueue, updateKeywordIndex } from "../engine/index-update.js";
import { repairDoctor } from "./service.js";

let roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-doctor-service-"));
  roots.push(vault);
  await writeContractVault(vault, {
    properties: { title: { type: "text", intent: "Note title." } },
    templates: {
      note: {
        fields: ["title"],
        approvedMarkdown: "---\ntemplate: note\ntitle: Untitled\n---\n\nBody\n",
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Notes." } },
    obsidianTypes: { title: "text" },
    notes: { "notes/note.md": "---\ntemplate: note\ntitle: Indexed note\n---\n# Indexed note\n" },
  });
  return vault;
}
async function seedCorruptStore(vault: string, contents: string | Buffer = "corrupt engine store"): Promise<string> {
  const storePath = engineStorePath(vault);
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, contents);
  return storePath;
}
async function relativeTree(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(absolute);
      else found.push(relative);
    }
  };
  await visit(root);
  return found.sort();
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("doctor repair service", () => {
  it("rejects a cwd target before execution", async () => {
    const vault = await makeVault();
    const result = await repairDoctor({ operation: "build-graph", vault, source: "cwd" });
    expect(result).toMatchObject({ kind: "rejected", value: { status: "rejected", resolvedVault: vault, resolutionSource: "cwd", rejection: { code: "target-unverified" } } });
  });

  it("never resolves the adapter when admission rejects the target", async () => {
    // Constructing a semantic adapter opens - and creates - the engine store, so
    // it is a disk mutation. The verified-target contract requires admission to
    // be the FIRST effectful step, which is why the dependency is a factory
    // rather than a value: an argument expression is evaluated before the
    // callee runs, so passing a built adapter would mutate a vault we are about
    // to reject.
    const vault = await makeVault();
    let resolved = 0;

    const result = await repairDoctor({
      operation: "semantic-cleanup",
      vault,
      source: "cwd",
      resolveAdapter: () => {
        resolved += 1;
        throw new Error("adapter must not be constructed before admission");
      },
    });

    expect(result).toMatchObject({ kind: "rejected", value: { status: "rejected" } });
    expect(resolved, "adapter factory was invoked despite a rejected target").toBe(0);
  });

  it("rejects repair-index cwd targets before touching a corrupt store", async () => {
    const vault = await makeVault();
    const corrupt = Buffer.from("not a sqlite database");
    const storePath = await seedCorruptStore(vault, corrupt);

    const result = await repairDoctor({
      operation: "repair-index",
      vault,
      source: "cwd",
      args: { repairMode: "rebuild" },
      resolveAdapter: () => {
        throw new Error("repair-index must never construct an adapter");
      },
    });

    expect(result).toMatchObject({ kind: "rejected", value: { rejection: { code: "target-unverified" } } });
    expect(await readFile(storePath)).toEqual(corrupt);
  });

  it("rebuilds a corrupt engine store and returns schema and integrity readback", async () => {
    const vault = await makeVault();
    const storePath = await seedCorruptStore(vault);

    const result = await repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args: { repairMode: "rebuild" },
      resolveAdapter: () => {
        throw new Error("repair-index must never construct an adapter");
      },
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.value).toMatchObject({
      mode: "rebuild",
      storePath,
      dryRun: false,
      resolvedVault: vault,
      resolutionSource: "vault",
      receipt: {
        operation: "repair-index",
        written: { paths: expect.arrayContaining([storePath]) },
        postcondition: {
          kind: "engine-store",
          mode: "rebuild",
          databasePath: storePath,
          integrity: "ok",
          tables: expect.arrayContaining(["engine_meta", "engine_chunk_meta", "engine_chunk_fts"]),
        },
      },
    });
    await expect(stat(result.value["backupPath"] as string)).resolves.toBeDefined();
  });

  it("drops the engine store and sidecars while preserving all three backups", async () => {
    const vault = await makeVault();
    const storePath = await seedCorruptStore(vault);
    await Promise.all([
      writeFile(`${storePath}-wal`, "wal"),
      writeFile(`${storePath}-shm`, "shm"),
    ]);

    const result = await repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args: { repairMode: "drop" },
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const receipt = result.value["receipt"] as {
      postcondition: { absentPaths: string[]; backupPaths: string[] };
    };
    expect(receipt.postcondition.absentPaths).toEqual([storePath, `${storePath}-wal`, `${storePath}-shm`]);
    expect(receipt.postcondition.backupPaths).toHaveLength(3);
    for (const sourcePath of receipt.postcondition.absentPaths) await expect(stat(sourcePath)).rejects.toThrow();
    for (const backupPath of receipt.postcondition.backupPaths) await expect(stat(backupPath)).resolves.toBeDefined();
  });

  it("reports a dry-run plan without changes or a fabricated repaired postcondition", async () => {
    const vault = await makeVault();
    const corrupt = Buffer.from("corrupt engine store");
    const storePath = await seedCorruptStore(vault, corrupt);

    const result = await repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args: { repairMode: "rebuild", dryRun: true },
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(await readFile(storePath)).toEqual(corrupt);
    expect(result.value).toMatchObject({
      mode: "rebuild",
      dryRun: true,
      receipt: { operation: "repair-index", written: { paths: [] } },
    });
    expect((result.value["receipt"] as { postcondition?: unknown }).postcondition).toBeUndefined();
  });

  it.each([
    undefined,
    {},
    { repairMode: "force" },
    { repairMode: "rebuild", dryRun: "yes" },
    { repairMode: "drop", extra: true },
  ])("rejects invalid repair-index arguments %#", async (args) => {
    const vault = await makeVault();
    await expect(repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args,
    })).rejects.toThrow('Doctor repair "repair-index"');
  });

  it("does not return a success receipt when rebuilt-store readback fails", async () => {
    const vault = await makeVault();
    const storePath = await seedCorruptStore(vault);
    const actualRepair = engineStoreRepair.repairEngineStore;
    vi.spyOn(engineStoreRepair, "repairEngineStore").mockImplementation((options) => {
      const plan = actualRepair(options);
      rmSync(plan.storePath);
      return plan;
    });

    await expect(repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args: { repairMode: "rebuild" },
    })).rejects.toThrow("Engine store repair postcondition failed");
  });

  it("builds a graph and constructs its receipt from the persisted cache", async () => {
    const vault = await makeVault();
    const engine = assembleGraphOnlyEngine({ vault });
    try {
      const result = await repairDoctor({ operation: "build-graph", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      const receipt = result.value["receipt"] as { postcondition: { kind: string; cachePaths: string[]; generatedAt: string; notes: number; edges: number } };
      expect(receipt.postcondition.kind).toBe("template-graph-cache");
      expect(receipt.postcondition.cachePaths).toHaveLength(2);
      for (const cachePath of receipt.postcondition.cachePaths) expect((await readFile(cachePath)).byteLength).toBeGreaterThan(0);
      expect(receipt.postcondition.notes).toBe(1);
    } finally {
      await engine.dispose();
    }
  });

  it("syncs and cleans the semantic index with read-back receipts", async () => {
    const vault = await makeVault();
    const engine = assembleCoreSemanticEngine({ vault });
    try {
      const sync = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", args: { embed: false }, resolveAdapter: () => engine.adapter });
      expect(sync.kind).toBe("completed");
      if (sync.kind !== "completed") return;
      const syncReceipt = sync.value["receipt"] as { postcondition: { documentPaths: string[]; orphanDocumentPaths: string[] } };
      expect(syncReceipt.postcondition.documentPaths).toEqual(["notes/note.md"]);
      expect(syncReceipt.postcondition.orphanDocumentPaths).toEqual([]);

      await rm(path.join(vault, "notes", "note.md"));
      const cleanup = await repairDoctor({ operation: "semantic-cleanup", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(cleanup.kind).toBe("completed");
      if (cleanup.kind !== "completed") return;
      const cleanupReceipt = cleanup.value["receipt"] as { postcondition: { documentPaths: string[]; orphanDocumentPaths: string[] } };
      expect(cleanupReceipt.postcondition.documentPaths).toEqual([]);
      expect(cleanupReceipt.postcondition.orphanDocumentPaths).toEqual([]);
    } finally {
      await engine.dispose();
    }
  });
  it("reports external graph and node receipts that exist after repair", async () => {
    const vault = await makeVault();
    const graphPath = engineGraphCachePath(vault);
    const nodePath = engineNodeCachePath(vault);
    const engine = assembleGraphOnlyEngine({ vault });
    try {
      const result = await repairDoctor({ operation: "build-graph", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      const receipt = result.value["receipt"] as { written: { paths: string[] }; postcondition: { cachePaths: string[] } };
      expect(receipt.postcondition.cachePaths).toEqual([graphPath, nodePath]);
      expect(receipt.written.paths).toEqual([graphPath, nodePath]);
      expect(result.value["cachePaths"]).toEqual([graphPath, nodePath]);
      for (const cachePath of [graphPath, nodePath]) {
        expect(contained(vault, cachePath)).toBe(false);
        expect((await readFile(cachePath)).byteLength).toBeGreaterThan(0);
      }
      await expect(access(path.join(vault, ".oms", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await engine.dispose();
    }
  });

  it("keeps repair, drop, and backup paths on the external engine store", async () => {
    const vault = await makeVault();
    const storePath = await seedCorruptStore(vault);
    expect(contained(vault, storePath)).toBe(false);
    await Promise.all([
      writeFile(`${storePath}-wal`, "wal"),
      writeFile(`${storePath}-shm`, "shm"),
    ]);
    const before = await relativeTree(vault);

    const result = await repairDoctor({
      operation: "repair-index",
      vault,
      source: "vault",
      args: { repairMode: "drop" },
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.value["storePath"]).toBe(storePath);
    expect(String(result.value["backupPath"])).toContain(`${storePath}.backup-`);
    const receipt = result.value["receipt"] as { postcondition: { absentPaths: string[]; backupPaths: string[] } };
    expect(receipt.postcondition.absentPaths).toEqual([storePath, `${storePath}-wal`, `${storePath}-shm`]);
    expect(receipt.postcondition.backupPaths.every((backupPath) => backupPath.startsWith(`${storePath}.backup-`))).toBe(true);
    for (const backupPath of receipt.postcondition.backupPaths) {
      expect(contained(vault, backupPath)).toBe(false);
      await expect(stat(backupPath)).resolves.toBeDefined();
    }
    expect(await relativeTree(vault)).toEqual(before);
  });

  it("creates no external or vault artifacts when admission rejects the target", async () => {
    const vault = await makeVault();
    const before = await relativeTree(vault);
    const externalBefore = await relativeTree(path.dirname(engineStorePath(vault)));
    let resolved = 0;

    const result = await repairDoctor({
      operation: "build-graph",
      vault,
      source: "cwd",
      resolveAdapter: () => {
        resolved += 1;
        throw new Error("adapter must not be constructed before admission");
      },
    });

    expect(result).toMatchObject({ kind: "rejected", value: { rejection: { code: "target-unverified" } } });
    expect(resolved).toBe(0);
    expect(await relativeTree(vault)).toEqual(before);
    expect(await relativeTree(path.dirname(engineStorePath(vault)))).toEqual(externalBefore);
    await expect(access(engineStorePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(engineGraphCachePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(engineNodeCachePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(vault, ".oms", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(vault, ".oms", "engine-store.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("doctor sync-embeddings drains the write queue", () => {
  async function queuedVault(): Promise<string> {
    const vault = await makeVault();
    expect((await syncEngineStore({ vault, embed: false })).available).toBe(true);
    expect(await updateKeywordIndex({ vault, relPath: "notes/note.md" })).toBe("updated");
    expect(listDirtyQueue(engineStorePath(vault))).toEqual(["notes/note.md"]);
    return vault;
  }

  it("dequeues notes the embedding sync re-embedded and reports the counts", async () => {
    const vault = await queuedVault();
    const engine = assembleCoreSemanticEngine({ vault });
    try {
      // A lexical pass rewrites the re-marked digests, which is what a real re-embed leaves behind.
      const sync = vi.spyOn(engine.adapter, "syncEmbeddings").mockImplementation(async options => ({ ...(await syncEngineStore({ ...options, embed: false })), available: true }));
      const result = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ kind: "completed", value: { queue: { drained: 1, pending: 0 } } });
      expect(listDirtyQueue(engineStorePath(vault))).toEqual([]);
    } finally {
      await engine.dispose();
    }
  });

  it("keeps a note queued when the sync did not re-embed it", async () => {
    const vault = await queuedVault();
    const engine = assembleCoreSemanticEngine({ vault });
    try {
      vi.spyOn(engine.adapter, "syncEmbeddings").mockImplementation(async options => ({
        available: true, collection: "vault", dbPath: engineStorePath(options.vault), scanned: 0, added: 0, updated: 0, skipped: 0,
      }));
      const result = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(result).toMatchObject({ kind: "completed", value: { queue: { drained: 0, pending: 1 } } });
      expect(listDirtyQueue(engineStorePath(vault))).toEqual(["notes/note.md"]);
    } finally {
      await engine.dispose();
    }
  });

  it("leaves the queue alone for a lexical-only sync or an unavailable embedder", async () => {
    const vault = await queuedVault();
    const engine = assembleCoreSemanticEngine({ vault });
    try {
      const lexical = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", args: { embed: false }, resolveAdapter: () => engine.adapter });
      expect(lexical.kind).toBe("completed");
      if (lexical.kind === "completed") expect(lexical.value).not.toHaveProperty("queue");
      expect(listDirtyQueue(engineStorePath(vault))).toEqual(["notes/note.md"]);

      vi.spyOn(engine.adapter, "syncEmbeddings").mockImplementation(async options => ({
        available: false, reason: "no provider", collection: "vault", dbPath: engineStorePath(options.vault), scanned: 0, added: 0, updated: 0, skipped: 0,
      }));
      const unavailable = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", resolveAdapter: () => engine.adapter });
      expect(unavailable).toMatchObject({ kind: "completed", value: { available: false } });
      expect(listDirtyQueue(engineStorePath(vault))).toEqual(["notes/note.md"]);
    } finally {
      await engine.dispose();
    }
  });
});

describe("doctor lineage repairs", () => {
  const FOREIGN = `sha256:${"e".repeat(64)}` as const;
  const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "oms-doctor-lineage-home-")));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
  });

  afterEach(async () => {
    process.env["HOME"] = saved.HOME;
    process.env["USERPROFILE"] = saved.USERPROFILE;
    await rm(home, { recursive: true, force: true });
  });

  async function sealedVault(): Promise<{ vault: string; id: string; digest: string }> {
    const vault = await makeVault();
    const state = await resolveSealState(vault);
    if (state.row !== "sealed" || state.vaultId === null) throw new Error(`fixture vault is ${state.row}`);
    const lineage = (await readFile(path.join(stateDir(storeRoot(), state.vaultId), "lineage", LINEAGE_FILE), "utf8")).trim().split("\n");
    return { vault, id: state.vaultId, digest: (JSON.parse(lineage.at(-1)!) as { digest: string }).digest };
  }

  it("refuses a vault whose contract is not sealed", async () => {
    const { vault, id } = await sealedVault();
    await rm(path.join(storeRoot(), id));
    for (const operation of ["lineage-recover", "lineage-reanchor"] as const) {
      expect(await repairDoctor({ operation, vault, source: "vault", args: undefined })).toEqual({ kind: "error", message: expect.stringMatching(/^CONTRACT_NOT_SEALED: /) });
    }
  });

  it("rejects a cwd target before reading the store", async () => {
    const { vault } = await sealedVault();
    expect(await repairDoctor({ operation: "lineage-recover", vault, source: "cwd", args: undefined })).toMatchObject({ kind: "rejected", value: { rejection: { code: "target-unverified" } } });
  });

  it("records a lost lineage and recreated snapshots with a read-back receipt", async () => {
    const { vault, id, digest } = await sealedVault();
    const state = stateDir(storeRoot(), id);
    await rm(path.join(state, "lineage", LINEAGE_FILE));
    await rm(path.join(state, "generations"), { recursive: true });
    const result = await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined });
    expect(result).toMatchObject({
      kind: "completed",
      value: {
        snapshots: 1,
        anchors: [{ eventSeq: 1, reason: "bootstrap", digest }],
        receipt: {
          operation: "lineage-recover", resolvedVault: vault, resolutionSource: "vault",
          written: { paths: ["lineage/events.jsonl", "generations/"], summary: { snapshots: 1, anchors: 1 } },
          postcondition: { kind: "contract-lineage", events: 1, snapshots: 1 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it("reports nothing written for a current lineage", async () => {
    const { vault } = await sealedVault();
    expect(await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).toMatchObject({
      kind: "completed",
      value: { snapshots: 0, anchors: [], receipt: { written: { paths: [], summary: { snapshots: 0, anchors: 0 } }, postcondition: { events: 1, snapshots: 1 } } },
    });
  });

  it("leaves a gap to lineage-reanchor and anchors it there", async () => {
    const { vault, id, digest } = await sealedVault();
    await appendLineageEvents(storeRoot(), id, [{ kind: "sealed", generation: 99, parentDigest: digest as typeof FOREIGN, digest: FOREIGN, mutations: [], manifestDigests: {} }]);
    const lineage = path.join(stateDir(storeRoot(), id), "lineage", LINEAGE_FILE);
    const before = await readFile(lineage, "utf8");
    expect(await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).toEqual({ kind: "error", message: expect.stringMatching(/^CONTRACT_LINEAGE_GAP: .*oms doctor lineage-reanchor/) });
    expect(await readFile(lineage, "utf8")).toBe(before);
    expect(await repairDoctor({ operation: "lineage-reanchor", vault, source: "vault", args: undefined })).toMatchObject({
      kind: "completed",
      value: { anchors: [{ eventSeq: 3, reason: "gap-anchor", digest }], receipt: { operation: "lineage-reanchor", written: { paths: ["lineage/events.jsonl"] }, postcondition: { events: 3 } } },
    });
  });

  it("names an unsafe store entry by its kind, never by its path", async () => {
    const { vault, id } = await sealedVault();
    const state = stateDir(storeRoot(), id);
    await chmod(state, 0o777);
    try {
      const result = await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined });
      expect(result).toEqual({ kind: "error", message: "STATE_DIR_UNSAFE: the contract store holds an unsafe entry (shared-writable); it was left untouched" });
    } finally {
      await chmod(state, 0o700);
    }
  });

  /** A first seal whose lineage append failed: linked, but never indexed (F1). */
  async function unindexedFirstSeal(): Promise<{ vault: string; id: string }> {
    const vault = path.join(home, "vault");
    const id = randomUUID();
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: id, templateFolder: "Templates" }));
    const contract: VaultContract = { folders: { notes: { meaning: "Notes.", searchExclude: false } }, properties: {}, templates: {} };
    await expect(sealContract({ vaultRealPath: await realpath(vault), vaultId: id, contract, onSealed: async () => { throw new Error("disk full"); } }))
      .rejects.toMatchObject({ code: "CONTRACT_LINEAGE_APPEND_FAILED", seq: 1 });
    return { vault, id };
  }

  async function expectRecoveredSeal(vault: string, id: string, result: Awaited<ReturnType<typeof repairDoctor>>): Promise<void> {
    expect(result).toMatchObject({ kind: "completed", value: { receipt: { operation: "lineage-recover", written: { paths: expect.arrayContaining(["index.json", "lineage/events.jsonl"]) } } } });
    expect((await resolveSealState(vault)).row).toBe("sealed");
    const index = JSON.parse(await readFile(path.join(storeRoot(), "index.json"), "utf8")) as { vaults: Record<string, string> };
    expect(index.vaults[await realpath(vault)]).toBe(id);
    expect((await lineageHealth(id)).findings.map(finding => finding.kind)).toEqual([]);
    expect(await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).toMatchObject({
      kind: "completed", value: { snapshots: 0, anchors: [], receipt: { written: { paths: [] } } },
    });
  }

  it("completes a first seal whose lineage append failed: reindexes, records the lineage, reads sealed", async () => {
    const { vault, id } = await unindexedFirstSeal();
    expect((await resolveSealState(vault)).row).toBe("store-without-index");
    await expectRecoveredSeal(vault, id, await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined }));
  });

  it("completes such a seal when the vault also reads as moved", async () => {
    const { vault, id } = await unindexedFirstSeal();
    const old = path.join(home, "old-vault");
    await mkdir(old);
    await writeIndexEntry(await realpath(old), id);
    expect((await resolveSealState(vault)).row).toBe("vault-moved");
    await expectRecoveredSeal(vault, id, await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined }));
  });

  it("refuses an unindexed vault whose store is missing", async () => {
    const vault = path.join(home, "unsealed");
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: randomUUID(), templateFolder: "Templates" }));
    expect(await repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).toEqual({ kind: "error", message: expect.stringMatching(/^CONTRACT_NOT_SEALED: /) });
    expect(await access(path.join(storeRoot(), "index.json")).then(() => true, () => false)).toBe(false);
  });

  it("throws when an unrecorded seal survives the repair (postcondition)", async () => {
    const { vault } = await sealedVault();
    const spy = vi.spyOn(lineageHealthModule, "lineageHealth").mockResolvedValue({ events: 1, snapshots: 1, snapshotBytes: 0, findings: [{ kind: "lineage-gap", detail: "left", recovery: null }] } as unknown as LineageHealth);
    try {
      await expect(repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).rejects.toThrow("Contract lineage postcondition failed: lineage-gap remains.");
    } finally {
      spy.mockRestore();
    }
  });

  it("throws when the vault does not read as sealed after the repair (postcondition)", async () => {
    const { vault } = await unindexedFirstSeal();
    const actual = vaultIdModule.resolveSealState;
    let calls = 0;
    const spy = vi.spyOn(vaultIdModule, "resolveSealState").mockImplementation(async (...args) => {
      const state = await actual(...args);
      calls += 1;
      return calls === 1 ? state : { ...state, row: "index-corrupt" };
    });
    try {
      await expect(repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).rejects.toThrow("Contract lineage postcondition failed: the vault reads as index-corrupt, not sealed.");
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a store failure that carries no contract code", async () => {
    const { vault, id } = await sealedVault();
    const generations = path.join(stateDir(storeRoot(), id), "generations");
    await chmod(generations, 0o300);
    try {
      await expect(repairDoctor({ operation: "lineage-recover", vault, source: "vault", args: undefined })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(generations, 0o700);
    }
  });
});
