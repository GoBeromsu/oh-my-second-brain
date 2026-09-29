import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KO_VAULT_SOURCE } from "../fixtures/ko-vault.mjs";
import { scoreQuery } from "../../scripts/bench/metrics.mjs";
import { assertReportPrivacy, buildReport, formatMarkdown } from "../../scripts/bench/report.mjs";
import {
  DEFAULT_OUT_DIR,
  isGitignored,
  loadQueries,
  parseArgs,
  resolveTier3Queries,
  resolveTier3Vault,
} from "../../scripts/bench/run.mjs";
import { MIRACL_SKIP_REASON } from "../../scripts/bench/miracl-download.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const RUN = path.join(REPO, "scripts", "bench", "run.mjs");
const queries = loadQueries(path.join(KO_VAULT_SOURCE, "queries.json"));

function fakeReport() {
  const runs = queries.map((query, index) => ({
    id: query.id,
    type: query.type,
    metrics: scoreQuery(index % 2 === 0 ? query.expected_files : ["other.md"], query.expected_files, query.expected_in_top_k),
    latencyMs: 1 + index,
  }));
  return buildReport({
    tier: 3,
    seed: 1,
    permutations: 100,
    channels: [{ label: "CUR", runs }, { label: "ALT", runs: [...runs].reverse() }],
    skipped: { tier2: MIRACL_SKIP_REASON },
  });
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OMS_BENCH_VAULT;
  delete env.OMS_BENCH_QUERIES;
  delete env.OMS_VAULT;
  return env;
}

describe("bench privacy", () => {
  it("keeps query text, note paths and vault paths out of a report", () => {
    const report = fakeReport();
    const json = JSON.stringify(report);
    const markdown = formatMarkdown(report);
    for (const query of queries) {
      expect(json).not.toContain(query.query);
      expect(markdown).not.toContain(query.query);
      for (const file of query.expected_files) expect(json).not.toContain(file);
    }
    expect(json).not.toMatch(/\.md\b/);
    expect(json).not.toContain(REPO);
    expect(() => assertReportPrivacy(report, { queryTexts: queries.map((query) => query.query) })).not.toThrow();
  });

  it("rejects a report that leaks query text or paths", () => {
    const texts = { queryTexts: ["낙상판정기준"] };
    expect(() => assertReportPrivacy({ note: "낙상판정기준".normalize("NFD") }, texts)).toThrow(/query text/);
    expect(() => assertReportPrivacy({ top: "Resources/x.md" }, texts)).toThrow(/document path/);
    expect(() => assertReportPrivacy({ vault: "/Users/someone/vault" }, texts)).toThrow(/absolute path/);
    expect(() => assertReportPrivacy({ vault: "~/vault" }, texts)).toThrow(/absolute path/);
    expect(() => assertReportPrivacy({ vault: "C:\\vault" }, texts)).toThrow(/absolute path/);
    expect(() => assertReportPrivacy({ "/leak": 1 }, texts)).toThrow(/absolute path/);
  });

  it("does not flag a short tier-3 query that only coincides inside unrelated text", () => {
    // "ab" is below the substring-match floor, so it must not fire just
    // because it happens to occur inside an unrelated longer string.
    const texts = { queryTexts: ["ab"] };
    expect(() => assertReportPrivacy({ note: "table" }, texts)).not.toThrow();
  });

  it("still flags a real leak of a short query, and a substring leak of a longer one", () => {
    // A short query still fails closed when a field's value IS the query,
    // which is what an actual leak of a short query looks like.
    expect(() => assertReportPrivacy({ note: "ab" }, { queryTexts: ["ab"] })).toThrow(/query text/);
    // A longer query (at or above the substring floor) is still caught even
    // when embedded inside a larger string, not just on an exact match.
    expect(() => assertReportPrivacy({ note: "prefix 낙상판정기준 suffix" }, { queryTexts: ["낙상판정기준"] })).toThrow(/query text/);
  });

  it("still flags a substring leak of a short non-ASCII query", () => {
    // Below the substring floor, an ASCII query only fails closed on an
    // exact value match (see the "ab"/"table" case above). A non-ASCII
    // query below the floor has no equivalent false-positive risk, since
    // everything a generated report emits on its own is ASCII, so it must
    // still be caught as a substring leak, not just an exact match.
    expect(() => assertReportPrivacy({ perQuery: [{ id: "q-낙상" }] }, { queryTexts: ["낙상"] })).toThrow(/query text/);
  });

  it("refuses tier 3 without an explicit vault and queries file", () => {
    expect(() => resolveTier3Vault({}, {})).toThrow(/explicit vault/);
    expect(() => resolveTier3Vault({ vault: "  " }, {})).toThrow(/explicit vault/);
    expect(() => resolveTier3Vault({}, { OMS_BENCH_VAULT: path.join(REPO, "no-such-vault") })).toThrow(/not a directory/);
    expect(resolveTier3Vault({}, { OMS_BENCH_VAULT: KO_VAULT_SOURCE })).toBe(KO_VAULT_SOURCE);
    expect(() => resolveTier3Queries({}, {})).toThrow(/explicit queries/);
    expect(resolveTier3Queries({ queries: "q.json" }, {})).toBe(path.resolve("q.json"));
  });

  it("exits non-zero from the CLI when tier 3 has no vault", () => {
    const result = spawnSync(process.execPath, [RUN, "--tier", "3"], { cwd: REPO, env: childEnv(), encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/explicit vault/);
    expect(result.stdout).toBe("");
  });

  it("skips tier 2 while the MIRACL license is unverified", () => {
    const result = spawnSync(process.execPath, [RUN, "--tier", "2"], { cwd: REPO, env: childEnv(), encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("skipped (license unverified)");
    const download = spawnSync(process.execPath, [path.join(REPO, "scripts", "bench", "miracl-download.mjs")], { cwd: REPO, encoding: "utf8" });
    expect(download.status).toBe(2);
    expect(download.stderr).toContain("refused");
  });

  it("writes only into a gitignored output directory", () => {
    expect(isGitignored(DEFAULT_OUT_DIR, REPO)).toBe(true);
    expect(isGitignored(".bench-cache", REPO)).toBe(true);
    expect(isGitignored("docs/measurements", REPO)).toBe(false);
    expect(isGitignored(path.dirname(REPO), REPO)).toBe(false);
    const gitignore = readFileSync(path.join(REPO, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^bench-results\/$/m);
    expect(gitignore).toMatch(/^\.bench-cache\/$/m);
  });

  it("parses flags and rejects unknown ones", () => {
    expect(parseArgs(["--tier", "3", "--vault=/v", "--seed", "4"])).toMatchObject({ tier: 3, vault: "/v", seed: 4, permutations: 10_000 });
    expect(() => parseArgs(["--tier", "4"])).toThrow(/1, 2 or 3/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--vault"])).toThrow(/needs a value/);
  });
});
