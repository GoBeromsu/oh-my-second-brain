import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openEngineStoreCore } from "../../src/kernel/engine/embed/store.js";
import { syncEngineStore } from "../../src/kernel/engine/embed/sync.js";
import { dispatch } from "../../src/kernel/engine/retrieval/dispatcher.js";
import { KO_VAULT_SOURCE, materializeKoVault } from "../fixtures/ko-vault.mjs";
import { QUERY_TYPES, loadQueries, openLexicalBench, runQueries } from "../../scripts/bench/run.mjs";
import { buildReport } from "../../scripts/bench/report.mjs";

// Tier 1 of the Korean retrieval bench against the production lexical path (CUR).
// The per-type R@5 below is the recorded baseline, taken on the committed
// ko-vault fixture; a change that moves it must update this file and
// docs/measurements/ko-retrieval-ablation.md together.
const CUR_R5_BASELINE: Record<string, number> = {
  alias: 1,
  exact: 1,
  hard_negative: 1,
  metadata: 1,
  mixed: 1,
  paraphrase: 1 / 6,
};

describe("bench tier 1: lexical CUR on the ko-vault fixture", () => {
  let base: string;
  let report: ReturnType<typeof buildReport>;
  const queries = loadQueries(path.join(KO_VAULT_SOURCE, "queries.json"));

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), "oms-ko-bench-test-"));
    const vault = materializeKoVault(path.join(base, "vault"));
    rmSync(path.join(vault, "queries.json"), { force: true });
    const bench = await openLexicalBench(
      { openEngineStoreCore, syncEngineStore, dispatch },
      { vault, dbPath: path.join(base, "bench.db") },
    );
    try {
      const channels = [];
      for (const [label, search] of Object.entries(bench.channels)) {
        channels.push({ label, runs: await runQueries(queries, search) });
      }
      report = buildReport({ tier: 1, seed: 1, permutations: 200, channels });
    } finally {
      bench.close();
    }
  }, 60_000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("covers all six query types", () => {
    expect([...new Set(queries.map((query) => query.type))].sort()).toEqual([...QUERY_TYPES].sort());
  });

  it("holds per-type R@5 at or above the CUR baseline", () => {
    const byType = report.channels.CUR.byType;
    expect(Object.keys(byType).sort()).toEqual(Object.keys(CUR_R5_BASELINE).sort());
    for (const [type, expected] of Object.entries(CUR_R5_BASELINE)) {
      expect(byType[type].r5, type).toBeGreaterThanOrEqual(expected - 1e-9);
    }
  });

  it("answers a keyword query with p50 under 300ms", () => {
    const keyword = report.channels.CUR.byType.exact;
    expect(keyword.p50Ms).toBeLessThan(300);
  });
});
