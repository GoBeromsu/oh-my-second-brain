#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = new Set(process.argv.slice(2));
const runSetup = !args.has("--mcp-only");
const runMcp = !args.has("--setup-only");

function fail(message) {
  console.error(`[release:artifact-smoke] ${message}`);
  process.exit(1);
}

async function readHarnessRegistry() {
  try {
    return (await import("../dist/kernel/harness/surface-registry.js")).harnessSurfaceRegistry;
  } catch (error) {
    fail(
      `could not load built harness registry; run npm run build before release checks: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const harnessSurfaceRegistry = await readHarnessRegistry();

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf-8",
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(result.stdout ?? "");
    fail(`${command} ${commandArgs.join(" ")} failed with exit ${result.status}`);
  }
  return result;
}

// packTarball/extractPackage/installRuntimeDependencies below spawn `npm`
// and `tar`, but never the packaged `oms` CLI, so they cannot touch a global
// HOME-scoped config. Deliberately NOT wrapped in smokeEnv(): overriding HOME
// for `npm install` would risk losing `.npmrc`/npm-cache resolution for
// anyone behind a private registry or proxy, for zero isolation benefit.
function packTarball() {
  const result = run("npm", ["pack", "--json"]);
  let packs;
  try {
    packs = JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const filename = packs?.[0]?.filename;
  if (!filename) fail("npm pack JSON did not include filename");
  return path.resolve(filename);
}

function extractPackage(tarball, tempRoot) {
  run("tar", ["-xzf", tarball, "-C", tempRoot]);
  const packageRoot = path.join(tempRoot, "package");
  if (!existsSync(packageRoot)) fail("tarball did not extract to package/");
  return packageRoot;
}

function assertPath(target, label = target) {
  if (!existsSync(target)) fail(`missing ${label}: ${target}`);
}

// The packaged CLI reads/writes host state under `<HOME>` (today that is just
// `~/.oms/config.yaml`, see src/cli/global-writeback.ts, but nothing here
// should depend on that staying true). Every child process this script spawns
// that runs the packaged CLI must get a throwaway HOME inside this run's own
// temp root, or a future write there lands on the real developer's home
// directory instead of a vault that is deleted the moment this script exits.
// USERPROFILE is set alongside HOME so the same isolation holds if this ever
// runs on Windows, where `os.homedir()` reads USERPROFILE instead.
function smokeEnv(smokeHome, overrides = {}) {
  return { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome, ...overrides };
}

// A cheap (metadata-only, no file content read) recursive snapshot of a
// directory tree, used to prove a real home directory was left untouched.
// Reading full file content would be correct too, but `~/.oms` can hold
// large downloaded embedding models, and hashing those on every release
// check would make the smoke test needlessly slow; size + mtime already
// changes on any write a real CLI invocation could make.
function snapshotDir(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  const walk = (current, rel) => {
    for (const name of readdirSync(current).sort()) {
      const absChild = path.join(current, name);
      const relChild = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(absChild);
      if (st.isDirectory()) {
        entries.push(`${relChild}/`);
        walk(absChild, relChild);
      } else {
        entries.push(`${relChild}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return entries.join("\n");
}

function installRuntimeDependencies(packageRoot) {
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

function makeVault(tempRoot) {
  const vault = path.join(tempRoot, "Vault");
  mkdirSync(path.join(vault, "Inbox"), { recursive: true });
  mkdirSync(path.join(vault, "Literature"), { recursive: true });
  writeFileSync(
    path.join(vault, "Literature", "semantic-retrieval.md"),
    "---\ntitle: Semantic Retrieval\ntags:\n  - smoke-semantic\n---\n# Semantic Retrieval\n\nAgent retrieval uses OMS native semantic search.\n",
    "utf-8",
  );
  return vault;
}

function setupSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "setup", "--vault", vault, "--yes", "--install-claude"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assertPath(path.join(vault, ".oms/taxonomy.yaml"), "vault taxonomy");
  assertPath(path.join(vault, ".oms/concepts"), "vault concepts directory");
  if (!output.includes("claude plugin install")) fail("setup output did not include Claude plugin install command");
  if (!output.includes("plugin-owned and plugin-qualified")) {
    fail("setup output did not declare the plugin-owned Claude MCP surface");
  }
  const pluginPathLine = output.split(/\r?\n/).find((line) => line.includes("Plugin path:"));
  if (!pluginPathLine) fail("setup output did not include Plugin path line");
  const pluginPath = pluginPathLine.replace(/^.*Plugin path:\s*/, "").trim();
  assertPath(path.join(pluginPath, ".claude-plugin/plugin.json"), "printed Claude plugin manifest path");
  const expectedRoot = packageRoot;
  if (realpathSync(path.resolve(pluginPath)) !== realpathSync(path.resolve(expectedRoot))) {
    fail(`printed plugin path must resolve inside extracted package: expected ${expectedRoot}, got ${pluginPath}`);
  }
  console.log("[release:artifact-smoke] ok: setup dry-run works from unpacked package.");
}

function hostInstallSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "install", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const expected of ["[claude] install", "[codex] install", "[hermes] install", "rules/oms.md", "skills/knowledge-management/oms"]) {
    if (!output.includes(expected)) fail(`host install dry-run did not include ${expected}`);
  }
  console.log("[release:artifact-smoke] ok: host install dry-run works from unpacked package.");
}

function updateSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "update", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_LATEST_VERSION: "999.0.0" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const expected of [
    "npm install -g oh-my-second-brain@latest",
    "update-reconcile --runtime all",
    "Run `oms update --yes`",
  ]) {
    if (!output.includes(expected)) fail(`update dry-run did not include ${expected}`);
  }
  console.log("[release:artifact-smoke] ok: update dry-run works from unpacked package.");
}

async function mcpSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  // StdioClientTransport sandboxes the child env to a safe default subset, so the
  // embedding-model path must be forwarded explicitly or the child is always
  // model-less regardless of this process's env -- which would desync it from the
  // hasModel gate below. Forward the canonical OMS_EMBEDDING_PROVIDER +
  // OMS_EMBEDDING_MODEL pair (ADR-007: explicit config, no auto-detect),
  // matching src/mcp/semantic-server.test.ts. HOME/USERPROFILE are likewise
  // forwarded explicitly (the sandboxed default subset drops them) so this
  // child's global write-back also lands in the isolated HOME, not the real one.
  const childEnv = { ...getDefaultEnvironment(), HOME: smokeHome, USERPROFILE: smokeHome };
  if (process.env.OMS_EMBEDDING_PROVIDER) childEnv.OMS_EMBEDDING_PROVIDER = process.env.OMS_EMBEDDING_PROVIDER;
  if (process.env.OMS_EMBEDDING_MODEL) childEnv.OMS_EMBEDDING_MODEL = process.env.OMS_EMBEDDING_MODEL;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--vault", vault],
    cwd: packageRoot,
    env: childEnv,
  });
  const client = new Client({ name: "oms-release-artifact-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = new Set(result.tools.map((tool) => tool.name));
    const requiredTools = harnessSurfaceRegistry.mcpTools.map((tool) => tool.name);
    const missing = requiredTools.filter((tool) => !toolNames.has(tool));
    if (missing.length > 0) fail(`MCP server missing tools: ${missing.join(", ")}`);
    // Exercise retrieve_context the way the WITH/NO-model unit test does. On a
    // model-less host the qmd:// ReadResource and document reads below hydrate
    // from disk through the engine's core (lex + file-based) adapter, which needs
    // no model. oms_sync_embeddings is engine-owned and loud-guards (ADR-007)
    // without a model, so retrieve_context's semantic leg simply degrades to the
    // graph leg here; with a model present the engine handles the sync just as well.
    await client.callTool({
      name: "oms_search",
      arguments: {
        op: "context",
        property: "tags",
        value: "smoke-semantic",
        query: "agent semantic retrieval",
        limit: 1,
        maxNeighbors: 5,
        useCache: false,
        semanticEnabled: true,
        semanticCollection: "vault",
        semanticLimit: 3,
        semanticMode: "query",
        semanticIntent: "exercise the model-less retrieve path for the artifact smoke",
        semanticLex: "agent retrieval semantic",
        semanticMinScore: 0.01,
        embeddingSyncBeforeSearch: true,
        embeddingSyncForce: true,
      },
    });
    // oms_sync_embeddings / oms_semantic_query route through the native engine,
    // which REQUIRES a real embedding model (ADR-007). With a model we assert
    // real results; without one (the default CI runner) we assert the op
    // *refuses to falsely succeed* -- which itself proves it routed to the
    // engine and never fabricated a result. Mirrors src/mcp/semantic-server.test.ts.
    // Gate on the canonical embedding pair, mirroring semantic-server.test.ts: the
    // smoke forwards OMS_EMBEDDING_PROVIDER + OMS_EMBEDDING_MODEL to the child, so the
    // runner gate must key off the same pair to stay in sync with the forwarded child
    // env (ADR-007: explicit config, no auto-detect).
    const hasModel = Boolean(process.env.OMS_EMBEDDING_PROVIDER && process.env.OMS_EMBEDDING_MODEL);
    const textOf = (res) => (res.content?.[0]?.type === "text" ? res.content[0].text : "");
    // The detail tools were demoted behind the five public tools during the
    // surface cutover; they are routed by `op`, not deleted. Calling them
    // through the public surface is what proves the demotion kept behaviour.
    const syncCall = {
      name: "oms_doctor",
      arguments: { op: "sync-embeddings", collection: "vault" },
    };
    const queryCall = {
      name: "oms_search",
      arguments: { op: "query", query: "agent retr", collection: "vault", limit: 1 },
    };
    // R4's public envelope keeps axis narrowing under the renamed `query` op;
    // this is deliberately a model-free lexical call so every release runner
    // exercises axes, paging, candidates, rerank selection, and receipt DTOs.
    const axisQuery = await client.callTool({
      name: "oms_search",
      arguments: {
        op: "query",
        query: "agent retrieval",
        axes: { folder: "Literature" },
        limit: 1,
        candidateLimit: 5,
        rerank: false,
        minScore: 0,
        cursor: "0",
        intent: "verify the R4 axis query envelope",
      },
    });
    const axisPayload = JSON.parse(textOf(axisQuery) || "{}");
    if (
      axisQuery.isError ||
      axisPayload.available !== true ||
      axisPayload.totalCount !== 1 ||
      axisPayload.hits?.[0]?.path !== "Literature/semantic-retrieval.md" ||
      axisPayload.cursor !== null ||
      axisPayload.intent !== "verify the R4 axis query envelope" ||
      axisPayload.receipt?.usedChannels?.join(",") !== "lex"
    ) {
      fail("MCP R4 axis query did not return the full renamed query-op envelope");
    }
    // Model-less, the refusal surfaces either as an isError tool envelope or as a
    // thrown protocol McpError, depending on how far the call gets before the
    // missing model/store stops it (e.g. an unsynced store dir throws on open).
    // Both are valid "guarded" signals; a clean result is NOT.
    const callGuarded = async (call) => {
      try {
        const res = await client.callTool(call);
        return { guarded: res.isError === true, text: textOf(res) };
      } catch (err) {
        return { guarded: true, text: err instanceof Error ? err.message : String(err) };
      }
    };
    if (hasModel) {
      const sync = await client.callTool(syncCall);
      const syncPayload = JSON.parse(textOf(sync) || "{}");
      if (syncPayload.available !== true) fail("MCP semantic sync did not report available true");
      const query = await client.callTool(queryCall);
      const queryPayload = JSON.parse(textOf(query) || "{}");
      if (queryPayload.hits?.[0]?.path !== "Literature/semantic-retrieval.md") {
        fail("MCP semantic query did not find packaged smoke note");
      }
    } else {
      // sync gives the strong routing proof: the ADR-007 loud guard naming the model env.
      const sync = await callGuarded(syncCall);
      if (!sync.guarded || !/OMS_EMBEDDING_PROVIDER|OMS_EMBEDDING_MODEL/.test(sync.text)) {
        fail("MCP semantic sync did not loud-guard the missing embedding model (ADR-007)");
      }
      // Plain query expands to lexical retrieval, so a model-less packaged vault
      // still returns the smoke note. Explicit vec remains guarded by ADR-007.
      const query = await client.callTool(queryCall);
      const queryPayload = JSON.parse(textOf(query) || "{}");
      if (query.isError || queryPayload.hits?.[0]?.path !== "Literature/semantic-retrieval.md") {
        fail("MCP plain semantic query did not return the packaged smoke note without an embedding model");
      }
    }
    // ADR-009 D2 retired the qmd-compatible surface, so the packaged server
    // must NOT advertise it. Asserting its absence keeps a retired surface from
    // quietly reappearing in a published artifact.
    const templates = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
    if (templates.resourceTemplates.some((template) => template.uriTemplate?.startsWith("qmd://"))) {
      fail("MCP server still advertises a retired qmd:// resource template (ADR-009 D2)");
    }

    // The public surface must be exactly the five tools.
    const publicTools = result.tools.map((tool) => tool.name).sort();
    const expectedTools = ["oms_doctor", "oms_link", "oms_search", "oms_status", "oms_write"];
    if (JSON.stringify(publicTools) !== JSON.stringify(expectedTools)) {
      fail(
        `MCP public tool surface drifted: expected ${expectedTools.join(", ")}, got ${publicTools.join(", ")}`,
      );
    }
    console.log("[release:artifact-smoke] ok: MCP listTools works from unpacked package.");
  } finally {
    await client.close();
  }
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "oms-release-smoke-"));
// Every packaged-CLI child this script spawns gets HOME pointed here instead
// of the real user's HOME, so nothing that CLI does can reach the real `~/.oms`.
const smokeHome = path.join(tempRoot, "Home");
mkdirSync(smokeHome, { recursive: true });
const realOmsDir = path.join(homedir(), ".oms");
const realOmsBefore = snapshotDir(realOmsDir);
let tarball;
try {
  tarball = packTarball();
  const packageRoot = extractPackage(tarball, tempRoot);
  for (const requiredPath of harnessSurfaceRegistry.packageAssets.releaseRequiredPaths) {
    assertPath(path.join(packageRoot, requiredPath), `required release asset ${requiredPath}`);
  }
  installRuntimeDependencies(packageRoot);
  const vault = makeVault(tempRoot);
  if (runSetup) {
    setupSmoke(packageRoot, vault, smokeHome);
    hostInstallSmoke(packageRoot, vault, smokeHome);
    updateSmoke(packageRoot, vault, smokeHome);
  }
  if (runMcp) await mcpSmoke(packageRoot, vault, smokeHome);
  // The whole point of smokeHome: prove the real HOME's `.oms` directory was
  // never touched by any of the above, however many CLI/MCP children ran.
  // No `.oms` before must mean no `.oms` after; an existing one must be
  // byte-identical (per the snapshotDir metadata comparison above).
  const realOmsAfter = snapshotDir(realOmsDir);
  if (realOmsAfter !== realOmsBefore) {
    fail(`real HOME .oms directory changed during the smoke run: ${realOmsDir}`);
  }
} finally {
  if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}
