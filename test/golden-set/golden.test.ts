/**
 * Golden-set parity test suite.
 *
 * GATED: only runs when RUN_GOLDEN=1 is set in the environment.
 *   npm test                      → skipped (normal CI)
 *   RUN_GOLDEN=1 npm test         → executes full parity check
 *   OMS_VAULT=/path/to/vault RUN_GOLDEN=1 npm test → real vault run
 *
 * This gate encodes R2 (manual-only / no-CI) for the golden harness.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runHarness, runEngine, printHarnessReport } from "./harness.js";
import { QUERY_COUNT, QUERIES_BY_TYPE } from "./queries.js";
import type { GoldenQuery } from "./queries.js";
import { makeTracerConfig } from "../../src/engine/tracer.js";

// ---------------------------------------------------------------------------
// Static structural assertions (run unconditionally — no vault required)
// ---------------------------------------------------------------------------

describe("golden query set — structural validation", () => {
  it("has at least 20 queries", () => {
    expect(QUERY_COUNT).toBeGreaterThanOrEqual(20);
  });

  it("has at least 4 lex queries", () => {
    expect(QUERIES_BY_TYPE.lex.length).toBeGreaterThanOrEqual(4);
  });

  it("has at least 4 vec queries", () => {
    expect(QUERIES_BY_TYPE.vec.length).toBeGreaterThanOrEqual(4);
  });

  it("has at least 4 hyde queries", () => {
    expect(QUERIES_BY_TYPE.hyde.length).toBeGreaterThanOrEqual(4);
  });

  it("has at least 4 graph queries", () => {
    expect(QUERIES_BY_TYPE.graph.length).toBeGreaterThanOrEqual(4);
  });

  it("has at least 1 cross-language (Korean+English) query", () => {
    const all = [
      ...QUERIES_BY_TYPE.lex,
      ...QUERIES_BY_TYPE.vec,
      ...QUERIES_BY_TYPE.hyde,
      ...QUERIES_BY_TYPE.graph,
    ];
    const crossLang = all.filter((q) => q.tags?.includes("cross-language"));
    expect(crossLang.length).toBeGreaterThanOrEqual(1);
  });

  it("has at least 1 technical-concept query", () => {
    const all = [
      ...QUERIES_BY_TYPE.lex,
      ...QUERIES_BY_TYPE.vec,
      ...QUERIES_BY_TYPE.hyde,
      ...QUERIES_BY_TYPE.graph,
    ];
    const tech = all.filter((q) => q.tags?.includes("technical-concept"));
    expect(tech.length).toBeGreaterThanOrEqual(1);
  });

  it("has at least 1 personal-capture query", () => {
    const all = [
      ...QUERIES_BY_TYPE.lex,
      ...QUERIES_BY_TYPE.vec,
      ...QUERIES_BY_TYPE.hyde,
      ...QUERIES_BY_TYPE.graph,
    ];
    const personal = all.filter((q) => q.tags?.includes("personal-capture"));
    expect(personal.length).toBeGreaterThanOrEqual(1);
  });

  it("all queries have non-empty query strings", () => {
    const all = [
      ...QUERIES_BY_TYPE.lex,
      ...QUERIES_BY_TYPE.vec,
      ...QUERIES_BY_TYPE.hyde,
      ...QUERIES_BY_TYPE.graph,
    ];
    for (const q of all) {
      expect(q.query.trim().length, `query ${q.id} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all query IDs are unique", () => {
    const all = [
      ...QUERIES_BY_TYPE.lex,
      ...QUERIES_BY_TYPE.vec,
      ...QUERIES_BY_TYPE.hyde,
      ...QUERIES_BY_TYPE.graph,
    ];
    const ids = all.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Fail-loud unit tests — no vault required; assert anti-vacuity invariants
// ---------------------------------------------------------------------------

describe("golden harness — fail-loud behaviour (unit)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "(a) engine recall is computed only for curated queries; uncurated never silently scored",
    async () => {
      // The engine-only harness has no src/search baseline anymore. The fail-loud
      // invariant that remains: uncurated queries are skipped (asserted in (c)),
      // and a scored run with zero curated queries can never be vacuously green.
      const report = await runHarness({ vaultPath: "/tmp", files: [] });
      const scored = report.queries.filter((r) => !r.skipped);
      expect(scored.length).toBe(0);
      expect(report.overallPass).toBe(false);
    },
  );

  it(
    "(b) engine throw propagates; runEngine does not swallow errors as []",
    async () => {
      // Strip embedding-config env vars so requireRealEmbeddingProvider throws.
      // This verifies that the try/catch that used to return [] is gone.
      const savedUpstage = process.env["UPSTAGE_API_KEY"];
      const savedProvider = process.env["OMS_EMBEDDING_PROVIDER"];
      const savedModel = process.env["OMS_EMBEDDING_MODEL"];
      delete process.env["UPSTAGE_API_KEY"];
      delete process.env["OMS_EMBEDDING_PROVIDER"];
      delete process.env["OMS_EMBEDDING_MODEL"];

      try {
        const q: GoldenQuery = {
          id: "failsafe-b",
          type: "vec",
          query: "test query for engine throw",
          expectedNotes: [],
          curated: true,
        };
        // No provider/model configured + no UPSTAGE_API_KEY → requireRealEmbeddingProvider throws
        const config = makeTracerConfig({
          vaultPath: "/nonexistent",
          dbPath: "/tmp/oms-golden-failsafe-b-do-not-use.db",
          embeddingDimensions: 768,
        });
        await expect(runEngine(q, config, [])).rejects.toThrow();
      } finally {
        // Restore env regardless of test outcome
        if (savedUpstage !== undefined) process.env["UPSTAGE_API_KEY"] = savedUpstage;
        if (savedProvider !== undefined) process.env["OMS_EMBEDDING_PROVIDER"] = savedProvider;
        if (savedModel !== undefined) process.env["OMS_EMBEDDING_MODEL"] = savedModel;
      }
    },
  );

  it(
    "(c) uncurated queries are excluded from scoring with a warning; never silently scored 0",
    async () => {
      // All GOLDEN_QUERIES currently have curated:undefined (falsy).
      // runHarness must warn and mark them skipped — engine/baseline are never
      // invoked for uncurated queries, so no I/O needed for this test.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Pass files:[] so that if (incorrectly) the engine were called, it
      // would process 0 files and not hit the filesystem.
      const report = await runHarness({ vaultPath: "/tmp", files: [] });

      // Every report row must be skipped (no curated queries in the current set)
      const scoredRows = report.queries.filter((r) => !r.skipped);
      expect(scoredRows.length).toBe(0);

      // Skipped rows are still present for count-consistency
      expect(report.queries.length).toBe(QUERY_COUNT);

      // A warning was emitted for each uncurated query — never silently omitted
      expect(warnSpy).toHaveBeenCalledTimes(QUERY_COUNT);

      // Skipped queries carry sentinel values and pass:false (not vacuously green)
      for (const row of report.queries) {
        expect(row.skipped, `query ${row.id} should be skipped`).toBe(true);
        expect(row.pass, `query ${row.id} skipped row must not be vacuously pass:true`).toBe(false);
        expect(row.engineTop10).toEqual([]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Runtime parity test — GATED behind RUN_GOLDEN=1
// ---------------------------------------------------------------------------

describe.skipIf(!process.env["RUN_GOLDEN"])("golden-set recall — engine floor", () => {
  it(
    "engine recall@10 per-type average meets the configured floor",
    async () => {
      const vaultPath = process.env["OMS_VAULT"] ?? process.cwd();

      const report = await runHarness({ vaultPath });

      // Always print the report for visibility
      printHarnessReport(report);

      // Assert per-type recall floor
      for (const type of ["lex", "vec", "hyde", "graph"] as const) {
        const { engineAvg, pass } = report.byType[type];
        expect(
          pass,
          `Type '${type}' below recall floor: engine=${(engineAvg * 100).toFixed(1)}%`,
        ).toBe(true);
      }

      expect(
        report.overallPass,
        "Overall recall gate failed — see query-level report above",
      ).toBe(true);
    },
    // Allow up to 5 minutes for a full vault run
    300_000,
  );

  it("report contains one row per golden query", async () => {
    const vaultPath = process.env["OMS_VAULT"] ?? process.cwd();
    const report = await runHarness({ vaultPath });
    expect(report.queries.length).toBe(QUERY_COUNT);
  });

  it("report JSON is serialisable", async () => {
    const vaultPath = process.env["OMS_VAULT"] ?? process.cwd();
    const report = await runHarness({ vaultPath });
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});
