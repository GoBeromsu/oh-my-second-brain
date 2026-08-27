import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_EXCLUDE_GLOBS, matchesAnyGlob, excludedNoteMatcher } from "./note-exclude.js";

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
  it("applies only the built-in defaults when taxonomy.yaml has no exclude key", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.yaml": "folders: {}\n",
    });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("merges vault-declared exclude globs with the built-in defaults", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.yaml": "folders: {}\nexclude:\n  - \"drafts/**\"\n",
    });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded("drafts/unfinished.md")).toBe(true);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("degrades to the built-in defaults when taxonomy.yaml is missing", async () => {
    const vault = await makeVault();
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });

  it("degrades to the built-in defaults when taxonomy.yaml is malformed", async () => {
    const vault = await makeVault({
      ".oms/taxonomy.yaml": "broken: [legacy\n",
    });
    const isExcluded = await excludedNoteMatcher(vault);
    expect(isExcluded(".obsidian/workspace.md")).toBe(true);
    expect(isExcluded("notes/idea.md")).toBe(false);
  });
});
