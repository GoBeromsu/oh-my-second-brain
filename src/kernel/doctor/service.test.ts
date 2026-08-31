import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCoreSemanticEngine, assembleGraphOnlyEngine } from "../engine/assemble.js";
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
  const policy = JSON.stringify({ version: 1, templateFolder: "Templates/OMS", base: { fields: {} }, contracts: { note: { intent: "A note.", fields: { template: { type: "text", required: true }, title: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = "folders: {}\n";
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text" } });
  const template = "---\ntemplate: note\ntitle: Untitled\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: digest(policy) }, { logicalId: "taxonomy", signature: digest(taxonomy) }, { logicalId: "obsidian-types", signature: digest(obsidianTypes) }, { path: "Templates/OMS/note.md", signature: digest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", targetFolder: "Inbox", keyOrder: ["template", "title"], fields: { template: { type: "text", required: true }, title: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  await Promise.all([
    writeFile(path.join(vault, ".oms", "template-policy.json"), policy),
    writeFile(path.join(vault, ".oms", "taxonomy.yaml"), taxonomy),
    writeFile(path.join(vault, ".oms", "types.json"), projection),
    writeFile(path.join(vault, ".obsidian", "types.json"), obsidianTypes),
    writeFile(path.join(vault, "Templates", "OMS", "note.md"), template),
    writeFile(path.join(vault, "notes", "note.md"), "---\ntemplate: note\ntitle: Indexed note\n---\n# Indexed note\n"),
  ]);
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
