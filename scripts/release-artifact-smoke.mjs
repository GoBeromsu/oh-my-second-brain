#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function setupSmoke(packageRoot, vault) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "setup", "--vault", vault, "--yes", "--install-claude"], {
    cwd: packageRoot,
    env: { ...process.env, OMS_UPDATE_NOTICE: "0" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assertPath(path.join(vault, ".oms/taxonomy.yaml"), "vault taxonomy");
  assertPath(path.join(vault, ".oms/concepts"), "vault concepts directory");
  if (!output.includes("claude plugin install")) fail("setup output did not include Claude plugin install command");
  if (!output.includes("claude mcp add oms -- oms mcp --vault")) {
    fail("setup output did not include Claude MCP registration command");
  }
  const pluginPathLine = output.split(/\r?\n/).find((line) => line.includes("Plugin path:"));
  if (!pluginPathLine) fail("setup output did not include Plugin path line");
  const pluginPath = pluginPathLine.replace(/^.*Plugin path:\s*/, "").trim();
  assertPath(path.join(pluginPath, ".claude-plugin/plugin.json"), "printed Claude plugin manifest path");
  const expectedRoot = path.join(packageRoot, "adapters/claude-code");
  if (realpathSync(path.resolve(pluginPath)) !== realpathSync(path.resolve(expectedRoot))) {
    fail(`printed plugin path must resolve inside extracted package: expected ${expectedRoot}, got ${pluginPath}`);
  }
  console.log("[release:artifact-smoke] ok: setup dry-run works from unpacked package.");
}

function hostInstallSmoke(packageRoot, vault) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "install", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: { ...process.env, OMS_UPDATE_NOTICE: "0" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const expected of ["claude install", "codex install", "hermes install", "rules/oms.md", "skills/knowledge-management/oms"]) {
    if (!output.includes(expected)) fail(`host install dry-run did not include ${expected}`);
  }
  console.log("[release:artifact-smoke] ok: host install dry-run works from unpacked package.");
}

function updateSmoke(packageRoot, vault) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "update", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: { ...process.env, OMS_UPDATE_LATEST_VERSION: "999.0.0" },
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

