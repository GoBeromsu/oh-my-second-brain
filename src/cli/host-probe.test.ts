import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstalledAssets } from "../kernel/install/asset-health.js";
import { hostSurfaceForRuntime } from "../kernel/install/hosts.js";
import { installCodex } from "../vendors/codex/codex.js";
import { installHermes } from "../vendors/hermes/hermes.js";
import { computeTreeDigest, serializeProvenance } from "../kernel/install/provenance.js";
import { discoverHostInstallAssets } from "./host-probe.js";

const roots: string[] = [];
const previous = { claude: process.env.OMS_CLAUDE_HOME, codex: process.env.OMS_CODEX_HOME, hermes: process.env.OMS_HERMES_HOME };

afterEach(async () => {
  process.env.OMS_CLAUDE_HOME = previous.claude;
  process.env.OMS_CODEX_HOME = previous.codex;
  process.env.OMS_HERMES_HOME = previous.hermes;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function homes(): Promise<{ readonly claude: string; readonly codex: string; readonly hermes: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-host-probe-"));
  roots.push(root);
  const result = { claude: path.join(root, "claude"), codex: path.join(root, "codex"), hermes: path.join(root, "hermes") };
  process.env.OMS_CLAUDE_HOME = result.claude;
  process.env.OMS_CODEX_HOME = result.codex;
  process.env.OMS_HERMES_HOME = result.hermes;
  return result;
}

function codexConfig(vault = "/vault"): string {
  return [
    "# BEGIN OMS MANAGED MCP",
    "[mcp_servers.oms]",
    'command = "oms"',
    `args = ["mcp", "--vault", "${vault}"]`,
    "",
    "[mcp_servers.oms.env]",
    'OMS_AGENT_RUNTIME = "codex"',
    "# END OMS MANAGED MCP",
    "",
  ].join("\n");
}

function hermesConfig(vault = "/vault"): string {
  return [
    "mcp_servers:",
    "  oms:",
    "    command: oms",
    `    args: [mcp, --vault, ${vault}]`,
    "    enabled: true",
    "",
  ].join("\n");
}

describe("discoverHostInstallAssets", () => {
  it("preserves corrupt Claude settings as inspection errors", async () => {
    const home = await homes();
    await mkdir(home.claude, { recursive: true });
    await writeFile(path.join(home.claude, "settings.json"), "{");
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:claude", evidence: { state: "inspection-error", cause: expect.any(String) } }));
    expect(result.hosts).toContainEqual({ host: "claude", state: "degraded" });
  });

  it("preserves unreadable Claude settings as an inspection error", async () => {
    const home = await homes();
    await mkdir(path.join(home.claude, "settings.json"), { recursive: true });
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:claude", evidence: { state: "inspection-error", cause: expect.any(String) } }));
    expect(result.hosts).toContainEqual({ host: "claude", state: "degraded" });
  });

  it("rejects lookalike guard and post-guard commands", async () => {
    const home = await homes();
    await mkdir(home.claude, { recursive: true });
    await writeFile(path.join(home.claude, "settings.json"), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: "not-owned oms-guard" }] }],
      PostToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: "not-owned oms-post-guard" }] }],
    } }));
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:claude", evidence: { state: "missing", cause: null } }));
    expect(result.hosts.map(host => host.host)).toEqual(["claude", "codex", "hermes"]);
  });

  it("does not accept Claude hooks registered under swapped events", async () => {
    const home = await homes();
    await mkdir(home.claude, { recursive: true });
    await writeFile(path.join(home.claude, "settings.json"), JSON.stringify({ hooks: {
      PostToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="/vault" oms-guard' }] }],
      PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="/vault" oms-post-guard' }] }],
    } }));
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:claude", evidence: { state: "missing", cause: null } }));
  });

  it.each([
    ["codex", "config.toml", "plugins/oms", "# BEGIN OMS MANAGED MCP\n[mcp_servers.oms]\n"],
    ["hermes", "config.yaml", "skills/knowledge-management/oms", "not: [valid"],
  ] as const)("reports corrupt %s registration with surrounding assets", async (runtime, config, surrounding, corrupt) => {
    const home = await homes();
    const runtimeHome = home[runtime];
    await mkdir(path.join(runtimeHome, surrounding), { recursive: true });
    await writeFile(path.join(runtimeHome, config), corrupt);
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: `registration:${runtime}`, evidence: { state: "inspection-error", cause: expect.any(String) } }));
    expect((await inspectInstalledAssets(result)).status).toBe("degraded");
  });

  it.each([
    ["codex", "plugins/oms"],
    ["hermes", "skills/knowledge-management/oms"],
  ] as const)("reports absent %s registration with surrounding assets", async (runtime, surrounding) => {
    const home = await homes();
    await mkdir(path.join(home[runtime], surrounding), { recursive: true });
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: `registration:${runtime}`, evidence: { state: "missing", cause: null } }));
    expect((await inspectInstalledAssets(result)).status).toBe("degraded");
  });

  it.each([
    ["codex", "config.toml", "plugins/oms", "# BEGIN OMS MANAGED MCP\n[mcp_servers.not_oms]\n# END OMS MANAGED MCP\n"],
    ["hermes", "config.yaml", "skills/knowledge-management/oms", "mcp_servers:\n  not_oms:\n    command: oms\n"],
  ] as const)("rejects a %s registration lookalike", async (runtime, config, surrounding, lookalike) => {
    const home = await homes();
    await mkdir(path.join(home[runtime], surrounding), { recursive: true });
    await writeFile(path.join(home[runtime], config), lookalike);
    const result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: `registration:${runtime}`, evidence: { state: "missing", cause: null } }));
    expect((await inspectInstalledAssets(result)).status).toBe("degraded");
  });

  it("round-trips real Codex and Hermes adapters through canonical registration probes", async () => {
    const home = await homes();
    const adapterRoot = path.resolve(new URL("../../", import.meta.url).pathname);
    const options = { action: "install" as const, runtime: "all" as const, vault: "/vault", adapterRoot };
    await installCodex(options, hostSurfaceForRuntime("codex"));
    await installHermes(options, hostSurfaceForRuntime("hermes"));
    let result = await discoverHostInstallAssets();
    for (const runtime of ["codex", "hermes"] as const) {
      expect(result.assets).toContainEqual(expect.objectContaining({ id: `registration:${runtime}`, evidence: { state: "ok", cause: null } }));
    }

    const codex = path.join(home.codex, "config.toml");
    for (const mutation of [
      (raw: string) => raw.replace('command = "oms"', 'command = "other"'),
      (raw: string) => raw.replace('args = ["mcp", "--vault", "/vault"]', 'args = ["mcp", "--other", "/vault"]'),
      (raw: string) => raw.replace('OMS_AGENT_RUNTIME = "codex"', 'OMS_AGENT_RUNTIME = "other"'),
    ]) {
      await installCodex(options, hostSurfaceForRuntime("codex"));
      await writeFile(codex, mutation(await readFile(codex, "utf8")));
      result = await discoverHostInstallAssets();
      expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:codex", evidence: { state: "missing", cause: null } }));
    }
    await installCodex(options, hostSurfaceForRuntime("codex"));
    await writeFile(codex, (await readFile(codex, "utf8")).replace('command = "oms"', 'command = "oms"\ncommand = "other"'));
    result = await discoverHostInstallAssets();
    expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:codex", evidence: { state: "missing", cause: null } }));

    const hermes = path.join(home.hermes, "config.yaml");
    for (const mutation of [
      (raw: string) => raw.replace("command: oms", "command: other"),
      (raw: string) => raw.replace("--vault", "--other"),
      (raw: string) => raw.replace("enabled: true", "enabled: false"),
    ]) {
      await installHermes(options, hostSurfaceForRuntime("hermes"));
      await writeFile(hermes, mutation(await readFile(hermes, "utf8")));
      result = await discoverHostInstallAssets();
      expect(result.assets).toContainEqual(expect.objectContaining({ id: "registration:hermes", evidence: { state: "missing", cause: null } }));
    }
  });

  it("catches Hermes skill-tree and recorded-version drift on the default doctor path", async () => {
    const home = await homes();
    const skills = path.join(home.hermes, "skills", "knowledge-management", "oms");
    const provenance = path.join(home.hermes, "adapters", "oms", "oms-provenance.json");
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(skills, "SKILL.md"), "original");
    await mkdir(path.dirname(provenance), { recursive: true });
    const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    await writeFile(provenance, serializeProvenance({ schemaVersion: 1, source: "npm", version: metadata.version, skillTreeDigest: await computeTreeDigest(skills), installedAt: "2026-01-01T00:00:00.000Z" }));
    await writeFile(path.join(home.hermes, "config.yaml"), hermesConfig());
    await writeFile(path.join(skills, "SKILL.md"), "drifted");
    const discovered = await discoverHostInstallAssets();
    const inspected = await inspectInstalledAssets(discovered);
    expect(inspected.assets).toContainEqual(expect.objectContaining({ id: "hermes:0", kind: "skill-tree", state: "provenance-mismatch" }));
    await writeFile(provenance, serializeProvenance({ schemaVersion: 1, source: "npm", version: "0.0.0", skillTreeDigest: await computeTreeDigest(skills), installedAt: "2026-01-01T00:00:00.000Z" }));
    expect((await inspectInstalledAssets(await discoverHostInstallAssets())).assets).toContainEqual(expect.objectContaining({ id: "hermes:0", state: "provenance-mismatch" }));
  });
});
