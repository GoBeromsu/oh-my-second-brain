import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
import { digestOneFile } from "../../kernel/install/provenance.js";
import { discoverHostInstallAssets } from "../../cli/host-probe.js";
import { installCodex, isCodexOmsRegistration, uninstallCodex } from "./codex.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "oms-codex-registration-"));
  temporaryDirectories.push(home);
  return home;
}

function codexHost() {
  const host = harnessSurfaceRegistry.hosts.find(candidate => candidate.runtime === "codex");
  if (host === undefined) throw new Error("Codex surface missing");
  return host;
}

describe("Codex managed OMS registration", () => {
  it("recognizes the adapter's freshly installed serve mcp registration", async () => {
    const home = await temporaryHome();
    await installCodex({
      action: "install",
      runtime: "codex",
      vault: "/vault",
      homeDir: home,
      adapterRoot: path.resolve("."),
    }, codexHost());

    const config = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain('args = ["serve", "mcp", "--vault", "/vault"]');
    expect(isCodexOmsRegistration(config)).toBe(true);
    const previous = process.env.OMS_CODEX_HOME;
    process.env.OMS_CODEX_HOME = path.join(home, ".codex");
    try {
      expect((await discoverHostInstallAssets()).assets).toContainEqual(expect.objectContaining({
        id: "registration:codex",
        evidence: { state: "ok", cause: null },
      }));
    } finally {
      if (previous === undefined) delete process.env.OMS_CODEX_HOME;
      else process.env.OMS_CODEX_HOME = previous;
    }
  });

  it("does not recognize retired or unrelated launch arguments", () => {
    const registration = (args: string) => [
      "# BEGIN OMS MANAGED MCP",
      "# OMS MCP hookup for Codex CLI. Managed by `oms host install/remove`.",
      "# Codex-native rules live in ~/.codex/rules/oms.md; skills live in ~/.codex/skills/oms-*.",
      "[mcp_servers.oms]",
      'command = "oms"',
      `args = ${args}`,
      "",
      "[mcp_servers.oms.env]",
      'OMS_AGENT_RUNTIME = "codex"',
      "# END OMS MANAGED MCP",
      "",
    ].join("\n");

    expect(isCodexOmsRegistration(registration('["mcp", "--vault", "/vault"]'))).toBe(false);
    expect(isCodexOmsRegistration(registration('["serve", "http", "--vault", "/vault"]'))).toBe(false);
  });

  it("preserves an unowned custom OMS table during removal", async () => {
    const home = await temporaryHome();
    const configPath = path.join(home, ".codex", "config.toml");
    const custom = '[mcp_servers.oms]\ncommand = "custom-runner"\nargs = ["keep"]\n';
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, custom, "utf8");

    await expect(uninstallCodex({
      action: "uninstall",
      runtime: "codex",
      vault: "/vault",
      homeDir: home,
    })).resolves.toMatchObject({ changed: false, skipped: true });
    expect(await readFile(configPath, "utf8")).toBe(custom);
  });
});

