import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../../../kernel/templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection } from "../../../kernel/templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../../../kernel/templates/resolver.js";
import { auditNote } from "./post-tool-use.js";

const roots: string[] = [];
const encoder = new TextEncoder();
const TEMPLATE_MARKDOWN = "---\ntemplate: note\ntitle: template\n---\nbody\n";
const RAW_SOURCE = "<%* raw template %>\n";

function layer(templatePath: string, markdown: string, extra: Record<string, unknown> = {}) {
  return {
    templatePath,
    approvedMarkdown: markdown,
    approvedMarkdownDigest: digestBytes(markdown),
    fields: {},
    headings: [],
    semanticCriteria: [],
    ...extra,
  };
}

async function vault(notes: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oms-claude-hook-"));
  roots.push(root);
  await Promise.all([".oms/templates", ".obsidian", "Sources", "notes"].map(dir => mkdir(path.join(root, dir), { recursive: true })));
  const policy = JSON.stringify({
    version: 4,
    properties: { title: { type: "text", intent: "Note title." } },
    default: layer(".oms/templates/default.md", ""),
    templates: {
      note: layer(".oms/templates/note.md", TEMPLATE_MARKDOWN, {
        templateId: "note",
        fields: { title: { property: "title", required: true } },
        source: { path: "Sources/note.md", identity: "note-source", rawDigest: digestBytes(RAW_SOURCE) },
      }),
    },
  });
  const taxonomy = JSON.stringify({ templates: { note: { templateFolder: "notes" } }, folders: { notes: { intent: "Notes." } } });
  const obsidian = "{\"types\":{\"title\":\"text\"}}\n";
  const generationDigest = controlGenerationDigest(encoder.encode(policy), encoder.encode(taxonomy));
  await Promise.all([
    writeFile(path.join(root, ".oms", "template-policy.json"), policy, "utf8"),
    writeFile(path.join(root, ".oms", "taxonomy.json"), taxonomy, "utf8"),
    writeFile(path.join(root, ".oms", "types.json"), serializeDerivedProjection({
      version: "oms.types.v2",
      generatedFrom: generationDigest,
      managed: expectedProjectionManaged(parseTemplatePolicy(policy), taxonomyRouting(".oms/taxonomy.json", encoder.encode(taxonomy)), generationDigest),
    }), "utf8"),
    writeFile(path.join(root, ".oms", "templates", "default.md"), "", "utf8"),
    writeFile(path.join(root, ".oms", "templates", "note.md"), TEMPLATE_MARKDOWN, "utf8"),
    writeFile(path.join(root, ".obsidian", "types.json"), obsidian, "utf8"),
    writeFile(path.join(root, "Sources", "note.md"), RAW_SOURCE, "utf8"),
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

  it("accepts a note bound to a registered template", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([]);
  });

  it("accepts an unbound note under the always-on default layer", async () => {
    const root = await vault({ "notes/plain.md": "Ordinary note with no frontmatter.\n" });
    await expect(auditNote(root, "notes/plain.md")).resolves.toEqual([]);
  });

  it("reports a missing required field without repairing the note", async () => {
    const note = "---\ntemplate: note\n---\nBody\n";
    const root = await vault({ "notes/one.md": note });
    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([
      expect.stringContaining('does not yet satisfy template "note"'),
    ]);
    expect(await readFile(path.join(root, "notes", "one.md"), "utf8")).toBe(note);
  });

  it("rejects an unknown or non-string template identity without guessing one", async () => {
    const root = await vault({
      "notes/unknown.md": "---\ntemplate: ghost\n---\nBody\n",
      "notes/numeric.md": "---\ntemplate: 1\n---\nBody\n",
    });
    await expect(auditNote(root, "notes/unknown.md")).resolves.toEqual([
      expect.stringContaining('unknown template "ghost"'),
    ]);
    await expect(auditNote(root, "notes/numeric.md")).resolves.toEqual([
      expect.stringContaining("non-string template identity"),
    ]);
  });

  it("points a raw template source at contract review", async () => {
    const root = await vault();
    await expect(auditNote(root, "Sources/note.md")).resolves.toEqual([
      expect.stringContaining("oms template review"),
    ]);
  });

  it("reports an unreadable contract without throwing", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await writeFile(path.join(root, ".oms", "types.json"), "{", "utf8");

    await expect(auditNote(root, "notes/one.md")).resolves.toEqual([
      expect.stringContaining("Cannot read the approved contract"),
    ]);
  });

  it("never creates a graph cache", async () => {
    const root = await vault({ "notes/one.md": "---\ntemplate: note\ntitle: One\n---\nBody\n" });
    await auditNote(root, "notes/one.md");

    await expect(readFile(path.join(root, ".oms", "cache", "graph.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
