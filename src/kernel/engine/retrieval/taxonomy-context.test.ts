import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTaxonomyIntentProjection, projectTaxonomyIntents } from "./taxonomy-context.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function vaultWithTaxonomy(taxonomy?: string): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-taxonomy-context-"));
  tempDirs.push(vault);
  if (taxonomy !== undefined) {
    await mkdir(path.join(vault, ".oms"));
    await writeFile(path.join(vault, ".oms", "taxonomy.json"), taxonomy);
  }
  return vault;
}

describe("projectTaxonomyIntents", () => {
  it("projects only matched top-level folders in deterministic order", () => {
    const projection = projectTaxonomyIntents(new Map([
      ["zeta", "Zeta knowledge"], ["alpha", "Alpha knowledge"],
    ]), ["zeta/note.md", "root.md", "alpha/deeper/note.md"]);
    expect(projection.matched).toEqual([
      { folder: "alpha", intent: "Alpha knowledge", source: ".oms/taxonomy.json" },
      { folder: "zeta", intent: "Zeta knowledge", source: ".oms/taxonomy.json" },
    ]);
    expect(projection.promptContext).toBe("- alpha: Alpha knowledge\n- zeta: Zeta knowledge");
  });
  it("reports both directions of drift in stable code-point order", () => {
    const projection = projectTaxonomyIntents(new Map([
      ["taxonomy-only", "No files yet"], ["blank", "   "],
    ]), ["zulu/file.md", "alpha/file.md", "blank/file.md"]);
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
    const projection = projectTaxonomyIntents(new Map([
      ["notes", "Permanent notes"], ["references", "External references"],
    ]), ["notes/a.md", "references/b.md"], "notes/deeper");
    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes", source: ".oms/taxonomy.json" },
    ]);
    expect(projection.warnings).toEqual([]);
    expect(projection.promptContext).toBe("- notes: Permanent notes");
  });
  it("ignores root notes and hidden state because neither has a folder intent", () => {
    const projection = projectTaxonomyIntents(new Map([["notes", "Notes"]]), ["root.md", ".gjc/session/plan.md", "notes/real.md"]);
    expect(projection.matched.map(({ folder }) => folder)).toEqual(["notes"]);
    expect(projection.warnings).toEqual([]);
  });
});

describe("loadTaxonomyIntentProjection", () => {
  it("uses directly declared folder intent without writing controls", async () => {
    const taxonomy = JSON.stringify({ folders: {
      references: { intent: "Processed sources." }, notes: { intent: "Permanent notes." },
    } });
    const vault = await vaultWithTaxonomy(taxonomy);
    const projection = await loadTaxonomyIntentProjection(vault, ["references/a.md", "notes/b.md"]);
    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes.", source: ".oms/taxonomy.json" },
      { folder: "references", intent: "Processed sources.", source: ".oms/taxonomy.json" },
    ]);
    expect(await readFile(path.join(vault, ".oms/taxonomy.json"), "utf8")).toBe(taxonomy);
    expect(existsSync(path.join(vault, ".oms/template-policy.json"))).toBe(false);
    expect(existsSync(path.join(vault, ".oms/types.json"))).toBe(false);
  });
  it("does not invent meaning for folders without declared intent", async () => {
    const vault = await vaultWithTaxonomy(JSON.stringify({ folders: { notes: { template: "note" } } }));
    const projection = await loadTaxonomyIntentProjection(vault, ["notes/a.md"]);
    expect(projection.matched).toEqual([]);
    expect(projection.promptContext).toBeUndefined();
  });
  it("keeps a vault without taxonomy free of OMS state", async () => {
    const vault = await vaultWithTaxonomy();
    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).resolves.toMatchObject({ matched: [], indexedWithoutIntent: ["notes"] });
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
  });
  it.each([
    ["template-policy.json", "{broken"],
    ["types.json", "{broken projection"],
    ["template-transaction.json", JSON.stringify({ status: "in-progress" })],
  ])("does not make %s validity an admission gate for retrieval", async (file, content) => {
    const vault = await vaultWithTaxonomy(JSON.stringify({ folders: { notes: { intent: "Permanent notes." } } }));
    const control = path.join(vault, ".oms", file);
    await writeFile(control, content);
    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"], "notes")).resolves.toMatchObject({
      matched: [{ folder: "notes", intent: "Permanent notes.", source: ".oms/taxonomy.json" }],
      promptContext: "- notes: Permanent notes.",
    });
    expect(await readFile(control, "utf8")).toBe(content);
  });
  it.each(["{broken", "null", "[]"])("reports malformed taxonomy itself without inventing context: %s", async content => {
    const vault = await vaultWithTaxonomy(content);
    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).rejects.toThrow("TAXONOMY_CONTEXT_INVALID");
  });
  it("rejects invalid folder declarations rather than treating them as empty intent", async () => {
    const vault = await vaultWithTaxonomy(JSON.stringify({ folders: [] }));
    await expect(loadTaxonomyIntentProjection(vault, ["notes/a.md"])).rejects.toThrow("taxonomy.folders");
  });
});
