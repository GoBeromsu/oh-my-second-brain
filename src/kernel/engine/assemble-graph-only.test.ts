import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeContractVault } from "../contract/contract-vault-fixture.js";
import { assembleGraphOnlyEngine } from "./assemble.js";

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

async function freshVault(): Promise<string> {
  const vault = mkdtempSync(path.join(tmpdir(), "oms-graph-only-"));
  tempDirs.push(vault);
  // The sealed contract (in the isolated test HOME store) is what the template axis reads.
  await writeContractVault(vault, {
    properties: { status: { type: "text", intent: "Workflow state." } },
    templates: { note: { fields: ["status"], optionalFields: ["status"], targetFolder: "notes", approvedMarkdown: "---\ntemplate: note\nstatus: active\n---\n\n## Summary\n" } },
    folders: { notes: { intent: "Ordinary notes." } },
    obsidianTypes: { status: "text" },
    notes: {
      "notes/alpha.md": "---\ntemplate: note\nstatus: active\n---\nAlpha links [[beta]].\n",
      "notes/beta.md": "---\ntemplate: note\nstatus: reference\n---\nBeta note.\n",
    },
  });
  return vault;
}

describe("assembleGraphOnlyEngine", () => {
  it("serves graph build and template-axis retrieval model-free", async () => {
    const vault = await freshVault();
    const engine = assembleGraphOnlyEngine({ vault });
    try {
      expect(engine.provider.model).toContain("deferred");
      expect((await engine.adapter.graphBuild({}, vault)).available).toBe(true);
      const result = await engine.adapter.retrieveByAxis({ template: "note", property: "status", value: "active" });
      expect(result.available).toBe(true);
      expect(result.hits.map(hit => hit.path)).toEqual(["notes/alpha.md"]);
    } finally { await engine.dispose(); }
  });

  it("guards semantic embedding paths", async () => {
    const engine = assembleGraphOnlyEngine({ vault: await freshVault() });
    try {
      await expect(engine.provider.embed("x")).rejects.toThrow(/unavailable/i);
      expect((await engine.syncVault()).available).toBe(false);
    } finally { await engine.dispose(); }
  });

  it("never constructs an injected reranker factory", async () => {
    const vault = await freshVault();
    let constructions = 0;
    const engine = assembleGraphOnlyEngine({
      vault,
      rerankerFactory: () => {
        constructions += 1;
        throw new Error("graph-only must not construct rerankers");
      },
    });
    try {
      await engine.adapter.graphBuild({}, vault);
      expect(constructions).toBe(0);
    } finally {
      await engine.dispose();
    }
  });
});
