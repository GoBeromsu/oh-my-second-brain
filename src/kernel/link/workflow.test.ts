import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinksForNote, scanLinkNotes, suggestLinksForNote } from "./workflow.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function vault(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-link-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(join(root, relative, ".."), { recursive: true });
    await writeFile(join(root, relative), content);
  }
  return root;
}

function target(root: string, notePath: string) {
  return { vault: root, source: "explicit" as const, notePath };
}

async function signature(root: string, files: readonly string[]): Promise<string> {
  const rows = await Promise.all(files.map(async file => `${file}:${await readFile(join(root, file), "utf8")}`));
  return rows.join("\n");
}

describe("link suggestion", () => {
  it("suggests links from every ordinary note, including unbound and invalid ones", async () => {
    const root = await vault({
      "notes/source.md": "---\ntemplate: note\n---\n\nAtaraxia and Tranquility belong here.\n",
      "notes/Ataraxia.md": "---\ntemplate: note\n---\n\nBound target.\n",
      "notes/Tranquility.md": "Unbound target with no frontmatter.\n",
      "notes/Broken.md": "---\ntitle: [unclosed\n---\n\nStill a note.\n",
    });
    const before = await signature(root, ["notes/source.md", "notes/Ataraxia.md", "notes/Tranquility.md"]);
    const suggestion = await suggestLinksForNote(target(root, "notes/source.md"));
    expect(suggestion.candidateNotes).toBe(4);
    // The unbound note is a first-class link target, exactly like the bound one.
    expect(suggestion.candidates.map(candidate => candidate.targetPath)).toEqual(
      expect.arrayContaining(["notes/Ataraxia.md", "notes/Tranquility.md"]),
    );
    expect(suggestion.candidates.every(candidate => typeof candidate.id === "string")).toBe(true);
    expect(await signature(root, ["notes/source.md", "notes/Ataraxia.md", "notes/Tranquility.md"])).toBe(before);
  });

  it("reports malformed frontmatter as a diagnostic and still links the body text", async () => {
    const root = await vault({
      "notes/source.md": "---\ntitle: [unclosed\n---\n\nMentions Ataraxia.\n",
      "notes/Ataraxia.md": "Target.\n",
    });
    const suggestion = await suggestLinksForNote(target(root, "notes/source.md"));
    expect(suggestion.diagnostics).toContain("frontmatter-yaml-parse-error");
    expect(suggestion.candidates.map(candidate => candidate.targetPath)).toContain("notes/Ataraxia.md");
  });

  it("scopes the candidate universe to a folder without changing path identity", async () => {
    const root = await vault({
      "notes/source.md": "Mentions Alpha and Beta.\n",
      "notes/Alpha.md": "a\n",
      "archive/Beta.md": "b\n",
    });
    const scoped = await suggestLinksForNote(target(root, "notes/source.md"), { folder: "notes" });
    expect(scoped.candidates.map(candidate => candidate.targetPath)).toEqual(["notes/Alpha.md"]);
  });

  it("excludes approved template sources from the linkable universe", async () => {
    const root = await vault({
      ".oms/template-policy.json": JSON.stringify({ version: 4, templates: { note: { source: { path: "Sources/note.md" } } } }),
      "Sources/note.md": "<%* raw template %>\n",
      "notes/source.md": "Mentions note.\n",
    });
    expect((await scanLinkNotes(root)).map(note => note.path)).toEqual(["notes/source.md"]);
  });

  it("refuses a hidden, traversing, or symlinked note path", async () => {
    const outside = await mkdtemp(join(tmpdir(), "oms-link-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "secret\n");
    const root = await vault({ "notes/real.md": "note\n" });
    await symlink(join(outside, "secret.md"), join(root, "notes", "linked.md"));
    await expect(suggestLinksForNote(target(root, "../secret.md"))).rejects.toThrow();
    await expect(suggestLinksForNote(target(root, ".oms/templates/default.md"))).rejects.toThrow();
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret\n");
  });
});

describe("link checking", () => {
  it("separates resolved, unresolved, and ambiguous wikilinks", async () => {
    const root = await vault({
      "notes/source.md": "---\ntemplate: note\n---\n\nSee [[Graph Index]], [[Missing Note]], and [[Twin]].\n",
      "notes/Graph Index.md": "---\ntemplate: note\n---\n\nBound.\n",
      "notes/Twin.md": "---\naliases:\n  - Twin\n---\n\nOne.\n",
      "archive/Twin.md": "Two.\n",
    });
    const report = await checkLinksForNote(target(root, "notes/source.md"));
    expect(report.links.find(link => link.target === "Graph Index")?.state).toBe("resolved");
    expect(report.unresolved).toEqual(["Missing Note"]);
    expect(report.ambiguous).toEqual(["Twin"]);
    expect(report.links.find(link => link.target === "Twin")?.matches).toEqual(["archive/Twin.md", "notes/Twin.md"]);
  });

  it("checks links in an unbound note and does not repair them", async () => {
    const root = await vault({
      "notes/plain.md": "Plain note linking [[Nowhere]].\n",
    });
    const report = await checkLinksForNote(target(root, "notes/plain.md"));
    expect(report.unresolved).toEqual(["Nowhere"]);
    expect(await readFile(join(root, "notes/plain.md"), "utf8")).toBe("Plain note linking [[Nowhere]].\n");
  });

  it("resolves a link written with its full vault path or heading anchor", async () => {
    const root = await vault({
      "notes/source.md": "See [[notes/Graph Index|the index]] and [[Graph Index#Summary]].\n",
      "notes/Graph Index.md": "## Summary\n",
    });
    const report = await checkLinksForNote(target(root, "notes/source.md"));
    expect(report.unresolved).toEqual([]);
    expect(report.links.map(link => link.state)).toEqual(["resolved", "resolved"]);
  });
});
