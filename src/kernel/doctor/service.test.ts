import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCoreSemanticEngine } from "../engine/assemble.js";
import { repairDoctor } from "./service.js";

let roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-doctor-service-"));
  roots.push(vault);
  await mkdir(path.join(vault, ".oms", "concepts"), { recursive: true });
  await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), "version: 1\nfolders:\n  notes:\n    concept: note\n", "utf8");
  await writeFile(path.join(vault, ".oms", "concepts", "note.yaml"), "concept: note\nintent: Note\nfolder: notes\nfields: []\n", "utf8");
  await mkdir(path.join(vault, "notes"));
  await writeFile(path.join(vault, "notes", "note.md"), "# Indexed note\n", "utf8");
  return vault;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("doctor repair service", () => {
  it("rejects a cwd target before execution", async () => {
    const vault = await makeVault();
    const result = await repairDoctor({ operation: "build-graph", vault, source: "cwd" });
    expect(result).toMatchObject({ kind: "rejected", value: { status: "rejected", resolvedVault: vault, resolutionSource: "cwd", rejection: { code: "target-unverified" } } });
  });

  it("builds a graph and constructs its receipt from the persisted cache", async () => {
    const vault = await makeVault();
    const result = await repairDoctor({ operation: "build-graph", vault, source: "vault" });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const receipt = result.value["receipt"] as { postcondition: { cachePath: string; generatedAt: string; notes: number } };
    const cache = JSON.parse(await readFile(receipt.postcondition.cachePath, "utf8")) as { generatedAt: string; notes: unknown[] };
    expect(receipt.postcondition.generatedAt).toBe(cache.generatedAt);
    expect(receipt.postcondition.notes).toBe(cache.notes.length);
  });

  it("syncs and cleans the semantic index with read-back receipts", async () => {
    const vault = await makeVault();
    const engine = assembleCoreSemanticEngine({ vault });
    try {
      const sync = await repairDoctor({ operation: "sync-embeddings", vault, source: "vault", args: { embed: false }, adapter: engine.adapter });
      expect(sync.kind).toBe("completed");
      if (sync.kind !== "completed") return;
      const syncReceipt = sync.value["receipt"] as { postcondition: { documentPaths: string[]; orphanDocumentPaths: string[] } };
      expect(syncReceipt.postcondition.documentPaths).toEqual(["notes/note.md"]);
      expect(syncReceipt.postcondition.orphanDocumentPaths).toEqual([]);

      await rm(path.join(vault, "notes", "note.md"));
      const cleanup = await repairDoctor({ operation: "semantic-cleanup", vault, source: "vault", adapter: engine.adapter });
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
