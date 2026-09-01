import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceSignature } from "../../../kernel/templates/resolver.js";
import type { Digest } from "../../../kernel/templates/types.js";
import { auditNote } from "./post-tool-use.js";

const roots: string[] = [];
const sha = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

async function vault(notes: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-claude-hook-"));
  roots.push(root);
  await Promise.all([".oms", ".obsidian", "Templates", "notes"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  const policy = `${JSON.stringify({ version: 1, templateFolder: "Templates", base: { fields: {} }, contracts: { note: { intent: "note", fields: { title: { required: true, type: "text" } }, views: [] } }, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/note.md", contract: "note", naming: "{{slug}}.md" } } })}\n`;
  const taxonomy = JSON.stringify({ folders: { notes: { template: "note" } } });
  const obsidian = "{\"title\":\"text\"}\n";
  const template = "---\ntitle: template\n---\nbody\n";
  const descriptors = [{ logicalId: "template-policy", signature: sha(policy) }, { logicalId: "taxonomy", signature: sha(taxonomy) }, { logicalId: "obsidian-types", signature: sha(obsidian) }, { path: "Templates/note.md", signature: sha(template) }];
  const projection = `${JSON.stringify({ version: "oms.types.v1", generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(descriptors), sources: descriptors }, managed: { base: { fields: {} }, globalAxes: {}, templates: { note: { templateId: "note", destinationClass: "managed-default", sourcePath: "Templates/note.md", targetFolder: "notes", keyOrder: ["title"], fields: { title: { required: true, type: "text" } }, views: [], naming: "{{slug}}.md", bodySignature: sha("body\n") } } } }, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(root, ".oms", "template-policy.json"), policy, "utf8"),
    writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy, "utf8"),
    writeFile(path.join(root, ".oms", "types.json"), projection, "utf8"),
    writeFile(path.join(root, ".obsidian", "types.json"), obsidian, "utf8"),
    writeFile(path.join(root, "Templates", "note.md"), template, "utf8"),
    ...Object.entries(notes).map(([relative, content]) => writeFile(path.join(root, relative), content, "utf8")),
  ]);
  return root;
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return result;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Claude PostToolUse template audit", () => {
  it("is read-only across the whole vault tree", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    const before = await tree(root);

    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([]);

    expect(await tree(root)).toEqual(before);
  });

  it("accepts a note with a valid stable template ID", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([]);
  });

  it("warns for a legacy concept-only note without falling back", async () => {
    const root = await vault({ "notes/one.md": "---\nconcept: note\ntitle: One\n---\nBody\n" });
    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([
      expect.stringContaining("legacy concept-only frontmatter"),
    ]);
  });

  it("guides doctor operations for a managed template source", async () => {
    const root = await vault();
    await expect(auditNote(root, "Templates/note.md")).resolves.toEqual([
      expect.stringContaining("validate"),
    ]);
  });

  it("reports a malformed projection without throwing", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await writeFile(path.join(root, ".oms", "types.json"), "{", "utf8");

    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([
      expect.stringContaining("Cannot read the resolved template projection"),
    ]);
  });

  it("never creates a graph cache", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await auditNote(root, "notes/one.md");

    await expect(readFile(path.join(root, ".oms", "cache", "graph.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
