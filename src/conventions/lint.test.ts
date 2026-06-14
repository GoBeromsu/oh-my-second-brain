import { describe, it, expect } from "vitest";
import { extractWikilinks, detectLinkIssues } from "./lint.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

describe("extractWikilinks", () => {
  it("extracts a simple wikilink", () => {
    expect(extractWikilinks("See [[Note A]] for details.")).toContain("Note A");
  });

  it("strips the alias portion", () => {
    const links = extractWikilinks("[[Note A|display text]]");
    expect(links).toContain("Note A");
    expect(links).not.toContain("display text");
  });

  it("strips the heading anchor", () => {
    const links = extractWikilinks("[[Note A#section]]");
    expect(links).toContain("Note A");
  });

  it("deduplicates repeated links", () => {
    const links = extractWikilinks("[[A]] [[A]] [[B]]");
    expect(links.filter((l) => l === "A")).toHaveLength(1);
  });

  it("returns empty array for text with no wikilinks", () => {
    expect(extractWikilinks("No links here.")).toHaveLength(0);
  });

  it("handles multiple wikilinks on one line", () => {
    const links = extractWikilinks("See [[Alpha]] and [[Beta]] and [[Gamma]].");
    expect(links).toContain("Alpha");
    expect(links).toContain("Beta");
    expect(links).toContain("Gamma");
  });
});

// ---------------------------------------------------------------------------
// detectLinkIssues
// ---------------------------------------------------------------------------

async function makeVault(
  files: Record<string, string>,
): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "oms-lint-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vaultPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return {
    vaultPath,
    cleanup: async () => rm(vaultPath, { recursive: true, force: true }),
  };
}

describe("detectLinkIssues", () => {
  it("reports no issues for a vault with valid wikilinks", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/A.md": "---\ntitle: A\n---\nSee [[B]].",
      "notes/B.md": "---\ntitle: B\n---\nContent.",
    });
    try {
      const result = await detectLinkIssues(vaultPath);
      expect(result.brokenLinks).toHaveLength(0);
      expect(result.totalNotes).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("detects a broken wikilink", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/A.md": "See [[NonExistent]].",
    });
    try {
      const result = await detectLinkIssues(vaultPath);
      expect(result.brokenLinks).toHaveLength(1);
      expect(result.brokenLinks[0]?.target).toBe("NonExistent");
      expect(result.brokenLinks[0]?.notePath).toMatch(/A\.md$/);
    } finally {
      await cleanup();
    }
  });

  it("is case-insensitive for wikilink resolution", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/MyNote.md": "body",
      "notes/Ref.md": "Links to [[mynote]].",
    });
    try {
      const result = await detectLinkIssues(vaultPath);
      expect(result.brokenLinks).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("identifies orphan notes (no incoming links)", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/A.md": "Links to [[B]].",
      "notes/B.md": "No outgoing links.",
      "notes/Orphan.md": "Nobody links here.",
    });
    try {
      const result = await detectLinkIssues(vaultPath);
      const orphanNames = result.orphanPaths.map((p) => path.basename(p));
      expect(orphanNames).toContain("Orphan.md");
      // A links to B so B is not orphan; A itself is orphan (nobody links to A)
      expect(orphanNames).toContain("A.md");
      expect(orphanNames).not.toContain("B.md");
    } finally {
      await cleanup();
    }
  });

  it("skips .oms and .obsidian directories", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/A.md": "content",
      ".oms/cache/something.md": "internal",
      ".obsidian/plugins/plugin.md": "internal",
    });
    try {
      const result = await detectLinkIssues(vaultPath);
      expect(result.totalNotes).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("handles an empty vault", async () => {
    const { vaultPath, cleanup } = await makeVault({});
    try {
      const result = await detectLinkIssues(vaultPath);
      expect(result.totalNotes).toBe(0);
      expect(result.brokenLinks).toHaveLength(0);
      expect(result.orphanPaths).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
