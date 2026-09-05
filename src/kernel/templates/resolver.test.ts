import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeResolvedTemplateFields, deriveFolderOntologyAxis, loadResolvedTemplates, loadResolvedTemplatesIfPresent, requireTaxonomyPlacement, resolveClassifiedTemplateSource, sourceSignature, taxonomyRouting } from "./resolver.js";
import type { Digest, SourceDescriptor } from "./types.js";

const roots: string[] = [];
const digest = (value: string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { readonly placement?: boolean; readonly dateExample?: boolean; readonly renderer?: "obsidian-core" | "templater" | "none" } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-resolver-"));
  roots.push(root);
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Templates", "OMS"), { recursive: true });
  const renderer = options.renderer ?? "obsidian-core";
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
    base: { fields: {} },
    contracts: { note: { intent: "A note.", fields: options.dateExample ? { date: { type: "date" } } : {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "managed-default",
        renderer,
        sourceFolder: "Templates/OMS",
        sourcePath: "Templates/OMS/note.md",
        contract: "note",
        naming: "{{title}}",
      },
    },
  });
  const taxonomy = JSON.stringify(options.placement === false
    ? { folders: {} }
    : { folders: { "Notes/Published": { templates: ["note"] } } });
  const types = JSON.stringify({ types: { title: "text", ...(options.dateExample || renderer === "templater" ? { date: "date" } : {}) } });
  const template = renderer === "templater"
    ? "---\ntitle: literal\ndate: '<% tp.date.now(\"YYYY-MM-DD\") %>'\n---\nBody\n"
    : renderer === "none" ? "<%* tR += 'Synthetic external template'; %>\n"
    : options.dateExample ? "---\ntitle: literal\ndate: \"{{date}}\"\n---\nBody\n" : "---\ntitle: literal\n---\nBody\n";
  const keyOrder = renderer === "none" ? [] : renderer === "templater" || options.dateExample ? ["title", "date"] : ["title"];
  const projectedFields = renderer === "none"
    ? options.dateExample ? { date: { type: "date" } } : {}
    : { title: { type: "text" }, ...(renderer === "templater" ? { date: { type: "date", filledBy: "obsidian" } } : options.dateExample ? { date: { type: "date" } } : {}) };
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
          renderer,
          sourcePath: "Templates/OMS/note.md",
          targetFolder: "Notes/Published",
          keyOrder,
          fields: projectedFields,
          views: [],
          naming: "{{title}}",
          bodySignature: digest(renderer === "none" ? "" : "Body\n"),
        },
      },
    },
  });
  await Promise.all([
    writeFile(join(root, ".oms", "template-policy.json"), policy),
    writeFile(join(root, ".oms", "taxonomy.json"), taxonomy),
    writeFile(join(root, ".obsidian", "types.json"), types),
    writeFile(join(root, "Templates", "OMS", "note.md"), template),
    writeFile(join(root, ".oms", "types.json"), projection),
  ]);
  return root;
}

