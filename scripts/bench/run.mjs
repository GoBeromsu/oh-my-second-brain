#!/usr/bin/env node
// Korean retrieval bench runner.
//
//   npm run build && npm run bench -- --tier 1
//   npm run bench -- --tier 3 --vault /path/to/vault --queries /path/to/queries.json
//
// Tier 1 runs the committed ko-vault fixture (test/fixtures/ko-vault) and its
// queries.json. Tier 2 would run MIRACL-ko and stays skipped until its license is
// verified (see miracl-download.mjs). Tier 3 runs a vault the user names
// explicitly, with a flag or env; there is no default vault.
//
// Every tier runs in-process against dist/ with HOME, XDG and OMS runtime roots
// pointed at a temp sandbox, and the engine store in a temp dir outside the vault.
// The report holds query ids and aggregates only, and it is written only into a
// gitignored output directory.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scoreQuery } from "./metrics.mjs";
import { MIRACL_SKIP_REASON } from "./miracl-download.mjs";
import { assertReportPrivacy, buildReport, formatMarkdown } from "./report.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Gitignored default output directory for reports. */
export const DEFAULT_OUT_DIR = "bench-results";

/** Query types the fixture must cover. */
export const QUERY_TYPES = /** @type {const} */ (["exact", "paraphrase", "mixed", "alias", "metadata", "hard_negative"]);

/** Candidate count requested from each channel. */
export const CANDIDATES = 10;

/**
 * @typedef {{ id: string, query: string, type: string, description: string, expected_files: string[], expected_in_top_k: number }} BenchQuery
 * @typedef {(query: string) => Promise<readonly string[]>} SearchFn
 * @typedef {{ openEngineStoreCore: Function, syncEngineStore: Function, dispatch: Function }} EngineModules
 */

/**
 * Parses and validates a QMD-compatible queries file.
 * @param {string} file
 * @returns {BenchQuery[]}
 */
export function loadQueries(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("queries file must be a non-empty JSON array");
  const ids = new Set();
  for (const [index, item] of parsed.entries()) {
    const where = `queries[${index}]`;
    if (typeof item?.id !== "string" || item.id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
    if (ids.has(item.id)) throw new Error(`${where}.id is duplicated`);
    ids.add(item.id);
    if (typeof item.query !== "string" || item.query.trim().length === 0) throw new Error(`${where}.query must be a non-empty string`);
    if (typeof item.type !== "string" || item.type.length === 0) throw new Error(`${where}.type must be a non-empty string`);
    if (typeof item.description !== "string") throw new Error(`${where}.description must be a string`);
    if (!Array.isArray(item.expected_files) || item.expected_files.length === 0 || !item.expected_files.every((/** @type {unknown} */ f) => typeof f === "string")) {
      throw new Error(`${where}.expected_files must be a non-empty string array`);
    }
    if (!Number.isInteger(item.expected_in_top_k) || item.expected_in_top_k < 1) throw new Error(`${where}.expected_in_top_k must be a positive integer`);
  }
  return parsed;
}

/**
 * Runs every query through `search` once untimed (warm-up), then once timed.
 * @param {readonly BenchQuery[]} queries
 * @param {SearchFn} search
 * @returns {Promise<import("./report.mjs").QueryRun[]>}
 */
export async function runQueries(queries, search) {
  for (const query of queries) await search(query.query);
  const runs = [];
  for (const query of queries) {
    const started = performance.now();
    const paths = await search(query.query);
    const latencyMs = performance.now() - started;
    runs.push({ id: query.id, type: query.type, metrics: scoreQuery(paths, query.expected_files, query.expected_in_top_k), latencyMs });
  }
  return runs;
}

/** An embedding provider stand-in: the lexical path never embeds, so any call is a bench bug. */
const NO_EMBED = new Proxy({}, {
  get(_target, key) {
    if (key === "then") return undefined;
    return () => {
      throw new Error("the lexical bench must not embed");
    };
  },
});

/**
 * Indexes `vault` lexically into a store at `dbPath` and returns one search function per channel.
 * CUR is the production lexical path: the dispatcher's `lex` sub-query over engine_chunk_fts.
 * @param {EngineModules} engine
 * @param {{ vault: string, dbPath: string }} options
 * @returns {Promise<{ channels: Record<string, SearchFn>, close: () => void }>}
 */
export async function openLexicalBench(engine, options) {
  const store = engine.openEngineStoreCore(options.dbPath);
  try {
    const sync = await engine.syncEngineStore({ vault: options.vault, store, embed: false, persist: false });
    if (sync.available === false) throw new Error(`lexical sync unavailable: ${sync.reason ?? "unknown"}`);
  } catch (error) {
    store.close();
    throw error;
  }
  const deps = { store, embed: NO_EMBED };
  /** @type {SearchFn} */
  const cur = async (query) => {
    const hits = await engine.dispatch([{ type: "lex", query }], deps, CANDIDATES);
    return hits.map((/** @type {{ docPath: string }} */ hit) => hit.docPath);
  };
  return { channels: { CUR: cur }, close: () => store.close() };
}

/**
 * Tier 3 vault resolution: an explicit flag or env only, never a default.
 * @param {{ vault?: string }} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveTier3Vault(flags, env) {
  const raw = flags.vault ?? env.OMS_BENCH_VAULT;
  if (raw === undefined || raw.trim() === "") {
    throw new Error("tier 3 needs an explicit vault: pass --vault <path> or set OMS_BENCH_VAULT. There is no default.");
  }
  const vault = path.resolve(raw);
  if (!existsSync(vault) || !statSync(vault).isDirectory()) throw new Error("tier 3 vault is not a directory");
  return vault;
}

/**
 * Tier 3 queries resolution: explicit only, because private queries never live in the repo.
 * @param {{ queries?: string }} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveTier3Queries(flags, env) {
  const raw = flags.queries ?? env.OMS_BENCH_QUERIES;
  if (raw === undefined || raw.trim() === "") {
    throw new Error("tier 3 needs an explicit queries file: pass --queries <path> or set OMS_BENCH_QUERIES.");
  }
  return path.resolve(raw);
}

/**
 * True when git ignores files written into `dir`. A dir outside the repo is not ignored.
 * @param {string} dir
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function isGitignored(dir, repoRoot = REPO_ROOT) {
  const probe = path.join(path.resolve(repoRoot, dir), "report.json");
  const relative = path.relative(repoRoot, probe);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const result = spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", "--no-index", relative], { encoding: "utf8" });
  return result.status === 0;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ tier?: number, vault?: string, queries?: string, out?: string, seed: number, permutations: number }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--(tier|vault|queries|out|seed|permutations)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (value === undefined) throw new Error(`--${match[1]} needs a value`);
    values[match[1]] = value;
  }
  const tier = values.tier === undefined ? undefined : Number(values.tier);
  if (tier !== undefined && ![1, 2, 3].includes(tier)) throw new Error("--tier must be 1, 2 or 3");
  const seed = Number(values.seed ?? 20260929);
  const permutations = Number(values.permutations ?? 10_000);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  if (!Number.isInteger(permutations) || permutations < 1) throw new Error("--permutations must be a positive integer");
  return { tier, vault: values.vault, queries: values.queries, out: values.out, seed, permutations };
}

/** Env keys pointed into the sandbox, matching scripts/bench/latency-baseline.mjs. */
const ISOLATED_DIRS = {
  HOME: "home",
  USERPROFILE: "home",
  OMS_RUNTIME_ROOT: "runtime",
  OMS_AUTO_UPDATE_STATE_DIR: "auto-update",
  OMS_CLAUDE_HOME: "claude",
  OMS_CODEX_HOME: "codex",
  OMS_HERMES_HOME: "hermes",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_DATA_HOME: "xdg-data",
  XDG_STATE_HOME: "xdg-state",
};

/**
 * Points HOME, XDG and OMS homes at `base` so dist/ never reads the operator's real home.
 * @param {string} base
 * @param {NodeJS.ProcessEnv} [env]
 */
export function sandboxEnv(base, env = process.env) {
  for (const [key, dir] of Object.entries(ISOLATED_DIRS)) {
    env[key] = path.join(base, dir);
    mkdirSync(env[key], { recursive: true });
  }
  delete env.OMS_VAULT;
}

/** @returns {Promise<EngineModules>} */
async function loadDistEngine() {
  const dist = path.join(REPO_ROOT, "dist", "kernel", "engine");
  if (!existsSync(dist)) throw new Error("dist/ is missing; run `npm run build` first");
  const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(dist, rel)).href);
  const [store, sync, dispatcher] = await Promise.all([
    load("embed/store.js"),
    load("embed/sync.js"),
    load("retrieval/dispatcher.js"),
  ]);
  return { openEngineStoreCore: store.openEngineStoreCore, syncEngineStore: sync.syncEngineStore, dispatch: dispatcher.dispatch };
}