async function mcpSmoke(packageRoot, vault) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  // StdioClientTransport sandboxes the child env to a safe default subset, so the
  // embedding-model path must be forwarded explicitly or the child is always
  // model-less regardless of this process's env -- which would desync it from the
  // hasModel gate below. Forward only the local OMS_MODEL_PATH (no remote Upstage
  // network from an artifact smoke), matching src/mcp/semantic-server.test.ts.
  const childEnv = { ...getDefaultEnvironment() };
  if (process.env.OMS_MODEL_PATH) childEnv.OMS_MODEL_PATH = process.env.OMS_MODEL_PATH;
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
    const requiredTools = [
      "oms_graph_status",
      "oms_graph_build",
      "oms_list_concepts",
      "oms_retrieve_by_axis",
      "oms_retrieve_context",
      "oms_sync_embeddings",
      "oms_semantic_query",
      "oms_semantic_status",
      "oms_semantic_collections",
      "oms_semantic_contexts",
      "oms_semantic_cleanup",
      "oms_get_document",
      "query",
      "status",
      "get",
      "multi_get",
      "oms_multi_get_documents",
      "oms_lazy_load_note",
      "oms_validate_contract",
      "oms_capture_prepare",
      "oms_capture_commit",
    ];
    const missing = requiredTools.filter((tool) => !toolNames.has(tool));
    if (missing.length > 0) fail(`MCP server missing tools: ${missing.join(", ")}`);
    // Warm the backing store the way the WITH/NO-model unit test does. On a
    // model-less host the qmd:// ReadResource and semantic query below hydrate
    // from the src/search SQLite store, which only exists after a sync -- and
    // oms_sync_embeddings is engine-owned, so it loud-guards (ADR-007) instead
    // of populating that store without a model. retrieve_context's lenient
    // semantic leg with embeddingSyncBeforeSearch is the model-free way to
    // populate it; with a model present the engine handles the sync just as well.
    await client.callTool({
      name: "oms_retrieve_context",
      arguments: {
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
        semanticIntent: "warm the src/search store for the model-less artifact smoke",
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
    // engine, not the legacy hash store. Mirrors src/mcp/semantic-server.test.ts.
    // Gate on the local model path only, mirroring semantic-server.test.ts: the
    // smoke forwards OMS_MODEL_PATH to the child but deliberately leaves the remote
    // Upstage path out (no network in CI), so gating on UPSTAGE_API_KEY here would
    // desync the runner gate from the forwarded child env.
    const hasModel = Boolean(process.env.OMS_MODEL_PATH);
    const textOf = (res) => (res.content?.[0]?.type === "text" ? res.content[0].text : "");
    const syncCall = { name: "oms_sync_embeddings", arguments: { collection: "vault" } };
    const queryCall = {
      name: "oms_semantic_query",
      arguments: { query: "lex: agent retr", collection: "vault", limit: 1 },
    };
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
      if (!sync.guarded || !/OMS_MODEL_PATH|UPSTAGE_API_KEY/.test(sync.text)) {
        fail("MCP semantic sync did not loud-guard the missing embedding model (ADR-007)");
      }
      // query must likewise refuse to falsely succeed without a model/store.
      const query = await callGuarded(queryCall);
      if (!query.guarded) fail("MCP semantic query falsely succeeded without an embedding model (ADR-007)");
    }
    const templates = await client.listResourceTemplates();
    if (!templates.resourceTemplates.some((template) => template.uriTemplate === "qmd://{path}")) {
      fail("MCP server missing qmd:// resource template");
    }
    const resource = await client.readResource({ uri: "qmd://Literature/semantic-retrieval.md" });
    const text = resource.contents[0]?.text ?? "";
    if (!text.includes("Agent retrieval uses OMS native semantic search")) {
      fail("MCP qmd:// resource did not read semantic smoke note");
    }
    console.log("[release:artifact-smoke] ok: MCP listTools works from unpacked package.");
  } finally {
    await client.close();
  }
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "oms-release-smoke-"));
let tarball;
try {
  tarball = packTarball();
  const packageRoot = extractPackage(tarball, tempRoot);
  assertPath(path.join(packageRoot, "dist"), "dist directory");
  assertPath(path.join(packageRoot, "core"), "core directory");
  assertPath(path.join(packageRoot, "adapters/claude-code/.claude-plugin/plugin.json"), "Claude plugin manifest");
  assertPath(path.join(packageRoot, "adapters/claude-code/skills/update/SKILL.md"), "Claude update skill");
  assertPath(path.join(packageRoot, "adapters/codex/rules/oms.md"), "Codex Oh My Second Brain rule");
  assertPath(path.join(packageRoot, "adapters/codex/skills/oms-capture/SKILL.md"), "Codex Oh My Second Brain capture skill");
  assertPath(path.join(packageRoot, "adapters/codex/skills/oms-update/SKILL.md"), "Codex Oh My Second Brain update skill");
  assertPath(path.join(packageRoot, "adapters/hermes/skills/capture/SKILL.md"), "Hermes Oh My Second Brain capture skill");
  assertPath(path.join(packageRoot, "adapters/hermes/skills/update/SKILL.md"), "Hermes Oh My Second Brain update skill");
  assertPath(path.join(packageRoot, "docs/install.md"), "install docs");
  assertPath(path.join(packageRoot, "docs/release.md"), "release docs");
  assertPath(path.join(packageRoot, "scripts/install.sh"), "install shell script");
  assertPath(path.join(packageRoot, "scripts/uninstall.sh"), "uninstall shell script");
  installRuntimeDependencies(packageRoot);
  const vault = makeVault(tempRoot);
  if (runSetup) {
    setupSmoke(packageRoot, vault);
    hostInstallSmoke(packageRoot, vault);
    updateSmoke(packageRoot, vault);
  }
  if (runMcp) await mcpSmoke(packageRoot, vault);
} finally {
  if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}
