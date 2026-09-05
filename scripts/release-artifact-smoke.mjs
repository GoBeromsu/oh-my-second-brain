#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";

const args = new Set(process.argv.slice(2));
const runSetup = !args.has("--mcp-only");
const runMcp = !args.has("--setup-only");

function fail(message) {
  throw new Error(`[release:artifact-smoke] ${message}`);
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
  const environment = { ...process.env };
  delete environment.OMS_CLAUDE_HOME;
  delete environment.OMS_CODEX_HOME;
  delete environment.OMS_HERMES_HOME;
  return { ...environment, HOME: smokeHome, USERPROFILE: smokeHome, ...overrides };
}

// Metadata-only snapshot. Symlinks are recorded by target and never followed:
// active host profiles can contain links outside their own roots, including
// transient application paths. This intentionally avoids hashing large models.
function snapshotPath(root) {
  const entries = [];
  const walk = (current, rel) => {
    let st;
    try {
      st = lstatSync(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        entries.push(`${rel}:absent`);
        return;
      }
      throw error;
    }
    if (st.isSymbolicLink()) {
      entries.push(`${rel}:link:${readlinkSync(current)}`);
      return;
    }
    if (!st.isDirectory()) {
      entries.push(`${rel}:file:${st.size}:${st.mtimeMs}`);
      return;
    }
    entries.push(`${rel}/`);
    for (const name of readdirSync(current).sort()) {
      walk(path.join(current, name), rel === "" ? name : `${rel}/${name}`);
    }
  };
  walk(root, ".");
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
  mkdirSync(path.join(vault, "Literature"), { recursive: true });
  mkdirSync(path.join(vault, "Template Sources"), { recursive: true });
  mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  mkdirSync(path.join(vault, ".oms"), { recursive: true });
  writeFileSync(path.join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { template: "text", title: "text", tags: "list" } }), "utf-8");
  writeFileSync(path.join(vault, ".oms", "taxonomy.json"), JSON.stringify({
    folders: {},
    templates: {
      note: { templateFolder: "Notes" },
      literature: { templateFolder: "Literature" },
    },
  }), "utf-8");
  writeFileSync(
    path.join(vault, "Literature", "semantic-retrieval.md"),
    "---\ntemplate: literature\ntitle: Semantic Retrieval\ntags:\n  - smoke-semantic\n---\n# Semantic Retrieval\n\nAgent retrieval uses OMS native semantic search.\n",
    "utf-8",
  );
  return vault;
}

function setupSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const env = smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" });
  const dryRun = run(process.execPath, [cli, "setup", "--vault", vault, "--template-folder", "Template Sources", "--dry-run", "--install-claude"], { cwd: packageRoot, env });
  const approval = /"approvalDigest":\s*"(sha256:[0-9a-f]{64})"/u.exec(dryRun.stdout)?.[1];
  if (!approval) fail("setup dry-run did not return an approval digest");
  if (!dryRun.stdout.includes("Template Sources/note.md")) fail("setup dry-run did not propose the starter in the explicit source folder");
  if (existsSync(path.join(vault, "Template Sources", "note.md"))) fail("setup dry-run published its starter");
  const result = run(process.execPath, [cli, "setup", "--vault", vault, "--template-folder", "Template Sources", "--yes", "--approved-digest", approval, "--install-claude"], { cwd: packageRoot, env });
  const output = `${result.stdout}\n${result.stderr}`;
  assertPath(path.join(vault, ".oms/taxonomy.json"), "vault taxonomy");
  if (existsSync(path.join(vault, ".oms/taxonomy.yaml"))) fail("setup retained retired vault taxonomy YAML");
  assertPath(path.join(vault, ".oms/template-policy.json"), "vault template policy");
  assertPath(path.join(vault, ".oms/types.json"), "vault derived projection");
  assertPath(path.join(vault, "Template Sources", "note.md"), "approved starter template");
  if (existsSync(path.join(vault, ".oms/concepts"))) fail("setup recreated the retired concepts directory");
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
  console.log("[release:artifact-smoke] ok: setup dry-run/approved apply works from unpacked package.");
}

function canonicalCliSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const env = smokeEnv(smokeHome, {
    OMS_UPDATE_NOTICE: "0",
    XDG_CACHE_HOME: path.join(smokeHome, ".cache"),
  });
  const invoke = (args) => spawnSync(process.execPath, [cli, ...args, "--vault", vault], {
    cwd: packageRoot,
    encoding: "utf-8",
    env,
  });
  const expectExit = (args, expected) => {
    const result = invoke(args);
    if (result.status !== expected) {
      process.stderr.write(result.stderr ?? "");
      process.stdout.write(result.stdout ?? "");
      fail(`packaged oms ${args.join(" ")} exited ${result.status}; expected ${expected}`);
    }
    return result;
  };
  const approvedMutation = (mutationArgs) => {
    const dryRun = expectExit([...mutationArgs, "--dry-run"], 0);
    const approval = /"approvalDigest":\s*"(sha256:[0-9a-f]{64})"/u.exec(dryRun.stdout)?.[1];
    if (!approval) fail(`packaged oms ${mutationArgs.join(" ")} did not return an approval digest`);
    return expectExit([...mutationArgs, "--yes", "--approved-digest", approval], 0);
  };

  writeFileSync(
    path.join(vault, "Template Sources", "literature.md"),
    "---\ntemplate: literature\ntitle: Untitled\ntags: []\n---\n# Literature\n<!-- oms:content -->\n",
    "utf-8",
  );
  approvedMutation([
    "template", "add", "Template Sources/literature.md", "--id", "literature",
    "--folder", "Template Sources", "--contract", "base",
  ]);
  approvedMutation(["template", "default", "literature"]);
  const listed = expectExit(["template", "list"], 0);
  if (!listed.stdout.includes('"literature"')) fail("packaged template list omitted the registered template");
  const shown = expectExit(["template", "show", "literature"], 0);
  if (!shown.stdout.includes("Template Sources/literature.md") || shown.stdout.includes("Agent retrieval uses")) {
    fail("packaged template show did not return safe registered-template metadata");
  }

  const search = expectExit(["search", "query", "agent retrieval"], 0);
  const searchPayload = JSON.parse(search.stdout);
  if (searchPayload.hits?.[0]?.path !== "Literature/semantic-retrieval.md") {
    fail("packaged oms search did not return the smoke note");
  }
  expectExit(["index", "sync"], 0);
  expectExit(["index", "status"], 0);
  const retiredEmbedBoolean = expectExit(["index", "sync", "--embed"], 1);
  if (!`${retiredEmbedBoolean.stdout}\n${retiredEmbedBoolean.stderr}`.includes("INDEX_ARGS_INVALID: --embed is not valid for index sync")) {
    fail("packaged oms index sync did not identify the rejected overlapping --embed flag");
  }
  const document = expectExit(["note", "get", "Literature/semantic-retrieval.md"], 0);
  if (!document.stdout.includes("Semantic Retrieval")) {
    fail("packaged oms note get did not hydrate the smoke note");
  }

  const embed = expectExit(["index", "embed"], 1);
  const embedOutput = `${embed.stdout}\n${embed.stderr}`;
  for (const expected of [
    "OMS_EMBEDDING_PROVIDER",
    "OMS_EMBEDDING_MODEL",
    ".oms/models.json",
    "oms setup --models-default",
  ]) {
    if (!embedOutput.includes(expected)) fail(`packaged oms index embed guidance omitted ${expected}`);
  }
  expectExit(["index", "repair", "--mode", "rebuild", "--dry-run"], 0);
  expectExit(["index", "clean"], 0);
  const expansion = expectExit(["search", "query", "agent retrieval", "--expand"], 1);
  const expansionOutput = `${expansion.stdout}\n${expansion.stderr}`;
  if (!expansionOutput.includes("OMS_EMBEDDING_PROVIDER") || !expansionOutput.includes("OMS_EMBEDDING_MODEL")) {
    fail("packaged oms search --expand did not enforce embedding admission before expansion");
  }
  const retiredSemantic = expectExit(["semantic"], 1);
  if (!`${retiredSemantic.stdout}\n${retiredSemantic.stderr}`.includes("Unknown command: semantic")) {
    fail("packaged oms semantic did not fail through the unknown-command boundary");
  }
  console.log("[release:artifact-smoke] ok: canonical template/search/index/note CLI works from unpacked package.");
}

function hostInstallSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const result = run(process.execPath, [cli, "host", "install", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const expected of ["[claude] install", "[codex] install", "[hermes] install", "rules/oms.md", "skills/knowledge-management/oms"]) {
    if (!output.includes(expected)) fail(`host install dry-run did not include ${expected}`);
  }
  run(process.execPath, [cli, "host", "sync", "--runtime", "all", "--vault", vault, "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
  });
  run(process.execPath, [cli, "host", "remove", "--runtime", "all", "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
  });
  console.log("[release:artifact-smoke] ok: host install/sync/remove dry-runs work from unpacked package.");
}

function updateSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  run(process.execPath, [cli, "package", "check"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_LATEST_VERSION: "999.0.0" }),
  });
  const result = run(process.execPath, [cli, "package", "update", "--dry-run"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_LATEST_VERSION: "999.0.0" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const expected of [
    "npm install -g oh-my-second-brain@latest",
    "newly installed `oms host sync`",
    "Run `oms package update --yes`",
  ]) {
    if (!output.includes(expected)) fail(`package update dry-run did not include ${expected}`);
  }
  if (/\breconcile\b/u.test(output)) {
    fail("package update advertised the retired reconcile command");
  }
  console.log("[release:artifact-smoke] ok: package check/update works from unpacked package.");
}

async function httpServeSmoke(packageRoot, vault, smokeHome) {
  const cli = path.join(packageRoot, "dist/cli/oms.js");
  const child = spawn(process.execPath, [cli, "serve", "http", "--vault", vault, "--host", "127.0.0.1", "--port", "0"], {
    cwd: packageRoot,
    env: smokeEnv(smokeHome, { OMS_UPDATE_NOTICE: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const url = await new Promise((resolveUrl, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error(`serve http did not become ready: ${stderr}`)), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const line = stdout.split(/\r?\n/u).find((value) => value.trim().startsWith("{"));
        if (!line) return;
        try {
          const payload = JSON.parse(line);
          if (payload.status === "listening" && typeof payload.url === "string") {
            clearTimeout(timeout);
            resolveUrl(payload.url);
          }
        } catch {
          // Wait for a complete JSON line.
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve http exited ${code} before listening: ${stderr}`));
      });
    });
    const response = await fetch(`${url}/health`);
    if (!response.ok) fail(`packaged oms serve http health returned ${response.status}`);
  } finally {
    child.kill("SIGTERM");
  }
  console.log("[release:artifact-smoke] ok: serve http starts read-only from unpacked package.");
}

async function crossVersionHostRehearsal(tarball, tempRoot) {
  const prefix = path.join(tempRoot, "CrossVersionPrefix");
  const home = path.join(tempRoot, "CrossVersionHome");
  const xdgConfig = path.join(tempRoot, "CrossVersionXdgConfig");
  const xdgCache = path.join(tempRoot, "CrossVersionXdgCache");
  const xdgData = path.join(tempRoot, "CrossVersionXdgData");
  const npmCache = path.join(tempRoot, "CrossVersionNpmCache");
  const runtimeRoot = path.join(tempRoot, "CrossVersionRuntime");
  const hermesHome = path.join(tempRoot, "CrossVersionHermes");
  const vault = path.join(tempRoot, "CrossVersionVault");
  for (const directory of [prefix, home, xdgConfig, xdgCache, xdgData, npmCache, runtimeRoot, hermesHome, vault]) {
    mkdirSync(directory, { recursive: true });
  }
  const npmUserConfig = path.join(tempRoot, "CrossVersionNpmrc");
  writeFileSync(npmUserConfig, "", "utf8");
  const environment = smokeEnv(home, {
    PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    HERMES_HOME: hermesHome,
    OMS_HERMES_HOME: hermesHome,
    OMS_RUNTIME_ROOT: runtimeRoot,
    OMS_VAULT: "",
    npm_config_prefix: prefix,
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    OMS_UPDATE_NOTICE: "0",
  });
  const configPath = path.join(hermesHome, "config.yaml");
  const customConfig = "custom_release_rehearsal: preserve-me\n";
  writeFileSync(configPath, customConfig, "utf8");
  const installedPackage = path.join(prefix, "lib", "node_modules", "oh-my-second-brain");
  const installedCli = path.join(prefix, "bin", "oms");

  run("npm", ["install", "-g", "oh-my-second-brain@0.13.0", "--no-audit", "--no-fund"], {
    env: environment,
  });
  assertPath(installedCli, "old release global oms binary");
  const oldPackage = JSON.parse(readFileSync(path.join(installedPackage, "package.json"), "utf8"));
  if (oldPackage.version !== "0.13.0") fail(`old rehearsal install resolved ${oldPackage.version}, expected 0.13.0`);
  run(installedCli, ["install", "--runtime", "hermes", "--vault", vault, "--yes"], {
    env: environment,
  });
  const oldProvenance = path.join(hermesHome, "adapters", "oms", "oms-provenance.json");
  assertPath(oldProvenance, "legitimate old Hermes OMS provenance");
  const oldIdentity = JSON.parse(readFileSync(oldProvenance, "utf8"));
  if (oldIdentity.source !== "npm" || oldIdentity.version !== "0.13.0" || typeof oldIdentity.skillTreeDigest !== "string") {
    fail("old release did not create legitimate npm Hermes ownership provenance");
  }
  if (!readFileSync(configPath, "utf8").includes("preserve-me")) {
    fail("old release install did not preserve unrelated Hermes configuration");
  }

  run("npm", ["install", "-g", tarball, "--no-audit", "--no-fund"], {
    env: environment,
  });
  const candidatePackage = JSON.parse(readFileSync(path.join(installedPackage, "package.json"), "utf8"));
  const candidateManifest = JSON.parse(readFileSync(path.join(installedPackage, "assets", "hermes-manifest.json"), "utf8"));
  if (candidateManifest.version !== candidatePackage.version) {
    fail(`installed candidate manifest version ${candidateManifest.version} does not match package ${candidatePackage.version}`);
  }
  run(installedCli, ["host", "sync", "--runtime", "hermes", "--vault", vault], {
    env: environment,
  });
  const installedConfig = readFileSync(configPath, "utf8");
  if (!installedConfig.includes("preserve-me")) fail("new host sync overwrote unrelated Hermes configuration");
  if (!installedConfig.includes("- serve\n") || !installedConfig.includes("- mcp\n") || !installedConfig.includes(vault)) {
    fail("new host sync did not publish canonical serve mcp arguments for the rehearsal vault");
  }
  const installedManifest = JSON.parse(readFileSync(path.join(hermesHome, "adapters", "oms", "hermes-manifest.json"), "utf8"));
  if (installedManifest.version !== candidatePackage.version) {
    fail(`loaded Hermes manifest version ${installedManifest.version} does not match installed package ${candidatePackage.version}`);
  }
  const installedProvenance = JSON.parse(readFileSync(oldProvenance, "utf8"));
  if (installedProvenance.version !== candidatePackage.version) {
    fail(`loaded Hermes provenance version ${installedProvenance.version} does not match installed package ${candidatePackage.version}`);
  }
  const status = spawnSync(installedCli, ["host", "status", "--vault", vault, "--json"], { env: environment, encoding: "utf8" });
  if (status.status !== 0 && status.status !== 1) fail("installed host status did not return a health receipt");
  const statusPayload = JSON.parse(status.stdout);
  const isHermesAsset = (asset) => asset.id === "registration:hermes" || asset.id?.startsWith("hermes:");
  const hermesAssets = statusPayload.assets?.filter(isHermesAsset);
  if (!hermesAssets?.length || hermesAssets.some((asset) => asset.state !== "ok")) {
    fail("upgraded Hermes has missing or invalid managed assets");
  }
  if (status.status === 1 && (statusPayload.status !== "degraded" || !statusPayload.assets.some((asset) => !isHermesAsset(asset) && asset.state !== "ok"))) {
    fail("host status failed for a reason other than unrelated uninstalled hosts");
  }
  const hermesAsset = hermesAssets.find((asset) => asset.kind === "skill-tree");
  if (hermesAsset?.packageVersion !== candidatePackage.version || hermesAsset?.recordedVersion !== candidatePackage.version || hermesAsset?.digestMatch !== true) {
    fail("new binary did not load matching installed Hermes manifest/provenance identity");
  }
  const skillRoot = path.join(hermesHome, "skills", "knowledge-management", "oms");
  const expectedSkills = ["distill", "doctor", "link", "search", "status", "template", "write"];
  for (const skill of expectedSkills) assertPath(path.join(skillRoot, skill, "SKILL.md"), `installed Hermes ${skill} skill`);
  const installedSkills = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(installedSkills) !== JSON.stringify(expectedSkills)) {
    fail(`installed Hermes skills drifted: expected ${expectedSkills.join(", ")}, got ${installedSkills.join(", ")}`);
  }

  const registration = parseYaml(installedConfig)?.mcp_servers?.oms;
  if (registration?.command !== "oms" || !Array.isArray(registration.args) ||
    JSON.stringify(registration.args.slice(0, 3)) !== JSON.stringify(["serve", "mcp", "--vault"]) ||
    registration.args.length !== 4 || realpathSync(registration.args[3]) !== realpathSync(vault)) {
    fail("installed Hermes MCP registration does not resolve the candidate vault");
  }
  const transport = new StdioClientTransport({
    command: registration.command,
    args: registration.args,
    env: {
      ...getDefaultEnvironment(),
      PATH: environment.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      HERMES_HOME: hermesHome,
      OMS_HERMES_HOME: hermesHome,
      OMS_RUNTIME_ROOT: runtimeRoot,
      OMS_VAULT: "",
      OMS_UPDATE_NOTICE: "0",
    },
  });
  const client = new Client({ name: "oms-cross-version-release-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    if (client.getServerVersion()?.version !== candidatePackage.version) fail("native MCP launch loaded the wrong package version");
    const listedTools = (await client.listTools()).tools;
    if (!listedTools.find((tool) => tool.name === "search")?.inputSchema.oneOf?.some((branch) => branch.properties?.op?.const === "index-status")) {
      fail("native MCP launch did not load the candidate operation schema");
    }
    const tools = listedTools.map((tool) => tool.name).sort();
    const expectedTools = ["doctor", "link", "search", "status", "write"];
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
      fail(`cross-version MCP discovery drifted: expected ${expectedTools.join(", ")}, got ${tools.join(", ")}`);
    }
  } finally {
    await client.close();
  }
  console.log(`[release:artifact-smoke] ok: external 0.13.0 -> candidate ${candidatePackage.version} host sync preserved legitimate Hermes ownership.`);
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
    args: [cli, "serve", "mcp", "--vault", vault],
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
      name: "search",
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
      name: "doctor",
      arguments: { op: "sync-embeddings", collection: "vault" },
    };
    const queryCall = {
      name: "search",
      arguments: { op: "query", query: "agent retr", collection: "vault", limit: 1 },
    };
    // R4's public envelope keeps axis narrowing under the renamed `query` op;
    // this is deliberately a model-free lexical call so every release runner
    // exercises axes, paging, candidates, rerank selection, and receipt DTOs.
    const axisQuery = await client.callTool({
      name: "search",
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
    const expectedTools = ["doctor", "link", "search", "status", "write"];
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

let tempRoot;
let tarball;
try {
  tempRoot = mkdtempSync(path.join(tmpdir(), "oms-release-smoke-"));
  // Every packaged-CLI child gets an isolated HOME. Guard only OMS-owned state:
  // active Hermes logs, databases, profiles, and home links are unrelated and
  // may change concurrently while this smoke runs.
  const smokeHome = path.join(tempRoot, "Home");
  mkdirSync(smokeHome, { recursive: true });
  const protectedHomePaths = [
    path.join(homedir(), ".oms"),
    path.join(homedir(), ".hermes", "config.yaml"),
    path.join(homedir(), ".hermes", "skills", "knowledge-management", "oms"),
    path.join(homedir(), ".hermes", "adapters", "oms"),
    path.join(homedir(), ".config", "hermes", "config.yaml"),
    path.join(homedir(), ".config", "hermes", "skills", "knowledge-management", "oms"),
    path.join(homedir(), ".config", "hermes", "adapters", "oms"),
  ];
  const protectedHomeBefore = new Map(protectedHomePaths.map((pathname) => [pathname, snapshotPath(pathname)]));
  tarball = packTarball();
  const packageRoot = extractPackage(tarball, tempRoot);
  for (const requiredPath of harnessSurfaceRegistry.packageAssets.releaseRequiredPaths) {
    assertPath(path.join(packageRoot, requiredPath), `required release asset ${requiredPath}`);
  }
  installRuntimeDependencies(packageRoot);
  const vault = makeVault(tempRoot);
  if (runSetup) {
    setupSmoke(packageRoot, vault, smokeHome);
    canonicalCliSmoke(packageRoot, vault, smokeHome);
    hostInstallSmoke(packageRoot, vault, smokeHome);
    updateSmoke(packageRoot, vault, smokeHome);
    await httpServeSmoke(packageRoot, vault, smokeHome);
    await crossVersionHostRehearsal(tarball, tempRoot);
  }
  if (runMcp) await mcpSmoke(packageRoot, vault, smokeHome);
  // This is metadata evidence, not a byte-content digest. It preserves the
  // original broad ~/.oms model guard without reading model bytes, while the
  // Hermes checks are limited to exact OMS-managed config/assets.
  for (const pathname of protectedHomePaths) {
    if (snapshotPath(pathname) !== protectedHomeBefore.get(pathname)) {
      fail(`real HOME OMS-managed metadata changed during the smoke run: ${pathname}`);
    }
  }
} finally {
  if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
}
