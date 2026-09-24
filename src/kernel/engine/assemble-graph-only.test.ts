import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestBytes } from "../templates/canonical.js";
import { serializeContractPolicyV5 } from "../templates/contract-v5.js";
import { assembleGraphOnlyEngine } from "./assemble.js";

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function freshVault(): string {
  const vault = mkdtempSync(path.join(tmpdir(), "oms-graph-only-"));
  tempDirs.push(vault);
  for (const directory of [".oms/templates", ".obsidian", "notes"]) mkdirSync(path.join(vault, directory), { recursive: true });
  const templateSource = "---\ntemplate: note\nstatus: active\n---\n\n## Summary\n";
  const policy = serializeContractPolicyV5({
    version: 5,
    revision: 1,
    properties: { status: { type: "text", intent: "Workflow state." } },
    common: { status: "active", fields: {} },
    templates: {
      note: {
        status: "active",
        source: { identity: "source-note", path: "Templates/note.md", rawDigest: digestBytes(templateSource) },
        fields: { status: {} },
      },
    },
  });
  const taxonomy = JSON.stringify({ folders: { notes: { intent: "Ordinary notes." } }, templates: { note: { templateFolder: "notes" } } });
  const obsidianTypes = JSON.stringify({ types: { status: "text" } });
  mkdirSync(path.join(vault, "Templates"), { recursive: true });
  writeFileSync(path.join(vault, ".oms/template-policy.json"), policy);
  writeFileSync(path.join(vault, ".oms/taxonomy.json"), taxonomy);
  writeFileSync(path.join(vault, ".obsidian/types.json"), obsidianTypes);
  writeFileSync(path.join(vault, "Templates/note.md"), templateSource);
  writeFileSync(path.join(vault, "notes/alpha.md"), "---\ntemplate: note\nstatus: active\n---\nAlpha links [[beta]].\n");
  writeFileSync(path.join(vault, "notes/beta.md"), "---\ntemplate: note\nstatus: reference\n---\nBeta note.\n");
  return vault;
}

describe("assembleGraphOnlyEngine", () => {
  it("serves graph build and template-axis retrieval model-free", async () => {
    const vault = freshVault();
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
    const engine = assembleGraphOnlyEngine({ vault: freshVault() });
    try {
      await expect(engine.provider.embed("x")).rejects.toThrow(/unavailable/i);
      expect((await engine.syncVault()).available).toBe(false);
    } finally { await engine.dispose(); }
  });

  it("never constructs an injected reranker factory", async () => {
    const vault = freshVault();
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
