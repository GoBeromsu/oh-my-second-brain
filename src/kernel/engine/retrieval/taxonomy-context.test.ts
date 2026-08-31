import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTaxonomyIntentProjection,
  loadTaxonomyIntentProjectionSync,
  projectTaxonomyIntents,
} from "./taxonomy-context.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
      { folder: "alpha", intent: "Alpha knowledge", source: ".oms/taxonomy.yaml" },
      { folder: "zeta", intent: "Zeta knowledge", source: ".oms/taxonomy.yaml" },
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
      'Indexed folder "alpha" has no intent in .oms/taxonomy.yaml.',
      'Indexed folder "blank" has no intent in .oms/taxonomy.yaml.',
      'Indexed folder "zulu" has no intent in .oms/taxonomy.yaml.',
      'Taxonomy folder "taxonomy-only" has no indexed Markdown files.',
    ]);
  });

  it("scopes context and warnings to the selected collection folder", () => {
    const projection = projectTaxonomyIntents(
      new Map([
        ["notes", "Permanent notes"],
        ["references", "External references"],
        ["unused", "No documents"],
      ]),
      ["notes/a.md", "references/b.md", "inbox/c.md"],
      "notes/deeper",
    );

    expect(projection.matched).toEqual([
      { folder: "notes", intent: "Permanent notes", source: ".oms/taxonomy.yaml" },
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
  async function vaultWithTaxonomy(taxonomy: string): Promise<string> {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-taxonomy-context-"));
    tempDirs.push(vault);
    await mkdir(path.join(vault, ".oms"), { recursive: true });
    await writeFile(path.join(vault, ".oms", "taxonomy.yaml"), taxonomy);
    return vault;
  }

  it("reads prompt text only from the active .oms taxonomy", async () => {
    const vault = await vaultWithTaxonomy(`
version: 1
folders:
  notes:
    intent: User-owned note intent
    concept: note
`);
    // A legacy root-level file must never override the active contract.
    await writeFile(path.join(vault, "taxonomy.yaml"), `
folders:
  notes:
    intent: Legacy parallel intent
`);

    const projection = await loadTaxonomyIntentProjection(vault, ["notes/a.md"]);

    expect(projection.promptContext).toContain("User-owned note intent");
    expect(projection.promptContext).not.toContain("Legacy parallel intent");
    expect(projection.matched[0]?.source).toBe(".oms/taxonomy.yaml");
  });

  it("does not substitute bundled context when the active taxonomy is absent", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-taxonomy-context-"));
    tempDirs.push(vault);

    const projection = await loadTaxonomyIntentProjection(vault, ["notes/a.md"]);

    expect(projection.matched).toEqual([]);
    expect(projection.promptContext).toBeUndefined();
    expect(projection.warnings[0]).toMatch(/Active taxonomy context.*unavailable/);
    expect(projection.warnings).toContain(
      'Indexed folder "notes" has no intent in .oms/taxonomy.yaml.',
    );
  });

  it("treats malformed active taxonomy as unavailable instead of throwing or writing", async () => {
    const vault = await vaultWithTaxonomy("folders: [not, a, mapping\n");

    const projection = await loadTaxonomyIntentProjection(vault, ["notes/a.md"]);

    expect(projection.matched).toEqual([]);
    expect(projection.warnings[0]).toMatch(/unavailable or invalid/);
  });

  it("produces the same status projection through the synchronous reader", async () => {
    const vault = await vaultWithTaxonomy(`
folders:
  notes:
    intent: Permanent notes
    concept: note
`);

    const asynchronous = await loadTaxonomyIntentProjection(vault, ["notes/a.md", "inbox/b.md"]);
    const synchronous = loadTaxonomyIntentProjectionSync(vault, ["notes/a.md", "inbox/b.md"]);

    expect(synchronous).toEqual(asynchronous);
  });
});
