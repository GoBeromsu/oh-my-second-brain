/**
 * Standalone golden-set parity RUNNER (not a gate).
 *
 * Bypasses golden.test.ts deliberately to avoid:
 *   (1) the test(c) / OMS_GOLDEN_QUERIES process-wide conflict, and
 *   (2) the 300s timeout that a full per-query re-embed would blow.
 *
 * Uses the SAME harness instrument; emits OMS_GOLDEN_REPORT for an independent
 * verification pass. Run via:
 *   OMS_GOLDEN_QUERIES=… OMS_VAULT=… OMS_MODEL_PATH=… OMS_GOLDEN_DB=… \
 *   OMS_ENGINE_CACHE=… OMS_SLICE_MANIFEST=… OMS_GOLDEN_REPORT=… \
 *   npx vitest run test/golden-set/parity-run.test.ts
 */
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { runHarness, printHarnessReport } from "./harness.js";

describe("golden parity runner", () => {
  // Standalone manual runner: skipped in the bare `npm test` gate (no env),
  // runs only when invoked with OMS_VAULT + the sibling OMS_* env vars.
  it.skipIf(!process.env["OMS_VAULT"])(
    "runs full parity and emits report",
    async () => {
      const vaultPath = process.env["OMS_VAULT"];
      if (!vaultPath) throw new Error("OMS_VAULT required");

      const manPath = process.env["OMS_SLICE_MANIFEST"];
      const files = manPath
        ? (JSON.parse(readFileSync(manPath, "utf8")) as string[])
        : undefined;

      const cacheDir = process.env["OMS_ENGINE_CACHE"];

      const report = await runHarness({
        vaultPath,
        files,
        dbPath: process.env["OMS_GOLDEN_DB"],
        configOverrides: cacheDir ? { cacheDir } : {},
      });

      printHarnessReport(report);
      console.log("[parity-run] overallPass=" + report.overallPass);
    },
    3_600_000,
  );
});
