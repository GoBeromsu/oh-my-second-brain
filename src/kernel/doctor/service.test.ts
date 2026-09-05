import { rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleCoreSemanticEngine, assembleGraphOnlyEngine } from "../engine/assemble.js";
import * as engineStoreRepair from "../engine/embed/repair.js";
import { engineStorePath } from "../engine/paths.js";
import { sourceSignature } from "../templates/index.js";
import type { SourceDescriptor } from "../templates/types.js";
import { repairDoctor } from "./service.js";

let roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-doctor-service-"));
  roots.push(vault);
  await Promise.all([
    mkdir(path.join(vault, ".oms"), { recursive: true }),
    mkdir(path.join(vault, ".obsidian"), { recursive: true }),
    mkdir(path.join(vault, "Templates", "OMS"), { recursive: true }),
    mkdir(path.join(vault, "notes"), { recursive: true }),
  ]);
  const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], base: { fields: {} }, contracts: { note: { intent: "A note.", fields: { template: { type: "text", required: true }, title: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text" } });
  const template = "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: digest(policy) }, { logicalId: "taxonomy", signature: digest(taxonomy) }, { logicalId: "obsidian-types", signature: digest(obsidianTypes) }, { path: "Templates/OMS/note.md", signature: digest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", renderer: "obsidian-core", sourcePath: "Templates/OMS/note.md", targetFolder: "Inbox", keyOrder: ["template", "title"], fields: { template: { type: "text", required: true }, title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  await Promise.all([
    writeFile(path.join(vault, ".oms", "template-policy.json"), policy),
    writeFile(path.join(vault, ".oms", "taxonomy.json"), taxonomy),
    writeFile(path.join(vault, ".oms", "types.json"), projection),
    writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes),
    writeFile(path.join(vault, "Templates", "OMS", "note.md"), template),
    writeFile(path.join(vault, "notes", "note.md"), "---\ntemplate: note\ntitle: Indexed note\n---\n# Indexed note\n"),
  ]);
  return vault;
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
    const storePath = engineStorePath(vault);
    const corrupt = Buffer.from("not a sqlite database");
    await writeFile(storePath, corrupt);

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
    const storePath = engineStorePath(vault);
    await writeFile(storePath, "corrupt engine store");

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
    const storePath = engineStorePath(vault);
    await Promise.all([
      writeFile(storePath, "corrupt engine store"),
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
    const storePath = engineStorePath(vault);
    const corrupt = Buffer.from("corrupt engine store");
    await writeFile(storePath, corrupt);

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
    const storePath = engineStorePath(vault);
    await writeFile(storePath, "corrupt engine store");
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
});
