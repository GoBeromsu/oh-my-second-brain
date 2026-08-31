import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeResolvedTemplateFields, deriveFolderOntologyAxis, loadResolvedTemplates, sourceSignature } from "./resolver.js";
import type { Digest, SourceDescriptor } from "./types.js";

const roots: string[] = [];
const digest = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-resolver-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates", "OMS"), { recursive: true });
  const policy = JSON.stringify({
    version: 1,
    templateFolder: "Templates/OMS",
    base: { fields: {} },
    contracts: { note: { intent: "A note.", fields: {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "managed-default",
        sourcePath: "Templates/OMS/note.md",
        contract: "note",
        naming: "{{title}}",
      },
    },
  });
  const taxonomy = "folders: {}\n";
  const types = JSON.stringify({ types: { title: "text" } });
  const template = "---\ntitle: literal\n---\nBody\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(types) },
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
          sourcePath: "Templates/OMS/note.md",
          targetFolder: "Inbox",
          keyOrder: ["title"],
          fields: { title: { type: "text" } },
          views: [],
          naming: "{{title}}",
          bodySignature: digest("Body\n"),
        },
      },
    },
  });
  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), policy),
    writeFile(join(root, ".oms", "taxonomy.yaml"), taxonomy),
    writeFile(join(root, ".obsidian", "types.json"), types),
    writeFile(join(root, "Templates", "OMS", "note.md"), template),
    writeFile(join(root, ".oms", "types.json"), projection),
  ]);
  return root;
}

describe("loadResolvedTemplates", () => {
  it("derives deterministic folder ontology only from authored folder intents", () => {
    expect(deriveFolderOntologyAxis({ notes: { template: "note" } })).toBeNull();
    expect(deriveFolderOntologyAxis({
      references: { intent: "Processed sources." },
      inbox: { intent: "Unprocessed captures." },
    })).toEqual({
      kind: "folder",
      key: "folder",
      type: "text",
      intent: "Semantic meanings of vault folders.",
      members: ["inbox", "references"],
      extensions: { intents: { inbox: "Unprocessed captures.", references: "Processed sources." } },
    });
    expect(() => deriveFolderOntologyAxis({ notes: { intent: " " } })).toThrow(/TEMPLATE_SOURCE_INVALID/);
  });

  it("infers date and checkbox literals and rejects explicit type mismatches", () => {
    expect(composeResolvedTemplateFields(
      { fields: {} },
      {},
      { created: "2026-08-30", done: false },
      {},
    )).toMatchObject({ created: { type: "date" }, done: { type: "checkbox" } });
    expect(() => composeResolvedTemplateFields(
      { fields: {} },
      {},
      { done: "false" },
      { done: "checkbox" },
    )).toThrow(/OBSIDIAN_TYPE_CONFLICT/);
  });

  it("resolves a signed actual template without writing the vault", async () => {
    const root = await fixture();
    const before = await Promise.all([".oms/template-policy.json", ".oms/types.json", ".oms/taxonomy.yaml", ".obsidian/types.json", "Templates/OMS/note.md"].map(async file => [file, await readFile(join(root, file), "utf8")] as const));
    const resolved = await loadResolvedTemplates(root);
    expect(Object.keys(resolved.templates)).toEqual(["note"]);
    expect(resolved.templates.note?.body).toBe("Body\n");
    expect(resolved.managedSourcePaths).toEqual(["Templates/OMS/note.md"]);
    const after = await Promise.all(before.map(async ([file]) => [file, await readFile(join(root, file), "utf8")] as const));
    expect(after).toEqual(before);
  });

  it("fails loudly for source drift and projection payload tampering", async () => {
    const root = await fixture();
    await writeFile(join(root, "Templates", "OMS", "note.md"), "---\ntitle: changed\n---\nBody\n");
    await expect(loadResolvedTemplates(root)).rejects.toThrow(/TEMPLATE_SOURCE_DRIFT/);
    const clean = await fixture();
    const projection = JSON.parse(await readFile(join(clean, ".oms", "types.json"), "utf8")) as { managed: { templates: Record<string, { naming: string }> } };
    projection.managed.templates.note!.naming = "tampered";
    await writeFile(join(clean, ".oms", "types.json"), JSON.stringify(projection));
    await expect(loadResolvedTemplates(clean)).rejects.toThrow(/PROJECTION_PAYLOAD_TAMPERED/);
  });

  it("rejects an authored axis that collides with the derived folder ontology", async () => {
    const root = await fixture();
    await writeFile(join(root, ".oms", "taxonomy.yaml"), [
      "folders:",
      "  notes:",
      "    intent: Working notes.",
      "globalAxes:",
      "  folder-ontology:",
      "    kind: folder",
      "    key: folder",
      "    type: text",
      "    members: [notes]",
      "",
    ].join("\n"));
    await expect(loadResolvedTemplates(root)).rejects.toThrow(/globalAxes\.folder-ontology is reserved/);
  });
});
