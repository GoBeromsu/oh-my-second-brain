import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { deriveFolderOntologyAxis, sourceSignature } from "../../templates/resolver.js";
import type { Digest, SourceDescriptor } from "../../templates/types.js";
import {
  loadTaxonomyIntentProjection,
  projectTaxonomyIntents,
} from "./taxonomy-context.js";

const tempDirs: string[] = [];
const digest = (value: string): Digest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function vaultWithContract(taxonomy: string): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-taxonomy-context-"));
  tempDirs.push(vault);
  await Promise.all([
    mkdir(path.join(vault, ".oms"), { recursive: true }),
    mkdir(path.join(vault, ".obsidian"), { recursive: true }),
    mkdir(path.join(vault, "Templates", "OMS"), { recursive: true }),
  ]);
  const policy = JSON.stringify({
    version: 3,
    templateFolders: [{ path: "Templates/OMS", mode: "manual", default: true }],
    base: { fields: {} },
    contracts: { note: { intent: "A note.", fields: {}, views: [] } },
    templates: {
      note: {
        templateId: "note",
        destinationClass: "managed-default",
        sourceFolder: "Templates/OMS",
        sourcePath: "Templates/OMS/note.md",
        renderer: "obsidian-core",
        contract: "note",
        naming: "{{title}}",
      },
    },
  });
  const types = JSON.stringify({ types: { title: "text" } });
  const template = "---\ntitle: literal\n---\nBody\n";
  const sources: SourceDescriptor[] = [
    { logicalId: "template-policy", signature: digest(policy) },
    { logicalId: "taxonomy", signature: digest(taxonomy) },
    { logicalId: "obsidian-types", signature: digest(types) },
    { path: "Templates/OMS/note.md", signature: digest(template) },
  ];
  const taxonomyRoot = parse(taxonomy) as { folders?: unknown };
  const folderOntology = deriveFolderOntologyAxis(taxonomyRoot.folders);
  const targetFolder = Object.entries(
    typeof taxonomyRoot.folders === "object" && taxonomyRoot.folders !== null
      ? taxonomyRoot.folders as Record<string, unknown>
      : {},
  ).find(([, value]) =>
    typeof value === "object"
    && value !== null
    && (value as Record<string, unknown>).template === "note")?.[0] ?? "Inbox";
  const projection = JSON.stringify({
    version: "oms.types.v1",
    generatedFrom: { algorithm: "sha256-lp-v1", inputSignature: sourceSignature(sources), sources },
    managed: {
      base: { fields: {} },
      globalAxes: folderOntology === null ? {} : { "folder-ontology": folderOntology },
      templates: {
        note: {
          templateId: "note",
          destinationClass: "managed-default",
          sourcePath: "Templates/OMS/note.md",
          renderer: "obsidian-core",
          targetFolder,
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
    writeFile(path.join(vault, ".oms", "template-policy.json"), policy),
    writeFile(path.join(vault, ".oms", "taxonomy.json"), taxonomy),
    writeFile(path.join(vault, ".oms", "types.json"), projection),
    writeFile(path.join(vault, ".obsidian", "types.json"), types),
    writeFile(path.join(vault, "Templates", "OMS", "note.md"), template),
  ]);
  return vault;
}

describe("projectTaxonomyIntents", () => {
  it("projects only matched top-level folders in deterministic order", () => {
    const intents = new Map([
      ["zeta", "Zeta knowledge"],
      ["alpha", "Alpha knowledge"],
    ]);

    const projection = projectTaxonomyIntents(intents, [
      "zeta/note.md",
      "root.md",
      "alpha/deeper/note.md",
    ]);

    expect(projection.matched).toEqual([
      { folder: "alpha", intent: "Alpha knowledge", source: ".oms/taxonomy.json" },
      { folder: "zeta", intent: "Zeta knowledge", source: ".oms/taxonomy.json" },
    ]);
    expect(projection.promptContext).toBe(
      "- alpha: Alpha knowledge\n- zeta: Zeta knowledge",
    );
  });

  it("reports both directions of drift in stable code-point order", () => {
    const projection = projectTaxonomyIntents(
      new Map([
        ["taxonomy-only", "No files yet"],
        ["blank", "   "],
      ]),
      ["zulu/file.md", "alpha/file.md", "blank/file.md"],
    );

    expect(projection.indexedWithoutIntent).toEqual(["alpha", "blank", "zulu"]);
    expect(projection.taxonomyWithoutIndexed).toEqual(["taxonomy-only"]);
    expect(projection.warnings).toEqual([
      'Indexed folder "alpha" has no intent in .oms/taxonomy.json.',
      'Indexed folder "blank" has no intent in .oms/taxonomy.json.',
      'Indexed folder "zulu" has no intent in .oms/taxonomy.json.',
      'Taxonomy folder "taxonomy-only" has no indexed Markdown files.',
    ]);
  });

  it("scopes context to the selected collection folder", () => {
    const projection = projectTaxonomyIntents(
      new Map([
        ["notes", "Permanent notes"],
        ["references", "External references"],
      ]),
      ["notes/a.md", "references/b.md"],
      "notes/deeper",
    );

    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes", source: ".oms/taxonomy.json" },
    ]);
    expect(projection.warnings).toEqual([]);
    expect(projection.promptContext).toBe("- notes: Permanent notes");
  });

  it("ignores root notes and hidden state because neither has a folder intent", () => {
    const projection = projectTaxonomyIntents(
      new Map([["notes", "Notes"]]),
      ["root.md", ".gjc/session/plan.md", "notes/real.md"],
    );

    expect(projection.matched.map(({ folder }) => folder)).toEqual(["notes"]);
    expect(projection.warnings).toEqual([]);
  });
});

