import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeResolvedTemplateNote } from "../src/kernel/capture/safe.js";
import {
  buildTemplateNoteIndex,
  loadResolvedTemplates,
  queryTemplateAxis,
  queryTemplateLexically,
  sourceSignature,
} from "../src/kernel/templates/index.js";
import type { Digest, SourceDescriptor } from "../src/kernel/templates/index.js";

const roots: string[] = [];
const digest = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function snapshot(root: string, directory = root): Promise<readonly [string, string][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: [string, string][] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await snapshot(root, path));
    else result.push([path.slice(root.length + 1), await readFile(path, "utf8")]);
  }
  return result;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-first-e2e-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, ".oms"), { recursive: true }),
    mkdir(join(root, ".obsidian"), { recursive: true }),
    mkdir(join(root, "Templates", "OMS"), { recursive: true }),
  ]);

  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
    base: { fields: {} },
    contracts: {
      note: {
        intent: "A searchable note.",
        fields: {
          template: { type: "text", required: true },
          title: { type: "text", required: true },
          status: { type: "select", required: true, allowedValues: ["open", "closed"] },
        },
        views: [{ name: "by-status", keys: ["status"] }],
      },
    },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "managed-default",
        renderer: "obsidian-core",
        sourceFolder: "Templates/OMS",
        sourcePath: "Templates/OMS/note.md",
        contract: "note",
        naming: "{{slug}}.md",
      },
    },
  });
  const taxonomy = JSON.stringify({ folders: { notes: { template: "note" } } });
  const obsidianTypes = JSON.stringify({ types: { template: "text", title: "text", status: "select" } });
  const template = "---\ntemplate: note\ntitle: Untitled\nstatus: open\n---\n# Note\n<!-- oms:content -->\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(obsidianTypes) },
    { path: "Templates/OMS/note.md", signature: digest(template) },
  ];
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
    managed: {
      base: { fields: {} },
      globalAxes: {},
      templates: {
        note: {
          templateId: "note",
          destinationClass: "managed-default",
          renderer: "obsidian-core",
          sourcePath: "Templates/OMS/note.md",
          targetFolder: "notes",
          keyOrder: ["template", "title", "status"],
          fields: {
            template: { type: "text", required: true },
            title: { type: "text", required: true },
            status: { type: "select", required: true, allowedValues: ["open", "closed"] },
          },
          views: [{ name: "by-status", keys: ["status"] }],
          naming: "{{slug}}.md",
          bodySignature: digest("# Note\n<!-- oms:content -->\n"),
        },
      },
    },
  });

  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), policy),
    writeFile(join(root, ".oms", "taxonomy.json"), taxonomy),
    writeFile(join(root, ".oms", "types.json"), projection),
    writeFile(join(root, ".obsidian", "types.json"), obsidianTypes),
    writeFile(join(root, "Templates", "OMS", "note.md"), template),
  ]);
  return root;
}

describe("template-first write to search", () => {
  it("writes and retrieves through the same resolved template axes without search mutation", async () => {
    const root = await fixture();
    const convention = await loadResolvedTemplates(root);
    const write = await writeResolvedTemplateNote({
      target: { vault: root, source: "explicit" },
      convention,
      templateId: "note",
      mode: "create",
      dryRun: false,
      frontmatter: { template: "note", title: "My Entry", status: "open" },
      body: "searchable needle",
      resolvedAt: "2026-08-30T10:00:00.000Z",
    });
    expect(write, JSON.stringify(write)).toMatchObject({ status: "written" });
    expect(write.receipt).toMatchObject({ templateId: "note", notePath: "notes/my-entry.md", postconditionVerified: true });

    const index = await buildTemplateNoteIndex(root, convention);
    const beforeSearch = await snapshot(root);
    expect(queryTemplateAxis(index, convention.inputSignature, { templateId: "note", key: "template", value: "note" }).map(note => note.path)).toEqual(["notes/my-entry.md"]);
    expect(queryTemplateAxis(index, convention.inputSignature, { templateId: "note", key: "status", value: "open" }).map(note => note.path)).toEqual(["notes/my-entry.md"]);
    expect((await queryTemplateLexically(root, "searchable needle")).map(note => note.path)).toEqual(["notes/my-entry.md"]);
    expect(await snapshot(root)).toEqual(beforeSearch);

    const projectionPath = join(root, ".oms", "types.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as { managed: { templates: { note: { naming: string } } } };
    projection.managed.templates.note.naming = "tampered.md";
    await writeFile(projectionPath, JSON.stringify(projection));
    await expect(loadResolvedTemplates(root)).rejects.toThrow(/PROJECTION_PAYLOAD_TAMPERED/);
    expect(() => queryTemplateAxis(index, digest("tampered projection"), { templateId: "note", key: "status", value: "open" })).toThrow(/TEMPLATE_NOTE_INDEX_STALE/);
    expect((await queryTemplateLexically(root, "searchable needle")).map(note => note.path)).toEqual(["notes/my-entry.md"]);
  });
});