describe("loadResolvedTemplates", () => {
  it.each(["create", "update"])("rejects an oversize %s source proposal before composition", mode => {
    const source = new TextEncoder().encode(`---\ntitle: note\n---\n${"x".repeat(262_145)}`);
    expect(() => resolveClassifiedTemplateSource(`Templates/OMS/${mode}.md`, source, "obsidian-core"))
      .toThrow(/TEMPLATE_PROPOSAL_OVERSIZE/);
  });

  it("rejects requested renderer mismatch and invalid Core expressions inside Templater sources", () => {
    const core = new TextEncoder().encode("---\ntitle: note\n---\nBody\n");
    expect(() => resolveClassifiedTemplateSource("Templates/OMS/note.md", core, "templater"))
      .toThrow(/TEMPLATE_SOURCE_INVALID.*renderer obsidian-core does not match requested renderer templater/);
    const invalidMixed = new TextEncoder().encode("---\ncreated: '<% tp.date.now() %>'\n---\n{{date:YYYY[year]}}\n");
    expect(() => resolveClassifiedTemplateSource("Templates/OMS/note.md", invalidMixed, "templater"))
      .toThrow(/TEMPLATE_EXPRESSION_UNSUPPORTED/);
  });

  it("accepts script-first renderer-none sources without fabricating an observed body", () => {
    const source = new TextEncoder().encode("<%* await host.propose() %>\n");
    expect(resolveClassifiedTemplateSource("Templates/OMS/script.md", source, "none")).toMatchObject({
      keyOrder: [],
      frontmatter: {},
      body: "",
      bodyExternal: true,
    });
  });

  it("bounds host proposal source paths to sixteen segments", () => {
    const source = new TextEncoder().encode("---\ntitle: note\n---\nBody\n");
    const path = `${Array.from({ length: 16 }, (_, index) => `folder-${index}`).join("/")}/note.md`;
    expect(() => resolveClassifiedTemplateSource(path, source, "obsidian-core"))
      .toThrow(/TEMPLATE_SOURCE_INVALID.*maximum source path depth of 16/);
  });

  it("returns null only when every OMS template control is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "oms-template-resolver-empty-"));
    roots.push(empty);
    await mkdir(join(empty, ".oms"));

    await expect(loadResolvedTemplatesIfPresent(empty)).resolves.toBeNull();
  });

  it.each([
    [".oms/template-migration.json", "MIGRATION_INCOMPLETE"],
    [".oms/template-policy.json", "TEMPLATE_SOURCE_INVALID"],
    [".oms/types.json", "TEMPLATE_SOURCE_INVALID"],
    [".oms/taxonomy.json", "TEMPLATE_SOURCE_INVALID"],
  ])("rejects a vault with only %s", async (control, code) => {
    const root = await mkdtemp(join(tmpdir(), "oms-template-resolver-partial-"));
    roots.push(root);
    await mkdir(join(root, ".oms"), { recursive: true });
    await writeFile(join(root, control), "{}\n");

    await expect(loadResolvedTemplatesIfPresent(root)).rejects.toThrow(code);
  });

  it.each([
    [".oms/template-policy.json", ".oms/taxonomy.json"],
    [".oms/template-policy.json", ".oms/types.json"],
    [".oms/types.json", ".oms/taxonomy.json"],
  ])("rejects representative partial control sets: %s and %s", async (first, second) => {
    const root = await mkdtemp(join(tmpdir(), "oms-template-resolver-partial-"));
    roots.push(root);
    await mkdir(join(root, ".oms"), { recursive: true });
    await Promise.all([
      writeFile(join(root, first), "{}\n"),
      writeFile(join(root, second), "{}\n"),
    ]);

    await expect(loadResolvedTemplatesIfPresent(root)).rejects.toThrow("TEMPLATE_SOURCE_INVALID");
  });

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

  it("routes notes from taxonomy outside every template source folder", async () => {
    const root = await fixture();

    await expect(loadResolvedTemplates(root)).resolves.toMatchObject({
      templates: {
        note: {
          sourcePath: "Templates/OMS/note.md",
          targetFolder: "Notes/Published",
        },
      },
    });
  });

  it("resolves Templater frontmatter as caller-filled contract without evaluating external tags", async () => {
    const root = await fixture({ renderer: "templater" });

    await expect(loadResolvedTemplates(root)).resolves.toMatchObject({
      templates: {
        note: {
          renderer: "templater",
          fields: { date: { filledBy: "obsidian" } },
          frontmatterTemplate: { date: "<% tp.date.now(\"YYYY-MM-DD\") %>" },
          body: "Body\n",
        },
      },
    });
  });

  it("resolves renderer-none bindings from policy contract only while retaining signed source identity", async () => {
    const root = await fixture({ renderer: "none", dateExample: true });

    await expect(loadResolvedTemplates(root)).resolves.toMatchObject({
      templates: {
        note: {
          renderer: "none",
          sourcePath: "Templates/OMS/note.md",
          keyOrder: [],
          fields: { date: { type: "date" } },
          frontmatterTemplate: {},
          body: "",
        },
      },
      managedSourcePaths: ["Templates/OMS/note.md"],
    });
  });

  it("rejects missing taxonomy placement and names the template", async () => {
    const root = await fixture({ placement: false });

    await expect(loadResolvedTemplates(root)).rejects.toThrow(
      /TEMPLATE_PLACEMENT_UNDECLARED: taxonomy placement is undeclared for template note/,
    );
  });

  it("exports the shared taxonomy route and placement validation", () => {
    const routing = taxonomyRouting(
      ".oms/taxonomy.json",
      new TextEncoder().encode(JSON.stringify({
        templates: { note: { templateFolder: "Notes/Published" } },
        folders: { references: { intent: "Processed sources." } },
      })),
    );

    expect(requireTaxonomyPlacement(routing, "note")).toBe("Notes/Published");
    expect(routing.globalAxes["folder-ontology"]?.members).toEqual(["references"]);
    expect(() => requireTaxonomyPlacement(routing, "missing")).toThrow(
      /TEMPLATE_PLACEMENT_UNDECLARED.*missing/,
    );
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

  it("accepts the Obsidian help date expression for a date property end to end", async () => {
    const root = await fixture({ dateExample: true });
    const resolved = await loadResolvedTemplates(root);
    expect(resolved.templates.note?.frontmatterTemplate.date).toBe("{{date}}");
    expect(resolved.templates.note?.fields.date?.type).toBe("date");
  });

  it("accepts formatted temporal tags without weakening conflicting literal checks", () => {
    expect(composeResolvedTemplateFields(
      { fields: {} },
      { date: { type: "date" }, timestamp: { type: "datetime" } },
      { date: "{{date:YYYY/MM/DD}}", timestamp: "{{time:HH:mm:ss}}" },
      { date: "date", timestamp: "datetime" },
    )).toMatchObject({ date: { type: "date" }, timestamp: { type: "datetime" } });
    expect(() => composeResolvedTemplateFields(
      { fields: {} },
      { date: { type: "date" } },
      { date: "not-a-date" },
      { date: "date" },
    )).toThrow(/OBSIDIAN_TYPE_CONFLICT/);
  });

  it("resolves a signed actual template without writing the vault", async () => {
    const root = await fixture();
    const before = await Promise.all([".oms/template-policy.json", ".oms/types.json", ".oms/taxonomy.json", ".obsidian/types.json", "Templates/OMS/note.md"].map(async file => [file, await readFile(join(root, file), "utf8")] as const));
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
    await writeFile(join(root, ".oms", "taxonomy.json"), JSON.stringify({
      folders: { notes: { intent: "Working notes." } },
      globalAxes: { "folder-ontology": { kind: "folder", key: "folder", type: "text", members: ["notes"] } },
    }));
    await expect(loadResolvedTemplates(root)).rejects.toThrow(/globalAxes\.folder-ontology is reserved/);
  });
});
