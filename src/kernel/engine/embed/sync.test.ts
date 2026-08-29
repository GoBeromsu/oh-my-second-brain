/**
 * Engine semantic contract tests (RALPLAN: OMS semantic engine cleanup).
 *
 * Proves the locked contract WITHOUT loading a real embedding model:
 *   1. embed=false is a lex-only sync — no vectors, no identity, provenance warning.
 *   2. Core-only store supports lexical search but throws on vector ops.
 *   3. sqlite-vec unavailability is deterministic (injected throwing loader):
 *      core schema + lex stay usable; vec ops throw (no silent empty hits).
 *   4. Fingerprint mismatch fails fast by default (structured stored+configured
 *      identity) and rebuilds destructively + overwrites identity only with force.
 *   5. The core semantic engine answers lex-only queries but fails fast on a
 *      vec/HyDE request when no real embedding provider is configured.
 *
 * GGUF model loading never happens here: providers are lazy, so an empty vault
 * (zero embed() calls) and the deferred provider keep every assertion offline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncEngineStore } from "./sync.js";
import { openEngineStore, openEngineStoreCore } from "./store.js";
import { makeEmbeddingIdentity } from "./identity.js";
import type { Chunk } from "../types.js";
import { assembleCoreSemanticEngine } from "../assemble.js";

let vault: string;
let dbDir: string;
let dbPath: string;

function writeDoc(rel: string, content: string): void {
  const full = path.join(vault, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function lexChunk(docPath: string, text: string): Chunk {
  return { docPath, ordinal: 0, text, title: "Test Document", headingPath: [], sha: `${docPath}:0` };
}

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), "oms-sync-vault-"));
  dbDir = mkdtempSync(path.join(tmpdir(), "oms-sync-db-"));
  dbPath = path.join(dbDir, "engine-store.sqlite");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) embed=false → lex-only sync
// ---------------------------------------------------------------------------

describe("syncEngineStore — embed=false (lex-only)", () => {
  it("indexes lexically, writes no embedding identity, and emits a provenance warning", async () => {
    writeDoc("notes/alpha.md", "# Alpha\nretrieval augmented generation over a knowledge graph");

    const result = await syncEngineStore({ vault, dbPath, embed: false });

    expect(result.available).toBe(true);
    expect(result.added).toBeGreaterThan(0);
    expect(result.warnings?.some((w) => /embed=false/i.test(w))).toBe(true);

    const store = openEngineStoreCore(dbPath);
    try {
      // embed=false MUST NOT record embedding identity.
      expect(store.readEmbeddingIdentity()).toBeNull();
      const hits = store.queryLex("retrieval augmented", 5);
      expect(hits.map((h) => h.docPath)).toContain("notes/alpha.md");
    } finally {
      store.close();
    }
  });

  it("indexes only the explicit file slice", async () => {
    writeDoc("notes/alpha.md", "# Alpha\nretrieval augmented generation");
    writeDoc("notes/beta.md", "# Beta\nunrelated database migration");

    const result = await syncEngineStore({
      vault,
      dbPath,
      files: ["notes/alpha.md"],
      embed: false,
    });

    expect(result.available).toBe(true);
    expect(result.scanned).toBe(1);
    const store = openEngineStoreCore(dbPath);
    try {
      expect(store.listDocPaths()).toEqual(["notes/alpha.md"]);
      expect(store.queryLex("retrieval augmented", 5).map((hit) => hit.docPath))
        .toEqual(["notes/alpha.md"]);
      expect(store.queryLex("database migration", 5)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects explicit files that escape the vault", async () => {
    const result = await syncEngineStore({
      vault,
      dbPath,
      files: ["../outside.md"],
      embed: false,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/inside the vault|markdown path/i);
  });
});

// ---------------------------------------------------------------------------
// (2) core-only store vec gating
// ---------------------------------------------------------------------------

describe("openEngineStoreCore — vec gating", () => {
  it("supports lexical search but throws on vector upsert/query", () => {
    const store = openEngineStoreCore(dbPath);
    try {
      expect(store.capabilities().vecAvailable).toBe(false);
      store.upsertLex([lexChunk("a.md", "graph neural networks and embeddings")]);
      expect(store.queryLex("graph neural", 5).map((h) => h.docPath)).toContain("a.md");
      expect(() => store.queryVec(new Float32Array(8), 5)).toThrow();
      expect(() => store.upsert([])).toThrow();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) sqlite-vec unavailability is deterministic (injected loader throws)
// ---------------------------------------------------------------------------

describe("openEngineStore — sqlite-vec unavailable (injected loader)", () => {
  it("keeps core schema + lex usable while vector ops throw (no silent empty hits)", () => {
    const store = openEngineStore(dbPath, 768, {
      sqliteVecLoader: () => {
        throw new Error("sqlite-vec extension unavailable");
      },
    });
    try {
      expect(store.capabilities().vecAvailable).toBe(false);
      store.upsertLex([lexChunk("b.md", "semantic readiness rules and fingerprints")]);
      expect(store.queryLex("semantic readiness", 5).map((h) => h.docPath)).toContain("b.md");
      // Vector usage must fail loudly, never degrade to an empty result.
      expect(() => store.queryVec(new Float32Array(768), 5)).toThrow();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) fingerprint mismatch: fail fast by default, force-only destructive rebuild
// ---------------------------------------------------------------------------

describe("syncEngineStore — fingerprint mismatch policy", () => {
  function seedIdentity(model: string): void {
    const seeded = openEngineStore(dbPath, 768);
    try {
      seeded.writeEmbeddingIdentity(
        makeEmbeddingIdentity({
          provider: "gguf",
          model,
          dimensions: 768,
          contextLength: 2048,
          mrlDim: 768,
          normalization: "l2",
          prefixScheme: "none",
        }),
      );
    } finally {
      seeded.close();
    }
  }

  it("fails fast and reports stored+configured identity when identity differs (no force)", async () => {
    seedIdentity("old-model");

    // Empty vault → zero embed() calls → the lazy GGUF provider never loads a model.
    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      embeddingModel: "new-model",
      embeddingContextLength: 2048,
      embeddingMrlDim: 768,
      embeddingNormalization: "l2",
      embeddingPrefixScheme: "none",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
    expect(result.storedIdentity?.model).toBe("old-model");
    expect(result.configuredIdentity?.model).toBe("new-model");
  });

  it("rebuilds destructively and overwrites identity only when force=true", async () => {
    seedIdentity("old-model");

    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      force: true,
      embeddingProvider: "gguf",
      embeddingModel: "new-model",
      embeddingContextLength: 2048,
      embeddingMrlDim: 768,
      embeddingNormalization: "l2",
      embeddingPrefixScheme: "none",
    });
    expect(result.available).toBe(true);

    const store = openEngineStore(dbPath, 768);
    try {
      const identity = store.readEmbeddingIdentity();
      expect(identity?.provider).toBe("gguf");
      expect(identity?.model).toBe("new-model");
      // vec0 was dropped + recreated, so vectors remain queryable post-rebuild.
      expect(store.capabilities().vecAvailable).toBe(true);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) core semantic engine: lex usable, vec/HyDE fails fast without embeddings
// ---------------------------------------------------------------------------

describe("assembleCoreSemanticEngine — lex usable, vec fails fast", () => {
  it("answers lex-only queries but fails fast on a vec request without embeddings", async () => {
    writeDoc("notes/topic.md", "# Topic\nknowledge graph retrieval and semantic search notes");

    // Populate the lexical index without embeddings (lex/graph stay usable).
    const sync = await syncEngineStore({ vault, dbPath, embed: false });
    expect(sync.available).toBe(true);

    const engine = assembleCoreSemanticEngine({ vault, dbPath });
    try {
      const lex = await engine.adapter.semanticQuery({ query: "knowledge graph", lex: "knowledge graph" });
      expect(lex.available).toBe(true);
      if (lex.available) {
        expect(lex.hits.map((h) => h.path)).toContain("notes/topic.md");
      }

      const vec = await engine.adapter.semanticQuery({ query: "knowledge graph", vec: "knowledge graph" });
      expect(vec.available).toBe(false);
      if (!vec.available) {
        expect(vec.reason).toMatch(/OMS_EMBEDDING_PROVIDER|embedding provider/i);
      }
    } finally {
      await engine.dispose();
    }
  });
});
