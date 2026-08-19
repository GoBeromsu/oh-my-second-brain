// Manual QA for the boot-time MCP update nudge (plan todo 12).
// Runs against dist/ only. Proves: fresh cache -> nudge in `instructions`;
// missing/stale cache -> no nudge; construction issues no network call and
// writes nothing to stdout.
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (rel) => path.join(repoRoot, "dist", rel);

const { cachedUpdateNotice, updateNoticeCachePath, buildServerInstructions } = await import(
  dist("mcp/update-notice.js")
);
const { readBundledPackageVersion } = await import(dist("core/runtime/assets.js"));

const installed = readBundledPackageVersion();
const line = (s) => console.error(s);

function seed(dir, cache) {
  writeFileSync(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), JSON.stringify(cache), "utf-8");
}

function withStateDir(label, seedCache) {
  const dir = mkdtempSync(path.join(tmpdir(), "oms-qa-nudge-"));
  try {
    if (seedCache !== null) seed(dir, seedCache);
    const notice = cachedUpdateNotice({ installedVersion: installed, env: { OMS_AUTO_UPDATE_STATE_DIR: dir } });
    line(`\n[${label}]`);
    line(`  cache file : ${seedCache === null ? "(absent)" : JSON.stringify(seedCache)}`);
    line("  instructions:");
    for (const l of buildServerInstructions("<<BASE INSTRUCTIONS>>", notice).split("\n")) line(`    | ${l}`);
    return notice;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

line(`installed version (from dist package.json): ${installed}`);

// (a) fresh cache with a newer version -> instructions carry the nudge
const fresh = withStateDir("A: fresh cache, newer version", {
  version: 1,
  channels: { stable: { latestVersion: "99.0.0", checkedAt: Date.now() } },
});
line(`  => nudge present: ${fresh !== null}`);

// (b) missing and stale caches -> no nudge
const missing = withStateDir("B1: missing cache", null);
line(`  => nudge present: ${missing !== null}`);
const stale = withStateDir("B2: stale cache (25h old)", {
  version: 1,
  channels: { stable: { latestVersion: "99.0.0", checkedAt: Date.now() - 25 * 60 * 60 * 1000 } },
});
line(`  => nudge present: ${stale !== null}`);

// (c) construction issues no network call and no stdout write
const dir = mkdtempSync(path.join(tmpdir(), "oms-qa-nudge-boot-"));
const stdoutChunks = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const originalFetch = globalThis.fetch;
const originalSpawnSync = childProcess.spawnSync;
const netCalls = [];
process.stdout.write = (chunk) => {
  stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
  return true;
};
globalThis.fetch = (...args) => {
  netCalls.push(`fetch ${String(args[0])}`);
  throw new Error("network is forbidden on the boot hot path");
};
// `oms update` reaches the registry through `npm view` (spawnSync), not fetch:
// count both so "no network at construction" is proven, not assumed.
childProcess.spawnSync = (command, args) => {
  netCalls.push([command, ...(args ?? [])].join(" "));
  throw new Error("subprocess is forbidden on the boot hot path");
};
let bootError = null;
let bootInstructions = null;
try {
  seed(dir, { version: 1, channels: { stable: { latestVersion: "99.0.0", checkedAt: Date.now() } } });
  process.env.OMS_AUTO_UPDATE_STATE_DIR = dir;
  const { createOMSMcpServer } = await import(dist("mcp/server.js"));
  const server = createOMSMcpServer({
    vault: path.join(repoRoot, "test", "fixtures", "vault"),
    source: "explicit",
  });
  // Private in the SDK type, but this is exactly the string sent in the
  // initialize result, so QA reads the shipped artifact rather than a rebuild.
  bootInstructions = server._instructions ?? null;
} catch (error) {
  bootError = error;
} finally {
  process.stdout.write = originalWrite;
  globalThis.fetch = originalFetch;
  childProcess.spawnSync = originalSpawnSync;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OMS_AUTO_UPDATE_STATE_DIR;
}
line("\n[C: createOMSMcpServer construction]");
line(`  construction error : ${bootError === null ? "(none)" : String(bootError)}`);
line(`  network calls      : ${netCalls.length} ${JSON.stringify(netCalls)}`);
line(`  stdout writes      : ${stdoutChunks.length} ${JSON.stringify(stdoutChunks)}`);
line("  real server instructions:");
for (const l of String(bootInstructions).split("\n")) line(`    | ${l}`);

const bootNudgeLines = String(bootInstructions).split("\n").filter((l) => l.includes("Update available"));
line(`  => nudge lines in real instructions: ${bootNudgeLines.length}`);

const pass =
  fresh !== null &&
  missing === null &&
  stale === null &&
  bootNudgeLines.length === 1 &&
  netCalls.length === 0 &&
  stdoutChunks.length === 0 &&
  bootError === null;
line(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
process.exitCode = pass ? 0 : 1;
