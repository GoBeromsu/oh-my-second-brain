/**
 * Assemble smoke test — wires the real GGUF model to a throwaway fixture vault.
 *
 * REAL_MODEL tests are gated on OMS_MODEL_PATH (or ASSEMBLE_SMOKE env var).
 * The stub-wiring tests (no model) always run and cover the guard + adapter construction.
 *
 * Fixture vault: 5 markdown files on distinct topics (astronomy, cooking, programming,
 * philosophy, music) created in a temp dir. A throwaway SQLite DB is created in
 * another temp dir. Both are cleaned up in afterAll.
 *
 * Assertions:
 *   1. assembleEngine() WITHOUT embedding provider/model → THROWS.
 *   2. assembleEngine() WITH provider=gguf + real model path → adapter constructed.
 *   3. syncVault() → syncs fixture, stores real 768d embeddings.
 *   4. vec0 stored dimension == 768 (proven via sqlite_master DDL).
 *   5. semantic query via adapter → astronomy doc ranks #1 for astronomy query.
 *   6. off-topic doc (cooking) scores lower than astronomy doc.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  assembleCoreSemanticEngine,
  assembleEngine,
  assembleEphemeralCoreSemanticEngine,
} from "./assemble.js";
import { requireRealEmbeddingProvider } from "./embed/provider.js";
import {
  INSTALLED_MODELS_RECEIPT,
  type EmbeddingModelDescriptor,
  type InstalledModelsReceipt,
} from "./embed/model.js";
import {
  canonicalModelIdentityKey,
  type ModelsConfigV1,
  type PortableModelSelection,
} from "./embed/config.js";
import { assembleSemanticEngine } from "../semantic/semantic-engine.js";

const TEST_SHA256 = "a".repeat(64);

function embeddingDescriptor(modelPath: string): EmbeddingModelDescriptor {
  return {
    provider: "gguf",
    model: path.basename(modelPath),
    path: modelPath,
    revision: "test-revision",
    sha256: TEST_SHA256,
    dimensions: 768,
    context: 2048,
    mrlDim: 0,
    normalization: "l2",
    prefixScheme: "embeddinggemma-v1",
  };
}

function selection(
  model: string,
  promptScheme?: string,
): PortableModelSelection {
  return {
    provider: "gguf",
    model,
    revision: "test-revision",
    sha256: TEST_SHA256,
    ...(promptScheme === undefined ? {} : { promptScheme }),
  };
}

// ---------------------------------------------------------------------------
// Fixture vault content
// ---------------------------------------------------------------------------

const FIXTURE_FILES: Record<string, string> = {
  "astronomy.md": `# Astronomy and the Cosmos
The universe contains billions of galaxies, each with billions of stars.
Black holes form when massive stars collapse under their own gravity.
The cosmic microwave background radiation is evidence of the Big Bang.
Telescopes like Hubble and James Webb observe light from billions of light-years away.
Planets orbit stars in solar systems; our Sun is a medium-sized yellow dwarf.
`,
  "cooking.md": `# Cooking Techniques and Recipes
Sautéing vegetables in olive oil brings out their natural flavors.
Baking bread requires precise measurements of flour, water, yeast, and salt.
A good stock is the foundation of many soups and sauces.
Knife skills are essential: julienne, brunoise, and chiffonade are classic cuts.
Maillard reaction creates the brown crust and complex flavors in seared meat.
`,
  "programming.md": `# Programming and Software Engineering
Algorithms define the steps to solve computational problems efficiently.
Data structures like trees, graphs, and hash maps organize information.
Object-oriented programming uses classes and inheritance for code reuse.
Functional programming treats computation as the evaluation of mathematical functions.
Version control with Git enables collaborative development and history tracking.
`,
  "philosophy.md": `# Philosophy and Ethics
Epistemology asks how we can know anything with certainty.
Socrates claimed wisdom begins with knowing what you do not know.
Utilitarianism judges actions by the greatest good for the greatest number.
Kantian ethics focuses on duty and the categorical imperative.
Existentialism holds that existence precedes essence in human life.
`,
  "music.md": `# Music Theory and Composition
Harmony describes the simultaneous sounding of pitches to form chords.
Counterpoint is the technique of combining melodic lines in polyphony.
Rhythm organizes sounds in time through patterns of beats and rests.
The circle of fifths maps relationships between the twelve major and minor keys.
Dynamics in music range from pianissimo (very soft) to fortissimo (very loud).
`,
};

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

// Real-model smoke runs are opt-in: provide the model via OMS_MODEL_PATH.
const MODEL_PATH = process.env["OMS_MODEL_PATH"] ?? "";
const SMOKE_ENABLED = MODEL_PATH !== "" && (process.env["ASSEMBLE_SMOKE"] === "1" || process.env["OMS_MODEL_PATH"] !== undefined);

// ---------------------------------------------------------------------------
// Temp dirs (created/cleaned per describe block that needs them)
// ---------------------------------------------------------------------------

let fixtureVault = "";
let fixtureDb = "";

function createFixture(): void {
  fixtureVault = mkdtempSync(path.join(tmpdir(), "oms-assemble-smoke-vault-"));
  fixtureDb = path.join(
    mkdtempSync(path.join(tmpdir(), "oms-assemble-smoke-db-")),
    "engine-store.sqlite",
  );
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    writeFileSync(path.join(fixtureVault, name), content, "utf-8");
  }
}

function cleanupFixture(): void {
  if (fixtureVault) {
    try { rmSync(fixtureVault, { recursive: true, force: true }); } catch { /* ignore */ }
    fixtureVault = "";
  }
  if (fixtureDb) {
    try { rmSync(path.dirname(fixtureDb), { recursive: true, force: true }); } catch { /* ignore */ }
    fixtureDb = "";
  }
}