/**
 * @param {EngineModules} engine
 * @param {string} vault
 * @param {readonly BenchQuery[]} queries
 * @param {string} base
 */
async function runChannels(engine, vault, queries, base) {
  const bench = await openLexicalBench(engine, { vault, dbPath: path.join(base, "store", "bench.db") });
  try {
    const channels = [];
    for (const [label, search] of Object.entries(bench.channels)) channels.push({ label, runs: await runQueries(queries, search) });
    return channels;
  } finally {
    bench.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tier = args.tier ?? 1;
  if (tier === 2) {
    process.stderr.write(`tier 2 skipped: ${MIRACL_SKIP_REASON}\n`);
    process.exitCode = 2;
    return;
  }
  const outDir = path.resolve(REPO_ROOT, args.out ?? DEFAULT_OUT_DIR);
  if (!isGitignored(outDir)) throw new Error("the output directory must be gitignored inside this repository");

  const base = mkdtempSync(path.join(tmpdir(), "oms-ko-bench-"));
  try {
    /** @type {string} */
    let vault;
    /** @type {BenchQuery[]} */
    let queries;
    if (tier === 1) {
      const { KO_VAULT_SOURCE, materializeKoVault } = await import("../../test/fixtures/ko-vault.mjs");
      queries = loadQueries(path.join(KO_VAULT_SOURCE, "queries.json"));
      vault = materializeKoVault(path.join(base, "vault"));
      rmSync(path.join(vault, "queries.json"), { force: true });
    } else {
      vault = resolveTier3Vault(args, process.env);
      queries = loadQueries(resolveTier3Queries(args, process.env));
    }
    sandboxEnv(base);
    const engine = await loadDistEngine();
    const channels = await runChannels(engine, vault, queries, base);
    const report = buildReport({
      tier,
      seed: args.seed,
      permutations: args.permutations,
      channels,
      skipped: { tier2: MIRACL_SKIP_REASON },
    });
    assertReportPrivacy(report, { queryTexts: queries.map((query) => query.query) });
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `tier${tier}-report.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatMarkdown(report)}\n\nreport: ${path.relative(REPO_ROOT, file)}\n`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
