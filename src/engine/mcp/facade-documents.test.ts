import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpEngineAdapter } from "./facade.js";
import type { DispatcherDeps } from "../retrieval/dispatcher.js";
import type { EmbeddingProvider, VectorStore } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal fakes — getDocument / multiGetDocuments are file-based; no model
// ---------------------------------------------------------------------------

function makeStore(): VectorStore {
  return {
    upsert: vi.fn(),
    queryLex: vi.fn().mockReturnValue([]),
    queryVec: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
}

function makeEmbed(): EmbeddingProvider {
  return {
    model: "test",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue(new Float32Array([0, 0, 0, 0])),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(): DispatcherDeps {
  return { store: makeStore(), embed: makeEmbed() };
}

// ---------------------------------------------------------------------------
// Temp-vault fixture
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function freshVault(): { dir: string; adapter: McpEngineAdapter } {
  const dir = mkdtempSync(path.join(tmpdir(), "oms-docs-"));
  tempDirs.push(dir);

  // note.md — 4 lines, H1 title on line 1
  writeFileSync(
    path.join(dir, "note.md"),
    "# Note Title\nsecond line\nthird line\nfourth line",
  );
  // a.md — small file for multiGet / maxBytes tests
  writeFileSync(path.join(dir, "a.md"), "# A\ncontent of a");
  // b.md — same size as a.md
  writeFileSync(path.join(dir, "b.md"), "# B\ncontent of b");

  const adapter = new McpEngineAdapter(makeDeps(), dir);
  return { dir, adapter };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getDocument
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.getDocument — full file", () => {
  it("returns available:true with full content for a plain target", async () => {
    const { adapter } = freshVault();
    const result = await adapter.getDocument({ target: "note.md" });
    expect(result.available).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("# Note Title");
    expect(result.documents[0]!.content).toContain("fourth line");
    expect(result.documents[0]!.title).toBe("Note Title");
    expect(result.documents[0]!.path).toBe("note.md");
  });
});

describe("McpEngineAdapter.getDocument — line range", () => {
  it("returns only lines 2-3 for target 'note.md:2-3'", async () => {
    const { adapter } = freshVault();
    const result = await adapter.getDocument({ target: "note.md:2-3" });
    expect(result.available).toBe(true);
    expect(result.documents[0]!.content).toBe("second line\nthird line");
  });
});

describe("McpEngineAdapter.getDocument — lineNumbers", () => {
  it("prefixes content with 'N\\t' when lineNumbers:true", async () => {
    const { adapter } = freshVault();
    const result = await adapter.getDocument({ target: "note.md:2", lineNumbers: true });
    expect(result.available).toBe(true);
    expect(result.documents[0]!.content).toBe("2\tsecond line");
  });
});

describe("McpEngineAdapter.getDocument — unsafe target", () => {
  it("returns available:false for path-traversal target", async () => {
    const { adapter } = freshVault();
    const result = await adapter.getDocument({ target: "../../../etc/passwd" });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("vault");
  });
});

describe("McpEngineAdapter.getDocument — missing file", () => {
  it("returns available:false when the file does not exist", async () => {
    const { adapter } = freshVault();
    const result = await adapter.getDocument({ target: "nope.md" });
    expect(result.available).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// multiGetDocuments
// ---------------------------------------------------------------------------

describe("McpEngineAdapter.multiGetDocuments — both docs", () => {
  it("returns available:true with two documents", async () => {
    const { adapter } = freshVault();
    const result = await adapter.multiGetDocuments({ targets: ["a.md", "b.md"] });
    expect(result.available).toBe(true);
    expect(result.documents).toHaveLength(2);
    const paths = result.documents.map((d) => d.path);
    expect(paths).toContain("a.md");
    expect(paths).toContain("b.md");
  });
});

describe("McpEngineAdapter.multiGetDocuments — maxBytes truncation", () => {
  it("returns partial results (available:true) when second doc would exceed maxBytes", async () => {
    const { adapter, dir } = freshVault();
    // a.md content is "# A\ncontent of a" = 16 bytes; set maxBytes so second would exceed
    const aStat = Buffer.byteLength("# A\ncontent of a", "utf-8");
    const result = await adapter.multiGetDocuments({
      targets: ["a.md", "b.md"],
      maxBytes: aStat, // exactly enough for a.md but not a.md + b.md
    });
    // Suppress unused-variable warning by referencing dir
    void dir;
    expect(result.available).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.path).toBe("a.md");
  });
});

describe("McpEngineAdapter.multiGetDocuments — unsafe target", () => {
  it("returns available:false and stops on path-traversal target", async () => {
    const { adapter } = freshVault();
    const result = await adapter.multiGetDocuments({ targets: ["../../../etc/passwd", "a.md"] });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("vault");
  });
});

describe("McpEngineAdapter.multiGetDocuments — missing file skipped", () => {
  it("skips missing files and still returns available:true for the rest", async () => {
    const { adapter } = freshVault();
    const result = await adapter.multiGetDocuments({ targets: ["nope.md", "a.md"] });
    expect(result.available).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.path).toBe("a.md");
  });
});
