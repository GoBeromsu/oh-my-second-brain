import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTemplateMigration, buildMigrationManifest, planTemplateMigration } from "../templates/migration.js";
import { loadResolvedTemplates } from "../templates/resolver.js";
import { applyLinksForNote, linkifyVault, suggestLinksForNote } from "./workflow.js";

let roots: string[] = [];

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-link-workflow-"));
  roots.push(vault);
  await Promise.all([mkdir(path.join(vault, "terms")), mkdir(path.join(vault, "notes")), mkdir(path.join(vault, "Templates", "OMS"), { recursive: true })]);
  await writeFile(path.join(vault, "terms", "Ataraxia.md"), "---\ntemplate: note\ntitle: Ataraxia\n---\n\nA term.\n", "utf8");
  await writeFile(path.join(vault, "notes", "Sage.md"), "---\ntemplate: note\ntitle: Sage\n---\n\nAtaraxia is useful.\n", "utf8");
  await writeFile(path.join(vault, "Templates", "OMS", "note.md"), "---\ntemplate: note\n---\nAtaraxia must never become a candidate.\n", "utf8");
  await mkdir(path.join(vault, ".oms"));
  await mkdir(path.join(vault, ".obsidian"));
  await writeFile(path.join(vault, ".oms", "taxonomy.json"), JSON.stringify({ folders: {}, templates: { note: { templateFolder: "notes" } } }));
  await writeFile(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text", title: "text" } }));
  const proposal = await planTemplateMigration(vault, { templateFolders: [{ path: "Templates/OMS", mode: "auto", default: true }] });
  const manifest = await buildMigrationManifest(vault, proposal, { base: { fields: {} } });
  await applyTemplateMigration(vault, proposal, manifest, { approvedDigest: manifest.approvalDigest });
  return vault;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("link workflow", () => {
  it("uses only template-identified ordinary notes, excludes managed sources, and refuses stale applies without writing", async () => {
    const vault = await makeVault();
    const convention = await loadResolvedTemplates(vault);
    const target = { vault, source: "explicit" as const, convention, notePath: "notes/Sage.md" };
    const suggestion = await suggestLinksForNote(target);
    expect(suggestion.candidateNotes).toBe(2);
    expect(suggestion.candidates).toHaveLength(1);
    expect(suggestion.candidates[0]?.id).toMatch(/^\d+-\d+$/);
    expect(suggestion.candidates[0]?.targetPath).toBe("terms/Ataraxia.md");

    const outcome = await applyLinksForNote(target, {
      baseContentHash: "0".repeat(64),
      candidateIds: suggestion.candidates.map((candidate) => candidate.id),
    });
    expect(outcome.result).toMatchObject({ applied: false, reason: "note-changed" });
    expect(await readFile(path.join(vault, "notes", "Sage.md"), "utf8")).not.toContain("[[Ataraxia]]");
  });

  it("never falls back to legacy concept frontmatter", async () => {
    const vault = await makeVault();
    const convention = await loadResolvedTemplates(vault);
    await writeFile(path.join(vault, "terms", "Ataraxia.md"), "---\nconcept: term\ntitle: Ataraxia\n---\n\nA legacy term.\n", "utf8");
    const suggestion = await suggestLinksForNote({ vault, source: "explicit", convention, notePath: "notes/Sage.md" });
    expect(suggestion.candidateNotes).toBe(1);
    expect(suggestion.candidates).toEqual([]);
  });

  it("orchestrates a batch scan and sequential guarded template writes", async () => {
    const vault = await makeVault();
    const convention = await loadResolvedTemplates(vault);
    const result = await linkifyVault({ vault, source: "explicit", convention }, { apply: true });
    expect(result.notesInScope).toBe(2);
    expect(result.targetNotes).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.outcome?.result.applied, JSON.stringify(result.candidates[0]?.outcome?.result)).toBe(true);
    expect(await readFile(path.join(vault, "notes", "Sage.md"), "utf8")).toContain("[[Ataraxia]]");
  });
});
