import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceSignature } from "../templates/index.js";
import type { SourceDescriptor } from "../templates/types.js";
import { assembleGraphOnlyEngine } from "./assemble.js";

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });
const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function freshVault(): string {
  const vault = mkdtempSync(path.join(tmpdir(), "oms-graph-only-"));
  tempDirs.push(vault);
  for (const directory of [".oms", ".obsidian", "Templates/OMS", "notes"]) mkdirSync(path.join(vault, directory), { recursive: true });
  const policy = JSON.stringify({ version: 3, templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }], base: { fields: {} }, contracts: { note: { intent: "note", fields: { template: { type: "text", required: true }, status: { type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourceFolder: "Templates/OMS", sourcePath: "Templates/OMS/note.md", renderer: "obsidian-core", contract: "note", naming: "{{slug}}.md" } } });
  const taxonomy = JSON.stringify({ folders: {}, templates: { note: { templateFolder: "Inbox" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", status: "text" } });
  const template = "---\ntemplate: note\nstatus: active\n---\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [{ logicalId: "template-policy", signature: digest(policy) }, { logicalId: "taxonomy", signature: digest(taxonomy) }, { logicalId: "obsidian-types", signature: digest(obsidianTypes) }, { path: "Templates/OMS/note.md", signature: digest(template) }];
  const projection = JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/OMS/note.md", renderer: "obsidian-core", targetFolder: "Inbox", keyOrder: ["template", "status"], fields: { template: { type: "text", required: true }, status: { type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: digest("<!-- oms:content -->\n") } } } });
  writeFileSync(path.join(vault, ".oms/template-policy.json"), policy);
  writeFileSync(path.join(vault, ".oms/taxonomy.json"), taxonomy);
  writeFileSync(path.join(vault, ".oms/types.json"), projection);
  writeFileSync(path.join(vault, ".obsidian/types.json"), obsidianTypes);
  writeFileSync(path.join(vault, "Templates/OMS/note.md"), template);
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
