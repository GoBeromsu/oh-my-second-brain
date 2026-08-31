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
import type { Chunk, EmbeddingProvider } from "../types.js";
import { assembleCoreSemanticEngine } from "../assemble.js";

let vault: string;
let dbDir: string;
let dbPath: string;
const OLD_SHA256 = "a".repeat(64);
const NEW_SHA256 = "b".repeat(64);

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

  it("skips every dot-directory during a walk and rejects one explicitly", async () => {
    writeDoc("visible.md", "# Visible\nsearchable");
    writeDoc(".gjc/session/plan.md", "# Internal\nmust not be searchable");
    writeDoc(".future-tool/cache.md", "# Future\nalso internal");

    const walked = await syncEngineStore({ vault, dbPath, embed: false });

    expect(walked).toMatchObject({ available: true, scanned: 1 });
    const store = openEngineStoreCore(dbPath);
    try {
      expect(store.listDocPaths()).toEqual(["visible.md"]);
    } finally {
      store.close();
    }

    const explicit = await syncEngineStore({
      vault,
      dbPath,
      files: [".gjc/session/plan.md"],
      embed: false,
    });
    expect(explicit.available).toBe(false);
    expect(explicit.reason).toMatch(/ignored vault directory/);
  });
});

describe("syncEngineStore — caller-owned provider concurrency", () => {
  it("uses every independent provider lane and does not dispose the caller's pool", async () => {
    // Integration/medium: real files + real SQLite exercise the complete sync
    // boundary. Only the native model is replaced, at the narrow provider seam.
    // A four-party barrier proves concurrency without sleep or wall-clock reads.
    // Parallel scheduling enters all four embeds and releases the batch; a
    // sequential implementation can enter only one and the test deterministically
    // times out instead of sometimes passing based on filesystem callback order.
    for (let i = 0; i < 8; i += 1) {
      writeDoc(`notes/${i}.md`, `# Note ${i}\ncontent lane ${i}`);
    }

    let active = 0;
    let maxActive = 0;
    let disposals = 0;
    let waiting: Array<(vector: Float32Array) => void> = [];
    const provider: EmbeddingProvider = {
      model: "test:four-lane-provider",
      dimensions: 4,
      maxConcurrency: 4,
      embed: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<Float32Array>((resolve) => {
          waiting.push(resolve);
          if (waiting.length !== 4) return;
          const batch = waiting;
          waiting = [];
          active -= batch.length;
          for (const release of batch) release(new Float32Array([1, 0, 0, 0]));
        });
      },
      dispose: async () => {
        disposals += 1;
      },
    };

    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      embeddingModel: "four-lane.gguf",
      embeddingRevision: "v1",
      embeddingSha256: NEW_SHA256,
      embeddingDimensions: 4,
      embeddingContext: 2048,
      embeddingMrlDim: 0,
      embeddingNormalization: "l2",
      embeddingPrefixScheme: "embeddinggemma-v1",
      embeddingProviderInstance: provider,
    });

    expect(result).toMatchObject({ available: true, scanned: 8, added: 8 });
    expect(maxActive).toBe(4);
    expect(disposals).toBe(0);
  });

  it("rejects a caller-owned provider whose width contradicts the descriptor", async () => {
    writeDoc("note.md", "# Note\ncontent");
    const provider: EmbeddingProvider = {
      model: "test:wrong-width",
      dimensions: 3,
      embed: async () => new Float32Array(3),
      dispose: async () => undefined,
    };

    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      embeddingModel: "four-wide.gguf",
      embeddingRevision: "v1",
      embeddingSha256: NEW_SHA256,
      embeddingDimensions: 4,
      embeddingContext: 2048,
      embeddingMrlDim: 0,
      embeddingNormalization: "l2",
      embeddingPrefixScheme: "embeddinggemma-v1",
      embeddingProviderInstance: provider,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/exposes 3 dimensions.*requires 4/);
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

describe("syncEngineStore — unconfigured embedding capability", () => {
  /** Every shape field a vector sync needs, so only provider/model are missing. */
  const shape = {
    embeddingRevision: "some-revision",
    embeddingSha256: NEW_SHA256,
    embeddingDimensions: 768,
    embeddingContext: 2048,
    embeddingMrlDim: 768,
    embeddingNormalization: "l2",
    embeddingPrefixScheme: "none",
  } as const;

  it("tells the user how to configure a model, not just that one is missing", async () => {
    // `oms embed` is the command that builds the index, so it is where a user most
    // often discovers no model is configured. It answered with a bare "Embedding
    // provider is required." — stating the problem while withholding every remedy.
    const result = await syncEngineStore({ vault, dbPath, embed: true, ...shape });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/OMS_EMBEDDING_PROVIDER/);
    expect(result.reason).toMatch(/OMS_EMBEDDING_MODEL/);
    expect(result.reason).toMatch(/\.oms\/models\.json/);
    expect(result.reason).toMatch(/oms setup --models-default/);
  });

  it("guides the same way when only the model is missing", async () => {
    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      ...shape,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/OMS_EMBEDDING_MODEL/);
    expect(result.reason).toMatch(/oms setup --models-default/);
  });

  it("does not attach capability guidance to an incomplete descriptor shape", async () => {
    // The asymmetry is deliberate. A missing prompt scheme means the descriptor is
    // incomplete, not that the capability is unconfigured, so telling the reader to
    // "set OMS_EMBEDDING_PROVIDER" would send them to fix something already set.
    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      embeddingModel: "some-model",
      embeddingRevision: "some-revision",
      embeddingSha256: NEW_SHA256,
      embeddingDimensions: 768,
      embeddingContext: 2048,
      embeddingMrlDim: 768,
      embeddingNormalization: "l2",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/prefixScheme is required/);
    expect(result.reason).not.toMatch(/oms setup --models-default/);
  });

  it("still performs a lex-only sync without any embedding configuration", async () => {
    // The guidance must not turn an unconfigured model into a blocked vault: the
    // lexical path is the half that is supposed to keep working.
    writeDoc("notes/lexical.md", "# Lexical\nthis text is searchable without a model");

    const result = await syncEngineStore({ vault, dbPath, embed: false });

    expect(result.available).toBe(true);
  });
});