// ---------------------------------------------------------------------------
// Helper: read vec0 DDL from sqlite_master to extract baked dimension
// ---------------------------------------------------------------------------

function readVec0Dimension(dbPath: string): number | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='engine_chunk_vec'",
    ).get() as { sql: string } | undefined;
    if (!row) return null;
    // DDL looks like: CREATE VIRTUAL TABLE engine_chunk_vec USING vec0(embedding float[768])
    const match = /float\[(\d+)\]/.exec(row.sql);
    return match ? parseInt(match[1]!, 10) : null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Guard test — always runs (no model needed)
// ---------------------------------------------------------------------------

/**
 * An explicitly empty capability environment.
 *
 * Without this, a "nothing configured" test reads the developer's real
 * `~/.cache/oms/models/installed-models.json` and their real `process.env`. On a
 * machine that has run `oms setup`, the resolver then finds a genuine model,
 * assembly succeeds, and the test fails — while passing on a machine with no model
 * installed. Same commit, opposite results, decided by ambient state.
 *
 * Injecting an empty receipt plus an empty env states the precondition the test
 * name already claims, and has the side benefit that no model is loaded: the
 * ambient-state version spent four seconds pulling a 600 MB GGUF into memory
 * inside a suite labelled "no model needed".
 */
const NOTHING_CONFIGURED = {
  installedModelsReceipt: { schemaVersion: 1, artifacts: [], defaults: [] },
  modelEnv: {},
} as const;

