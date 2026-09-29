import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the break fixed in this PR: scripts/bench/latency-baseline.mjs invoked
// `oms note get` and `oms search query`, both removed in 0.19 (see AGENTS.md's changelog
// discipline and src/cli/removed-families.ts / src/cli/search.ts). The bench script must only
// build command lines the current CLI accepts.

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "bench", "latency-baseline.mjs");
const OMS = path.join(REPO, "dist", "cli", "oms.js");

describe("bench:latency CLI surface", () => {
  it("never builds a command line for a family removed in 0.19", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // Top-level families retired in 0.19: `note`, `index`, `template`, `contract`, `graph`.
    // A bare word-boundary scan is deliberately broad; it should never see any of these as the
    // first token handed to the CLI.
    for (const family of ["note", "index", "template", "contract", "graph"]) {
      expect(source).not.toMatch(new RegExp(`\\[\\s*["']${family}["']`, "u"));
    }
    // `search query` / `search context` were removed in 0.19 in favor of `search <text>` and
    // `search --context`.
    expect(source).not.toMatch(/"search",\s*"query"/u);
    expect(source).not.toMatch(/"search",\s*"context"/u);
  });

  it("runs end to end against the built CLI and returns the expected metrics", () => {
    if (!existsSync(OMS)) {
      throw new Error("dist/cli/oms.js is missing; run `npm run build` before this test.");
    }
    const result = spawnSync(process.execPath, [SCRIPT, "--n", "1"], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, OMS_BENCH_N: undefined },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(Object.keys(report.results).sort()).toEqual(["searchPathNfd", "searchQueryLexical"].sort());
    for (const metric of Object.values(report.results) as Array<{ command: string }>) {
      expect(metric.command).not.toMatch(/^oms (note|index|template|contract|graph) /u);
      expect(metric.command).not.toMatch(/search (query|context) /u);
    }
  }, 60_000);
});