describe("syncEngineStore — fingerprint mismatch policy", () => {
  function seedIdentity(model: string, revision = "old-revision", sha256 = OLD_SHA256): void {
    const seeded = openEngineStore(dbPath, 768);
    try {
      seeded.writeEmbeddingIdentity(
        makeEmbeddingIdentity({
          provider: "gguf",
          model,
          revision,
          sha256,
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
    seedIdentity("new-model");
    writeDoc("notes/must-not-write.md", "# Must not write\nidentity mismatch must stop vector writes");

    // Empty vault → zero embed() calls → the lazy GGUF provider never loads a model.
    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      embeddingProvider: "gguf",
      embeddingModel: "new-model",
      embeddingRevision: "new-revision",
      embeddingSha256: NEW_SHA256,
      embeddingDimensions: 768,
      embeddingContext: 2048,
      embeddingMrlDim: 768,
      embeddingNormalization: "l2",
      embeddingPrefixScheme: "none",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
    expect(result.storedIdentity?.revision).toBe("old-revision");
    expect(result.storedIdentity?.sha256).toBe(OLD_SHA256);
    expect(result.configuredIdentity?.model).toBe("new-model");
    expect(result.configuredIdentity?.revision).toBe("new-revision");
    expect(result.configuredIdentity?.sha256).toBe(NEW_SHA256);
    const store = openEngineStore(dbPath, 768);
    try {
      expect(store.listDocPaths()).toEqual([]);
      expect(store.readEmbeddingIdentity()?.sha256).toBe(OLD_SHA256);
    } finally {
      store.close();
    }
  });

  it("rebuilds destructively and overwrites identity only when force=true", async () => {
    seedIdentity("new-model");

    const result = await syncEngineStore({
      vault,
      dbPath,
      embed: true,
      force: true,
      embeddingProvider: "gguf",
      embeddingModel: "new-model",
      embeddingRevision: "new-revision",
      embeddingSha256: NEW_SHA256,
      embeddingDimensions: 768,
      embeddingContext: 2048,
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
      expect(identity?.revision).toBe("new-revision");
      expect(identity?.sha256).toBe(NEW_SHA256);
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
