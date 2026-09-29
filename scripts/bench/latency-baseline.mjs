#!/usr/bin/env node
// Latency baseline for the built `oms` CLI against a temp copy of test/fixtures/ko-vault.
//
// Usage: node scripts/bench/latency-baseline.mjs [--n <runs>]   (or OMS_BENCH_N; default 30)
//
// Each sample is the wall time of one `node dist/cli/oms.js ...` subprocess.
//   cold: fresh OMS state (vault copy + home) per sample, so no on-disk state from an
//         earlier sample can help it. OS file caches and the Node binary stay warm.
//   warm: one vault copy and home; one discarded warm-up run, then N samples back to back.
// Every subprocess runs with HOME, USERPROFILE, XDG_* and every OMS_* home pointed into a
// temp dir, so the real ~/.oms and any real vault are never read or written.
// Emits one JSON document on stdout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem, release, type } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { materializeKoVault, NFD_NOTE } from "../../test/fixtures/ko-vault.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const OMS = path.join(REPO, "dist", "cli", "oms.js");
const SEARCH_TEXT = "낙상판정기준";

function parseRuns(argv) {
  const index = argv.indexOf("--n");
  const raw = index >= 0 ? argv[index + 1] : process.env.OMS_BENCH_N ?? "30";
  const runs = Number(raw);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--n / OMS_BENCH_N must be a positive integer, got ${raw}`);
  return runs;
}

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

/** A fresh vault copy plus an isolated env, all under one temp dir. */
function sandbox() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-bench-")));
  const env = { ...process.env };
  delete env.OMS_VAULT;
  for (const [key, dir] of Object.entries(ISOLATED_DIRS)) {
    env[key] = path.join(base, dir);
    mkdirSync(env[key], { recursive: true });
  }
  const vault = materializeKoVault(path.join(base, "vault"));
  return { base, env, vault };
}

function timeRun(box, args) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [OMS, ...args, "--vault", box.vault], { cwd: box.base, env: box.env, encoding: "utf8" });
  const ms = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`oms ${args.join(" ")} exited ${result.status}${result.error ? ` (${result.error.message})` : ""}: ${result.stderr}`);
  }
  if (args[0] === "search" && args[1] !== undefined && !args[1].startsWith("--")) {
    // A plain query must stay lexical-only, or the baseline would silently measure another path.
    const channels = JSON.parse(result.stdout).receipt?.usedChannels;
    if (JSON.stringify(channels) !== JSON.stringify(["lex"])) {
      throw new Error(`expected search receipt.usedChannels ["lex"], got ${JSON.stringify(channels)}`);
    }
  }
  return ms;
}

/** Nearest-rank percentile. */
function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = value => Math.round(value * 10) / 10;
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function measure(args, runs) {
  const cold = [];
  for (let i = 0; i < runs; i += 1) {
    const box = sandbox();
    try {
      cold.push(timeRun(box, args));
    } finally {
      rmSync(box.base, { recursive: true, force: true });
    }
  }
  const warm = [];
  const box = sandbox();
  try {
    timeRun(box, args);
    for (let i = 0; i < runs; i += 1) warm.push(timeRun(box, args));
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
  return { command: `oms ${args.join(" ")} --vault <tmp>`, cold: summarize(cold), warm: summarize(warm) };
}

if (!existsSync(OMS)) {
  console.error("dist/cli/oms.js is missing; run `npm run build` first.");
  process.exit(1);
}

const runs = parseRuns(process.argv.slice(2));
const versionBox = sandbox();
const version = spawnSync(process.execPath, [OMS, "--version"], { encoding: "utf8", env: versionBox.env }).stdout.trim();
rmSync(versionBox.base, { recursive: true, force: true });
const cpu = cpus();

console.log(JSON.stringify({
  omsVersion: version,
  runs,
  unit: "ms",
  environment: {
    os: `${type()} ${release()}`,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpu[0]?.model ?? "unknown",
    cpuCount: cpu.length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
  },
  results: {
    searchQueryLexical: measure(["search", SEARCH_TEXT], runs),
    // Engine-free exact read; the NFC spelling of a note whose filename is NFD on disk.
    // This exercises the same search --path code path a plain NFC-named note would,
    // so a separate NFC-only measurement would be a duplicate, not added coverage.
    searchPathNfd: measure(["search", "--path", NFD_NOTE.normalize("NFC")], runs),
  },
}, null, 2));