describe("loadTaxonomyIntentProjection", () => {
  it("uses resolved folder-ontology members and intents", async () => {
    const vault = await vaultWithContract(JSON.stringify({
      folders: {
        references: { intent: "Processed sources." },
        notes: { intent: "Permanent notes." },
      },
      templates: { note: { templateFolder: "Inbox" } },
    }));

    const projection = await loadTaxonomyIntentProjection(vault, ["references/a.md", "notes/b.md"]);

    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes.", source: ".oms/taxonomy.json" },
      { folder: "references", intent: "Processed sources.", source: ".oms/taxonomy.json" },
    ]);
  });

  it("treats an absent folder-ontology axis as empty context", async () => {
    const vault = await vaultWithContract(JSON.stringify({ folders: { notes: { template: "note" } } }));

    const projection = await loadTaxonomyIntentProjection(vault, ["notes/a.md"]);

    expect(projection.matched).toEqual([]);
    expect(projection.promptContext).toBeUndefined();
  });

  it("treats a vault without OMS template controls as empty context", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-taxonomy-context-empty-"));
    tempDirs.push(vault);

    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).resolves.toMatchObject({
      matched: [],
      indexedWithoutIntent: ["notes"],
    });
  });

  it.each([
    ["MIGRATION_INCOMPLETE", async (vault: string) => {
      await writeFile(path.join(vault, ".oms", "template-migration.json"), "{}\n");
    }],
    ["TEMPLATE_SOURCE_DRIFT", async (vault: string) => {
      await writeFile(path.join(vault, "Templates", "OMS", "note.md"), "---\ntitle: changed\n---\nBody\n");
    }],
    ["PROJECTION_PAYLOAD_TAMPERED", async (vault: string) => {
      const projectionPath = path.join(vault, ".oms", "types.json");
      const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        managed: { templates: { note: { naming: string } } };
      };
      projection.managed.templates.note.naming = "tampered";
      await writeFile(projectionPath, JSON.stringify(projection));
    }],
  ])("fails closed with repair guidance when the active contract is %s", async (state, change) => {
    const vault = await vaultWithContract(JSON.stringify({
      folders: { notes: { intent: "Permanent notes." } },
      templates: { note: { templateFolder: "Inbox" } },
    }));
    await change(vault);

    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).rejects.toThrow(state);
    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).rejects.toThrow(
      "Run oms doctor --vault <vault>",
    );
  });
});
