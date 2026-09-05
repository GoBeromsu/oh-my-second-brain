import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_EXCLUDE_GLOBS, managedSourceExclusionMatcher, matchesAnyGlob, excludedNoteMatcher } from "./note-exclude.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "oms-note-exclude-"));
  roots.push(vaultPath);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(vaultPath, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return vaultPath;
}

describe("matchesAnyGlob", () => {
  it("`**` crosses a `/` boundary", () => {
    expect(matchesAnyGlob("a/b/c.template.md", ["**/*.template.md"])).toBe(true);
    expect(matchesAnyGlob("references/skip.template.md", ["**/*.template.md"])).toBe(true);
  });

  it("plain `*` does not cross a `/` boundary", () => {
    // A single-star glob anchored at the root must not reach into subfolders.
    expect(matchesAnyGlob("notes/skip.md", ["*.md"])).toBe(false);
    expect(matchesAnyGlob("skip.md", ["*.md"])).toBe(true);
  });

  it("regression: the globstar placeholder must survive the escaping step", () => {
    // If GLOBSTAR were a printable stand-in instead of an actual NUL
    // character, the `[.+^${}()|[\]\\]` escaping pass would itself escape
    // the placeholder's backslash and the later split would never match,
    // silently disabling all "**" handling. This exercises exactly that path:
    // a nested markdown file under a "**"-prefixed glob.
    expect(matchesAnyGlob("25. Digital Garden/.deploy-staging/draft.md", DEFAULT_EXCLUDE_GLOBS)).toBe(
      true,
    );
    expect(matchesAnyGlob("templates/daily/entry.template.md", ["**/*.template.md"])).toBe(true);
    expect(matchesAnyGlob("a/b/c/d/SKILL.md", ["**/SKILL.md"])).toBe(true);
  });

  it("returns false when no glob matches", () => {
    expect(matchesAnyGlob("references/clean-architecture.md", DEFAULT_EXCLUDE_GLOBS)).toBe(false);
  });
});

describe("excludedNoteMatcher", () => {
  it("applies only the built-in defaults when taxonomy.json has no exclude key", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.json": JSON.stringify({ folders: {} }),
    });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("merges vault-declared exclude globs with the built-in defaults", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.json": JSON.stringify({ folders: {}, exclude: ["drafts/**"] }),
    });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded("drafts/unfinished.md")).toBe(true);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("degrades to the built-in defaults when taxonomy.json is missing", async () => {
    const vault = await makeVault();
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("retains malformed taxonomy evidence instead of silently allowing every note", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.json": "broken: [legacy\n",
    });
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(/NOTE_EXCLUSION_RESOLUTION_FAILED.*taxonomy\.json/);
  });

  it("excludes configured folders recursively but file-valued Templater sources exactly", async () => {
    const vault = await makeVault({
      ".obsidian/templates.json": JSON.stringify({ folder: "Core" }),
      ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({
        templates_folder: "Templater",
        folder_templates: [{ folder: "Journal", template: "Mappings/daily.md" }],
        file_templates: [{ regexp: ".*", template: "Mappings/file.md" }],
        startup_templates: ["Startup/boot.md"],
      }),
    });
    const isExcluded = await excludedNoteMatcher(vault, false);
    expect(isExcluded("Core/note.md")).toBe(true);
    expect(isExcluded("Templater/note.md")).toBe(true);
    expect(isExcluded("Mappings/daily.md")).toBe(true);
    expect(isExcluded("Mappings/file.md")).toBe(true);
    expect(isExcluded("Startup/boot.md")).toBe(true);
    expect(isExcluded("Mappings/ordinary.md")).toBe(false);
    expect(isExcluded("Startup/ordinary.md")).toBe(false);
  });

  it("does not turn broad vault-walk candidate folders into note exclusions", async () => {
    const vault = await makeVault({
      "Prompts/template.md": "<% tp.file.title %>",
      "Prompts/ordinary.md": "ordinary note",
    });
    const isExcluded = await excludedNoteMatcher(vault, false);
    expect(isExcluded("Prompts/template.md")).toBe(false);
    expect(isExcluded("Prompts/ordinary.md")).toBe(false);
  });

  it("fails loudly when an external template config is malformed", async () => {
    const vault = await makeVault({
      ".obsidian/templates.json": "{broken",
    });
    await expect(excludedNoteMatcher(vault)).rejects.toThrow(
      /NOTE_EXCLUSION_RESOLUTION_FAILED.*TEMPLATE_HINT_RESOLUTION_FAILED.*templates\.json/,
    );
  });
});

describe("managedSourceExclusionMatcher", () => {
  it("excludes arbitrary managed source names through a symlink alias", async () => {
    const vault = await makeVault({ "authored/नोट 이름.md": "---\ntitle: template\n---\n" });
    await mkdir(path.join(vault, "aliases"), { recursive: true });
    await symlink(path.join(vault, "authored", "नोट 이름.md"), path.join(vault, "aliases", "copy.md"));
    const isExcluded = await managedSourceExclusionMatcher(vault, ["authored/नोट 이름.md"]);
    await expect(isExcluded("authored/नोट 이름.md")).resolves.toBe(true);
    await expect(isExcluded("aliases/copy.md")).resolves.toBe(true);
    await expect(isExcluded("notes/idea.md")).rejects.toThrow(/MANAGED_SOURCE_RESOLUTION_FAILED.*notes\/idea.md/);
  });
});
