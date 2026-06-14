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
 *   1. assembleEngine() WITHOUT modelPath (no UPSTAGE_API_KEY) → THROWS.
 *   2. assembleEngine() WITH real modelPath → adapter constructed.
 *   3. syncVault() → syncs fixture, stores real 768d embeddings.
 *   4. vec0 stored dimension == 768 (proven via sqlite_master DDL).
 *   5. semantic query via adapter → astronomy doc ranks #1 for astronomy query.
 *   6. off-topic doc (cooking) scores lower than astronomy doc.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { assembleEngine } from "./assemble.js";
import { requireRealEmbeddingProvider } from "./embed/provider.js";

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

// Use the known cached model path or OMS_MODEL_PATH env var
const KNOWN_MODEL = "/Users/beomsu/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf";
const MODEL_PATH = process.env["OMS_MODEL_PATH"] ?? KNOWN_MODEL;
const SMOKE_ENABLED = process.env["ASSEMBLE_SMOKE"] === "1" || process.env["OMS_MODEL_PATH"] !== undefined;

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

describe("assembleEngine — strict guard (no model needed)", () => {
  it("THROWS when no modelPath and no UPSTAGE_API_KEY", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    try {
      expect(() =>
        assembleEngine({ vault: "/tmp/fake-vault" }),
      ).toThrow("OMS_MODEL_PATH");
    } finally {
      if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
    }
  });

  it("error message mentions hash-projection to explain what was avoided", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    try {
      expect(() =>
        assembleEngine({ vault: "/tmp/fake-vault" }),
      ).toThrow("hash-projection");
    } finally {
      if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
    }
  });

  it("requireRealEmbeddingProvider THROWS when no modelPath and no UPSTAGE_API_KEY", () => {
    const saved = process.env["UPSTAGE_API_KEY"];
    delete process.env["UPSTAGE_API_KEY"];
    try {
      expect(() => requireRealEmbeddingProvider({})).toThrow("OMS_MODEL_PATH");
    } finally {
      if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Stub-wiring test — adapter construction with fake provider (always runs)
// ---------------------------------------------------------------------------

describe("assembleEngine — stub-wiring via UPSTAGE_API_KEY shim", () => {
  it("constructs adapter when UPSTAGE_API_KEY is set (does not call API)", () => {
    let tmpVault = "";
    let tmpDb = "";
    const saved = process.env["UPSTAGE_API_KEY"];
    try {
      tmpVault = mkdtempSync(path.join(tmpdir(), "oms-stub-vault-"));
      tmpDb = path.join(
        mkdtempSync(path.join(tmpdir(), "oms-stub-db-")),
        "stub.sqlite",
      );
      process.env["UPSTAGE_API_KEY"] = "stub-key-for-construction-test";
      const engine = assembleEngine({ vault: tmpVault, dbPath: tmpDb });
      expect(engine.adapter).toBeDefined();
      expect(engine.provider.model).toContain("upstage");
      // No embed() called — dispose is safe
      void engine.dispose();
    } finally {
      if (saved !== undefined) process.env["UPSTAGE_API_KEY"] = saved;
      else delete process.env["UPSTAGE_API_KEY"];
      if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
      if (tmpDb) rmSync(path.dirname(tmpDb), { recursive: true, force: true });
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
          modelPath: MODEL_PATH,
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
