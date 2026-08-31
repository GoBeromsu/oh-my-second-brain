import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { composeSetup, decideNonInteractiveSetup, inspectSetup } from "../kernel/setup/service.js";
import { runSetup } from "./setup-command.js";

let vault: string | undefined;
afterEach(async () => { if (vault !== undefined) await rm(vault, { recursive: true, force: true }); vault = undefined; });
async function fresh(): Promise<string> { vault = await mkdtemp(path.join(tmpdir(), "oms-setup-")); return vault; }
async function authority(root: string): Promise<void> { await mkdir(path.join(root, ".obsidian"), { recursive: true }); await writeFile(path.join(root, ".obsidian", "types.json"), JSON.stringify({ types: { template: "string" } })); }
async function noteTemplate(root: string): Promise<void> { await mkdir(path.join(root, "Templates"), { recursive: true }); await writeFile(path.join(root, "Templates", "note.md"), "---\ntemplate: note\n---\nbody\n"); }

describe("template-first setup", () => {
  it("dry-runs empty discovery without mutation", async () => {
    const root = await fresh(); await authority(root);
    await runSetup({ vault: root, yes: true, dryRun: true });
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });
  it("fails loudly without Obsidian type authority", async () => {
    const root = await fresh(); await noteTemplate(root);
    await expect(runSetup({ vault: root, yes: true, dryRun: true })).rejects.toThrow("MIGRATION_CONTROL_MISSING");
  });
  it("requires a shown digest and publishes through the guarded transaction", async () => {
    const root = await fresh(); await authority(root); await noteTemplate(root);
    const state = await inspectSetup({ vault: root });
    const manifest = await composeSetup(await decideNonInteractiveSetup(state), { base: { fields: {} } });
    await expect(runSetup({ vault: root, yes: true })).rejects.toThrow("approvedDigest");
    let downloads = 0;
    await expect(runSetup({
      vault: root,
      yes: true,
      approvedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      embeddingDescriptor: {
        provider: "gguf",
        model: "test",
        filename: "test.gguf",
        url: "https://models.invalid/test.gguf",
        sha256: "0".repeat(64),
      },
      embeddingFetchImpl: async () => {
        downloads += 1;
        return new Response();
      },
    })).rejects.toThrow("MIGRATION_APPROVAL_MISMATCH");
    expect(downloads).toBe(0);
    await runSetup({ vault: root, yes: true, approvedDigest: manifest.approvalDigest });
    await expect(readFile(path.join(root, ".oms", "template-policy.json"), "utf8")).resolves.toContain("note");
    await expect(readFile(path.join(root, ".oms", "types.json"), "utf8")).resolves.toContain("oms.types.v1");
    await expect(readFile(path.join(root, ".oms", "template-migration.json"), "utf8")).resolves.toContain("complete");
    await runSetup({ vault: root, yes: true, approvedDigest: (await composeSetup(await decideNonInteractiveSetup(await inspectSetup({ vault: root })), { base: { fields: {} } })).approvalDigest });
  });

  it("given a configured template folder, when setup runs, then discovery and policy use it", async () => {
    const root = await fresh();
    await authority(root);
    await writeFile(
      path.join(root, ".obsidian", "types.json"),
      JSON.stringify({ types: { template: "string", title: "string" } }),
    );
    await mkdir(path.join(root, "Meta", "Templates"), { recursive: true });
    await writeFile(
      path.join(root, "Meta", "Templates", "custom.md"),
      "---\ntitle: Untitled\n---\n# Custom\n",
      "utf8",
    );
    const state = await inspectSetup({ vault: root, templateFolder: "Meta/Templates" });
    const manifest = await composeSetup(await decideNonInteractiveSetup(state), {
      base: { fields: {} },
    });

    await runSetup({
      vault: root,
      yes: true,
      templateFolder: "Meta/Templates",
      approvedDigest: manifest.approvalDigest,
    });

    await expect(
      readFile(path.join(root, ".oms", "template-policy.json"), "utf8"),
    ).resolves.toContain('"templateFolder": "Meta/Templates"');
  });
});