describe("Codex legacy oms-reviewer cleanup", () => {
  function paths(home: string) {
    const agents = path.join(home, ".codex", "agents");
    return {
      agents,
      role: path.join(agents, "oms-reviewer.toml"),
      provenance: path.join(agents, "oms-reviewer.provenance.json"),
      config: path.join(home, ".codex", "config.toml"),
      rule: path.join(home, ".codex", "rules", "oms.md"),
      skill: path.join(home, ".codex", "skills", "oms-write"),
    };
  }

  async function isolate<T>(home: string, body: () => Promise<T>): Promise<T> {
    const previous = process.env.OMS_CODEX_HOME;
    process.env.OMS_CODEX_HOME = path.join(home, ".codex");
    try {
      return await body();
    } finally {
      if (previous === undefined) delete process.env.OMS_CODEX_HOME;
      else process.env.OMS_CODEX_HOME = previous;
    }
  }

  function operation(home: string, action: "install" | "uninstall", extra: { readonly dryRun?: boolean; readonly vault?: string } = {}) {
    return {
      action,
      runtime: "codex" as const,
      vault: extra.vault ?? "/vault",
      homeDir: home,
      adapterRoot: path.resolve("."),
      ...(extra.dryRun === true ? { dryRun: true } : {}),
    };
  }

  async function writeOwnedProvenance(target: ReturnType<typeof paths>, role: string): Promise<void> {
    await mkdir(target.agents, { recursive: true });
    await writeFile(target.provenance, `${JSON.stringify({
      schemaVersion: 1,
      source: "npm",
      version: "0.16.0",
      skillTreeDigest: digestOneFile("oms-reviewer.toml", Buffer.from(role)),
      installedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");
  }

  it("installs native artifacts without a reviewer role", async () => {
    const home = await temporaryHome();
    const host = codexHost();
    const skills = [
      "distill",
      "doctor",
      "link",
      "search",
      "status",
      "write",
    ].map(skill => path.join(home, ".codex", "skills", `oms-${skill}`));
    await isolate(home, async () => {
      const result = await installCodex(operation(home, "install", { dryRun: true }), host);
      expect(result.changed).toBe(false);
      expect(host.skillDirs).toEqual(["distill", "doctor", "link", "search", "status", "write"]);
      expect(result.paths.filter(candidate => candidate.includes(`${path.sep}skills${path.sep}`))).toEqual(skills);
      expect(result.paths.some(candidate => candidate.endsWith(`${path.sep}oms-setup`))).toBe(false);
      expect(result.paths).not.toContain(paths(home).role);
      expect(result.paths).not.toContain(paths(home).provenance);
      expect(result.paths).toContain(path.join(home, ".codex", "rules", "oms.md"));
    });
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("uninstalls only an owned role and its provenance", async () => {
    const home = await temporaryHome();
    const target = paths(home);
    const personal = path.join(target.agents, "personal.toml");
    await isolate(home, async () => {
      await installCodex(operation(home, "install"), codexHost());
      const role = 'name = "oms-reviewer"\n';
      await writeOwnedProvenance(target, role);
      await writeFile(target.role, role, "utf8");
      await writeFile(personal, 'name = "personal"\n', "utf8");
      const removed = await uninstallCodex(operation(home, "uninstall"));
      expect(removed.changed).toBe(true);
      expect(removed.messages.join("\n")).toContain("Removed the owned oms-reviewer custom-agent role.");
      expect(removed.messages.join("\n")).toContain("Removed the owned oms-reviewer provenance record.");
      expect(existsSync(target.role)).toBe(false);
      expect(existsSync(target.provenance)).toBe(false);
      expect(existsSync(target.rule)).toBe(false);
      expect(existsSync(target.skill)).toBe(false);
    });
    expect(await readFile(personal, "utf8")).toBe('name = "personal"\n');

    const orphan = await temporaryHome();
    const orphanPaths = paths(orphan);
    await isolate(orphan, async () => {
      await writeOwnedProvenance(orphanPaths, 'name = "oms-reviewer"\n');
      const removed = await uninstallCodex(operation(orphan, "uninstall"));
      expect(removed.messages.join("\n")).toContain("Removed the owned oms-reviewer provenance record.");
      expect(existsSync(orphanPaths.provenance)).toBe(false);
    });
  });

  it("leaves an unowned role in place while removing other owned Codex assets", async () => {
    const home = await temporaryHome();
    const target = paths(home);
    const personal = path.join(target.agents, "personal.toml");
    const foreign = 'name = "foreign"\n';
    await isolate(home, async () => {
      await installCodex(operation(home, "install"), codexHost());
      // Install no longer creates the agents directory, so the foreign role has
      // to be planted the way a user's own Codex setup would.
      await mkdir(target.agents, { recursive: true });
      await writeFile(target.role, foreign, "utf8");
      await writeFile(personal, 'name = "personal"\n', "utf8");
      const removed = await uninstallCodex(operation(home, "uninstall"));
      expect(removed.changed).toBe(true);
      expect(removed.messages.join("\n")).toContain(`Left unowned Codex custom agent in place: ${target.role}`);
      expect(await readFile(target.config, "utf8")).not.toContain("mcp_servers.oms");
      expect(existsSync(target.rule)).toBe(false);
      expect(existsSync(target.skill)).toBe(false);
    });
    expect(await readFile(target.role, "utf8")).toBe(foreign);
    expect(await readFile(personal, "utf8")).toBe('name = "personal"\n');
    expect(existsSync(target.provenance)).toBe(false);

    const onlyForeign = await temporaryHome();
    const onlyPaths = paths(onlyForeign);
    await mkdir(onlyPaths.agents, { recursive: true });
    await writeFile(onlyPaths.role, foreign, "utf8");
    await isolate(onlyForeign, async () => {
      await expect(uninstallCodex(operation(onlyForeign, "uninstall"))).resolves.toMatchObject({ changed: false, skipped: true });
    });
    expect(await readFile(onlyPaths.role, "utf8")).toBe(foreign);
  });
});