describe("assembleEngine — strict guard (no model needed)", () => {
  it("THROWS asking for OMS_EMBEDDING_PROVIDER when no provider/model configured", () => {
    expect(() =>
      assembleEngine({ vault: "/tmp/fake-vault", ...NOTHING_CONFIGURED }),
    ).toThrow("OMS_EMBEDDING_PROVIDER");
  });

  it("THROWS asking for OMS_EMBEDDING_MODEL when provider is set but model is missing", () => {
    expect(() =>
      assembleEngine({ vault: "/tmp/fake-vault", embeddingProvider: "gguf", ...NOTHING_CONFIGURED }),
    ).toThrow("OMS_EMBEDDING_MODEL");
  });

  it("reports unavailable through the receipt, not through the developer's machine", () => {
    // Pins the isolation itself. If someone later drops the injected receipt, this
    // test keeps passing on an unconfigured machine and starts failing on a
    // configured one — so assert that resolution consumed the empty receipt by
    // checking the guidance names the embed remedy rather than succeeding.
    let message = "";
    try {
      assembleEngine({ vault: "/tmp/fake-vault", ...NOTHING_CONFIGURED });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/OMS_EMBEDDING_PROVIDER/);
    expect(message).toMatch(/OMS_EMBEDDING_MODEL/);
  });

  it("requireRealEmbeddingProvider THROWS when no provider/model configured", () => {
    expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_EMBEDDING_PROVIDER");
  });

  it("keeps explicit expansion model-dependent on a core engine", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-core-expand-"));
    const engine = assembleCoreSemanticEngine({
      vault,
      modelEnv: {},
      installedModelsReceipt: { schemaVersion: 1, artifacts: [], defaults: [] },
      queryExpander: async () => [
        { type: "vec" as const, query: "expanded semantic query" },
      ],
    });
    try {
      const result = await engine.adapter.semanticQuery({
        query: "expand me",
        strategy: { kind: "expand", profile: "qmd-v2.8.3" },
      });
      expect(result.available).toBe(false);
      if (result.available) return;
      expect(result.reason).toContain("OMS_EMBEDDING_PROVIDER");
      expect(result.reason).toContain("OMS_EMBEDDING_MODEL");
    } finally {
      await engine.dispose();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("does not let one injected generator seam activate another from ambient state", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-core-generator-seam-"));
    const engine = assembleCoreSemanticEngine({
      vault,
      queryExpander: async () => [
        { type: "lex" as const, query: "injected expansion" },
      ],
    });
    try {
      const result = await engine.adapter.semanticQuery({
        query: "explicit hyde",
        hyde: "explicit hyde",
      });
      expect(result.available).toBe(false);
      if (result.available) return;
      expect(result.reason).toContain("OMS_GENERATE_PROVIDER");
      expect(result.reason).toContain("OMS_GENERATE_MODEL");
    } finally {
      await engine.dispose();
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stub-wiring test — adapter construction with fake provider (always runs)
// ---------------------------------------------------------------------------

describe("assembleEngine — strict descriptor wiring", () => {
  it("constructs an adapter from an absolute descriptor path without loading the model", () => {
    let tmpVault = "";
    let tmpDb = "";
    try {
      tmpVault = mkdtempSync(path.join(tmpdir(), "oms-stub-vault-"));
      tmpDb = path.join(
        mkdtempSync(path.join(tmpdir(), "oms-stub-db-")),
        "stub.sqlite",
      );
      const engine = assembleEngine({
        vault: tmpVault,
        dbPath: tmpDb,
        embeddingDescriptor: embeddingDescriptor(path.join(tmpVault, "model.gguf")),
      });
      expect(engine.adapter).toBeDefined();
      expect(engine.provider.model).toContain("model.gguf");
      // No embed() called — dispose is safe
      void engine.dispose();
    } finally {
      if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
      if (tmpDb) rmSync(path.dirname(tmpDb), { recursive: true, force: true });
    }
  });
});

describe("assembly-level explicit file selection", () => {
  it("syncs only the requested files instead of walking the whole vault", async () => {
    // Integration/medium: use a real temporary vault because this regression lived
    // at the assembly → filesystem-sync boundary. A fake dispatcher would happily
    // accept `files` even when assembly forgot to forward it, which is the exact bug
    // this test protects.
    const vault = mkdtempSync(path.join(tmpdir(), "oms-explicit-sync-"));
    writeFileSync(path.join(vault, "selected.md"), "# Selected\n\nunique selected phrase\n");
    writeFileSync(path.join(vault, "not-selected.md"), "# Other\n\nunique excluded phrase\n");
    const engine = assembleEphemeralCoreSemanticEngine({
      vault,
      ...NOTHING_CONFIGURED,
    });

    try {
      const result = await engine.syncVault({
        files: ["selected.md"],
        embed: false,
      });

      expect(result).toMatchObject({ scanned: 1, added: 1, available: true });
      expect(engine.store.queryLex("unique selected phrase", 5).map((hit) => hit.docPath))
        .toContain("selected.md");
      // Query one token that exists only in the excluded file. The earlier phrase
      // `"unique excluded phrase"` also shared `unique` and `phrase` with the
      // selected note, so FTS correctly returned it and the test falsely blamed
      // file selection for ordinary term matching.
      expect(engine.store.queryLex("excluded", 5)).toEqual([]);
    } finally {
      await engine.dispose();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("rejects an explicit path that escapes the vault", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-explicit-sync-"));
    const engine = assembleEphemeralCoreSemanticEngine({
      vault,
      ...NOTHING_CONFIGURED,
    });

    try {
      const result = await engine.syncVault({
        files: ["../outside.md"],
        embed: false,
      });

      // Sync is a receipt API: input and capability failures are represented as an
      // unavailable result so CLI and MCP callers can report them uniformly.
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/inside the vault/);
    } finally {
      await engine.dispose();
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("assembly reranker ownership", () => {
  it("does not resolve an owned reranker before use, including disposal", async () => {
    let constructions = 0;
    const vault = mkdtempSync(path.join(tmpdir(), "oms-reranker-lazy-"));
    try {
      const engine = assembleEphemeralCoreSemanticEngine({
        vault,
        rerankerFactory: () => {
          constructions += 1;
          throw new Error("must not construct before an explicit rerank");
        },
      });
      await engine.dispose();
      expect(constructions).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("does not dispose a caller-owned reranker", async () => {
    let disposals = 0;
    const callerOwned = {
      async rerank() { return []; },
      async dispose() { disposals += 1; },
    };
    const vault = mkdtempSync(path.join(tmpdir(), "oms-reranker-caller-owned-"));
    try {
      const engine = assembleEphemeralCoreSemanticEngine({ vault, reranker: callerOwned });
      await Promise.all([engine.dispose(), engine.dispose()]);
      expect(disposals).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("assembly model capability status", () => {
  it("resolves explicit embed, environment rerank, and vault generate without exposing paths", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-status-vault-"));
    const embed = embeddingDescriptor("/Users/secret/embed.gguf");
    const rerank = selection("rerank.gguf");
    const generate = selection("generate.gguf", "qmd-query-expansion-v2.8.3");
    const modelsConfig: ModelsConfigV1 = {
      schemaVersion: 1,
      embed: selection("unused-embed.gguf", "embeddinggemma-v1"),
      generate,
    };
    const installedModelsReceipt: InstalledModelsReceipt = {
      schemaVersion: 1,
      artifacts: [
        { capability: "rerank", selection: rerank, path: "/Users/secret/rerank.gguf" },
        { capability: "generate", selection: generate, path: "/Users/secret/generate.gguf" },
      ],
      defaults: [],
    };
    try {
      const engine = assembleEphemeralCoreSemanticEngine({
        vault,
        embeddingDescriptor: embed,
        modelEnv: {
          OMS_RERANK_PROVIDER: "gguf",
          OMS_RERANK_MODEL: "rerank.gguf",
        },
        modelsConfig,
        installedModelsReceipt,
      });
      const status = await engine.adapter.semanticStatus({});
      expect(status).toMatchObject({
        available: true,
        capabilities: {
          embed: {
            available: true, source: "request", provider: "gguf", model: "embed.gguf",
            revision: "test-revision", sha256: TEST_SHA256, promptScheme: "embeddinggemma-v1",
          },
          rerank: {
            available: true, source: "environment", provider: "gguf", model: "rerank.gguf",
            revision: "test-revision", sha256: TEST_SHA256,
          },
          generate: {
            available: true, source: "vault", provider: "gguf", model: "generate.gguf",
            revision: "test-revision", sha256: TEST_SHA256,
            promptScheme: "qmd-query-expansion-v2.8.3",
          },
        },
      });
      expect(JSON.stringify(status)).not.toContain("/Users/secret");
      await engine.dispose();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("reads capability configuration only for status and gives exact unavailable guidance", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-status-lazy-"));
    let receiptReads = 0;
    const receipt: InstalledModelsReceipt = {
      schemaVersion: 1,
      get artifacts() {
        receiptReads += 1;
        return [];
      },
      defaults: [],
    };
    try {
      const engine = assembleEphemeralCoreSemanticEngine({
        vault,
        installedModelsReceipt: receipt,
        modelEnv: {},
      });
      expect(receiptReads).toBe(0);
      await engine.adapter.semanticQuery({ query: "lexical only" });
      expect(receiptReads).toBe(0);

      const status = await engine.adapter.semanticStatus({});
      expect(receiptReads).toBeGreaterThan(0);
      expect(status).toMatchObject({
        available: true,
        capabilities: {
          embed: {
            available: false,
            guidance: expect.stringContaining("OMS_EMBEDDING_PROVIDER"),
          },
          rerank: {
            available: false,
            guidance: expect.stringContaining("OMS_RERANK_PROVIDER"),
          },
          generate: {
            available: false,
            guidance: expect.stringContaining("OMS_GENERATE_PROVIDER"),
          },
        },
      });
      const serialized = JSON.stringify(status);
      expect(serialized).toContain("OMS_EMBEDDING_MODEL");
      expect(serialized).toContain("OMS_RERANK_MODEL");
      expect(serialized).toContain("OMS_GENERATE_MODEL");
      expect(serialized).toContain(".oms/models.json");
      await engine.dispose();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed artifact errors", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-status-malformed-"));
    const receipt: InstalledModelsReceipt = {
      schemaVersion: 1,
      get artifacts(): readonly [] {
        throw new Error("/Users/secret/model.gguf");
      },
      defaults: [],
    };
    try {
      const engine = assembleEphemeralCoreSemanticEngine({ vault, installedModelsReceipt: receipt });
      const status = await engine.adapter.semanticStatus({});
      expect(status).toMatchObject({
        available: true,
        capabilities: {
          embed: { available: false, source: "unavailable" },
          rerank: { available: false, source: "unavailable" },
          generate: { available: false, source: "unavailable" },
        },
      });
      expect(JSON.stringify(status)).not.toContain("/Users/secret/model.gguf");
      await engine.dispose();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("keeps a vault model selection ahead of a different setup default", async () => {
    const vault = mkdtempSync(path.join(tmpdir(), "oms-status-vault-precedence-"));
    const cache = mkdtempSync(path.join(tmpdir(), "oms-status-cache-precedence-"));
    const vaultModelPath = path.join(cache, "vault-model.gguf");
    const defaultModelPath = path.join(cache, "default-model.gguf");
    writeFileSync(vaultModelPath, "vault-model-bytes");
    writeFileSync(defaultModelPath, "default-model-bytes");
    const makeSelection = (model: string, modelPath: string): PortableModelSelection => ({
      provider: "gguf",
      model,
      revision: "immutable-test-revision",
      sha256: createHash("sha256").update(readFileSync(modelPath)).digest("hex"),
      promptScheme: "embeddinggemma-v1",
    });
    const vaultSelection = makeSelection("vault-model.gguf", vaultModelPath);
    const defaultSelection = makeSelection("default-model.gguf", defaultModelPath);
    mkdirSync(path.join(vault, ".oms"), { recursive: true });
    writeFileSync(
      path.join(vault, ".oms", "models.json"),
      JSON.stringify({ schemaVersion: 1, embed: vaultSelection }),
    );
    writeFileSync(
      path.join(cache, INSTALLED_MODELS_RECEIPT),
      JSON.stringify({
        schemaVersion: 1,
        artifacts: [
          {
            capability: "embed",
            selection: vaultSelection,
            path: vaultModelPath,
            embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2" },
          },
          {
            capability: "embed",
            selection: defaultSelection,
            path: defaultModelPath,
            embedShape: { dimensions: 768, contextLength: 2048, mrlDim: 0, normalization: "l2" },
          },
        ],
        defaults: [canonicalModelIdentityKey(defaultSelection)],
      }),
    );

    const engine = assembleSemanticEngine(vault, undefined, cache, {});
    try {
      await expect(engine.adapter.semanticStatus({})).resolves.toMatchObject({
        capabilities: {
          embed: {
            available: true,
            source: "vault",
            model: "vault-model.gguf",
          },
        },
      });
    } finally {
      await engine.dispose();
      rmSync(vault, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real GGUF smoke test — gated on model availability
// ---------------------------------------------------------------------------

describe.skipIf(!SMOKE_ENABLED)(
  "assembleEngine — real GGUF smoke (OMS_MODEL_PATH or cached model required)",
  () => {
    let engine: Awaited<ReturnType<typeof assembleEngine>> | null = null;

    beforeAll(() => {
      createFixture();
    });

    afterAll(async () => {
      await engine?.dispose();
      cleanupFixture();
    });

    it(
      "assembles engine with real 768d GGUF provider",
      () => {
        engine = assembleEngine({
          vault: fixtureVault,
          embeddingDescriptor: embeddingDescriptor(MODEL_PATH),
          dbPath: fixtureDb,
        });
        expect(engine.provider.dimensions).toBe(768);
        expect(engine.provider.model).toMatch(/^node-llama-cpp:/);
        expect(engine.adapter).toBeDefined();
      },
    );

    it(
      "syncVault embeds all 5 fixture files (scanned===5)",
      async () => {
        const result = await engine!.syncVault({ embed: true });
        expect(result.available).toBe(true);
        expect(result.scanned).toBe(5);
        expect(result.added).toBeGreaterThan(0);
      },
      120_000, // 2 min — first GGUF load + 5 docs
    );

    it(
      "vec0 stored dimension is 768 — PROVES no fold (native-dim-in == stored-dim-out)",
      () => {
        const dim = readVec0Dimension(fixtureDb);
        expect(dim).toBe(768);
      },
    );

    it(
      "astronomy query ranks astronomy.md #1 (semantic sanity)",
      async () => {
        const result = await engine!.adapter.semanticQuery({
          query: "black holes galaxies stars cosmic universe telescope",
          mode: "vsearch",
          limit: 5,
        });
        expect(result.available).toBe(true);
        if (!result.available) return;
        expect(result.hits.length).toBeGreaterThan(0);
        // The top hit must be astronomy.md
        const topHit = result.hits[0]!;
        expect(topHit.path).toContain("astronomy");
      },
      30_000,
    );

    it(
      "cooking.md scores lower than astronomy.md for an astronomy query",
      async () => {
        const result = await engine!.adapter.semanticQuery({
          query: "black holes galaxies stars cosmic universe telescope",
          mode: "vsearch",
          limit: 5,
        });
        expect(result.available).toBe(true);
        if (!result.available) return;
        const hits = result.hits;
        const astronomyIdx = hits.findIndex((h) => h.path.includes("astronomy"));
        const cookingIdx = hits.findIndex((h) => h.path.includes("cooking"));
        // Astronomy must appear; cooking can be absent (ranked below limit) or ranked lower
        expect(astronomyIdx).toBeGreaterThanOrEqual(0);
        if (cookingIdx !== -1) {
          expect(astronomyIdx).toBeLessThan(cookingIdx);
        }
        // Print scores for smoke visibility
        console.log(
          "[smoke] astronomy rank:", astronomyIdx,
          "score:", hits[astronomyIdx]?.score?.toFixed(4),
          "| cooking rank:", cookingIdx === -1 ? "absent" : cookingIdx,
          "score:", cookingIdx === -1 ? "n/a" : hits[cookingIdx]?.score?.toFixed(4),
        );
      },
      30_000,
    );
  },
);
