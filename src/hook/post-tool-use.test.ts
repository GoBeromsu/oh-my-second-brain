import { describe, it, expect } from "vitest";
import {
  getDebounceAgeSeconds,
  touchDebounceStamp,
  auditNote,
  GRAPH_BUILD_DEBOUNCE_SECS,
  DEBOUNCE_STAMP_NAME,
} from "./post-tool-use.js";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function makeVault(files: Record<string, string>): Promise<{
  vaultPath: string;
  cleanup: () => Promise<void>;
}> {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "oms-post-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vaultPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return { vaultPath, cleanup: async () => rm(vaultPath, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Debounce stamp
// ---------------------------------------------------------------------------

describe("debounce stamp", () => {
  it("returns null when stamp does not exist", async () => {
    const { vaultPath, cleanup } = await makeVault({});
    try {
      const age = await getDebounceAgeSeconds(vaultPath);
      expect(age).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("creates the stamp and returns a small age immediately after", async () => {
    const { vaultPath, cleanup } = await makeVault({});
    try {
      await touchDebounceStamp(vaultPath);
      const age = await getDebounceAgeSeconds(vaultPath);
      expect(age).not.toBeNull();
      expect(age!).toBeLessThan(5); // created within 5 seconds
    } finally {
      await cleanup();
    }
  });

  it("stamp file is placed at expected path", async () => {
    const { vaultPath, cleanup } = await makeVault({});
    try {
      await touchDebounceStamp(vaultPath);
      const stampPath = path.join(vaultPath, ".oms", "cache", DEBOUNCE_STAMP_NAME);
      const s = await stat(stampPath);
      expect(s.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("GRAPH_BUILD_DEBOUNCE_SECS is 300", () => {
    expect(GRAPH_BUILD_DEBOUNCE_SECS).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// auditNote — frontmatter audit
// ---------------------------------------------------------------------------

describe("auditNote", () => {
  it("returns empty array when note has no frontmatter violations", async () => {
    // Vault with a minimal taxonomy that has no required fields → no violations.
    // The concepts/ directory must exist for loadOntology to succeed.
    const { vaultPath, cleanup } = await makeVault({
      ".oms/taxonomy.yaml": `version: 1\nfolders:\n  "notes":\n    intent: notes\n    concept: null\n`,
      ".oms/concepts/.keep": "",
      "notes/A.md": "---\ntitle: Test\n---\nBody.",
    });
    try {
      const lines = await auditNote(vaultPath, "notes/A.md");
      // No required fields declared → no violations
      expect(lines).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns empty array gracefully when taxonomy is missing (fail-open)", async () => {
    const { vaultPath, cleanup } = await makeVault({
      "notes/A.md": "---\ntitle: Test\n---\nBody.",
    });
    try {
      const lines = await auditNote(vaultPath, "notes/A.md");
      expect(lines).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns empty array when note file does not exist (fail-open)", async () => {
    const { vaultPath, cleanup } = await makeVault({});
    try {
      const lines = await auditNote(vaultPath, "nonexistent/note.md");
      expect(lines).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Constants are exported and stable
// ---------------------------------------------------------------------------

describe("post-tool-use exports", () => {
  it("exports DEBOUNCE_STAMP_NAME as a non-empty string", () => {
    expect(typeof DEBOUNCE_STAMP_NAME).toBe("string");
    expect(DEBOUNCE_STAMP_NAME.length).toBeGreaterThan(0);
  });
});
