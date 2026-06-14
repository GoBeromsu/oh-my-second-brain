#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`[release:pack] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(result.stdout ?? "");
    fail(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout;
}

function hasPath(files, requiredPath) {
  return files.some((file) => file.path === requiredPath || file.path.startsWith(`${requiredPath}/`));
}

const stdout = run("npm", ["pack", "--dry-run", "--json"]);
let packs;
try {
  packs = JSON.parse(stdout);
} catch (error) {
  fail(`could not parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const pack = packs?.[0];
if (!pack || !Array.isArray(pack.files)) {
  fail("npm pack JSON did not include a files array");
}

const files = pack.files;
const required = [
  "package.json",
  "dist/cli/oms.js",
  "dist/mcp/server.js",
  "core/ontology/taxonomy.yaml",
  "core/ontology/concepts",
  "adapters/claude-code/.claude-plugin/plugin.json",
  "adapters/claude-code/skills/setup/SKILL.md",
  "adapters/claude-code/skills/doctor/SKILL.md",
  "adapters/claude-code/skills/define/SKILL.md",
  "adapters/claude-code/skills/capture/SKILL.md",
  "adapters/claude-code/skills/retrieve/SKILL.md",
  "adapters/claude-code/skills/uninstall/SKILL.md",
  "adapters/claude-code/skills/update/SKILL.md",
  "adapters/codex/.codex-plugin/plugin.json",
  "adapters/codex/.mcp.json",
  "adapters/codex/rules/oms.md",
  "adapters/codex/skills/oms-setup/SKILL.md",
  "adapters/codex/skills/oms-capture/SKILL.md",
  "adapters/codex/skills/oms-retrieve/SKILL.md",
  "adapters/codex/skills/oms-update/SKILL.md",
  "adapters/hermes/manifest.json",
  "adapters/hermes/skills/setup/SKILL.md",
  "adapters/hermes/skills/capture/SKILL.md",
  "adapters/hermes/skills/retrieve/SKILL.md",
  "adapters/hermes/skills/update/SKILL.md",
  "docs/install.md",
  "docs/release.md",
  "scripts/install.sh",
  "scripts/uninstall.sh",
];

const missing = required.filter((requiredPath) => !hasPath(files, requiredPath));
if (missing.length > 0) {
  fail(`package tarball is missing required release assets:\n${missing.map((item) => `  - ${item}`).join("\n")}\nUpdate package.json files or create the missing release docs.`);
}

const forbidden = [
  "dist/cli/lexa.js",
  "dist/cli/lexa.d.ts",
  "dist/cli/lexa.js.map",
  "adapters/codex/rules/lexa.md",
  "adapters/codex/skills/lexa-setup/SKILL.md",
  "adapters/codex/skills/lexa-capture/SKILL.md",
  "adapters/codex/skills/lexa-retrieve/SKILL.md",
].filter((forbiddenPath) => hasPath(files, forbiddenPath));
if (forbidden.length > 0) {
  fail(`package tarball includes forbidden legacy removed assets:\n${forbidden.map((item) => `  - ${item}`).join("\n")}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
if (packageJson.name !== "oh-my-second-brain") {
  fail(`package name must be oh-my-second-brain, got ${packageJson.name}`);
}
if (packageJson.repository?.url !== "git+https://github.com/GoBeromsu/oh-my-second-brain.git") {
  fail(`repository URL must point at GoBeromsu/oh-my-second-brain, got ${packageJson.repository?.url}`);
}
if (packageJson.bin?.["oh-my-second-brain"] !== "dist/cli/oms.js") {
  fail("package bin must expose canonical oh-my-second-brain command");
}
if (packageJson.bin?.oms !== "dist/cli/oms.js") {
  fail("package bin must preserve oms compatibility alias");
}
const pluginJson = JSON.parse(readFileSync("adapters/claude-code/.claude-plugin/plugin.json", "utf-8"));
if (packageJson.version !== pluginJson.version) {
  fail(`version mismatch: package.json=${packageJson.version}, Claude plugin=${pluginJson.version}`);
}
const codexPluginJson = JSON.parse(readFileSync("adapters/codex/.codex-plugin/plugin.json", "utf-8"));
if (packageJson.version !== codexPluginJson.version) {
  fail(`version mismatch: package.json=${packageJson.version}, Codex plugin=${codexPluginJson.version}`);
}
const hermesManifestJson = JSON.parse(readFileSync("adapters/hermes/manifest.json", "utf-8"));
if (packageJson.version !== hermesManifestJson.version) {
  fail(`version mismatch: package.json=${packageJson.version}, Hermes manifest=${hermesManifestJson.version}`);
}

console.log(`[release:pack] ok: ${pack.filename} includes ${files.length} files and required release assets.`);
