import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
import { computeTreeDigest } from "../../kernel/install/provenance.js";
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

describe("Codex optional oms-reviewer role", () => {
  const sourcePath = path.resolve("assets/codex/agents/oms-reviewer.toml");
  const sourceDirectory = path.dirname(sourcePath);

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

  it("ships documented custom-agent keys without an MCP isolation claim", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('name = "oms-reviewer"');
    expect(source).toContain('description = "Independently review an OMS note against its approved semantic criteria without changing notes or contracts."');
    expect(source).toContain('sandbox_mode = "read-only"');
    expect(source).toContain("developer_instructions");
    expect(source).toContain("requestDigest");
    expect(source).toContain("`criteria`");
    expect(source).toContain("insufficient-evidence");
    expect(source).toContain("You do not create the host provenance envelope");
    expect(source).toContain("not cover inherited MCP access.");
    expect(source).not.toMatch(/^mcp_servers\s*=/m);
    expect(source).not.toContain("mcp_servers = {}");
    expect(source).not.toContain("tools: Read, Grep, Glob");
  });

  it("installs an owned role and leaves an unchanged second install in place", async () => {
    const home = await temporaryHome();
    const target = paths(home);
    const personal = path.join(target.agents, "personal.toml");
    await mkdir(target.agents, { recursive: true });
    await writeFile(personal, 'name = "personal"\n', "utf8");
    const source = await readFile(sourcePath, "utf8");
    const version = JSON.parse(await readFile(path.resolve("package.json"), "utf8")).version as string;

    await isolate(home, async () => {
      const installed = await installCodex(operation(home, "install"), codexHost());
      expect(installed.paths).toContain(target.role);
      expect(installed.messages.join("\n")).toContain("generic separate subagent remains valid");
      expect(installed.messages.join("\n")).not.toMatch(/mcp_servers\s*=/);
      expect(await readFile(target.role, "utf8")).toBe(source);
      const provenance = JSON.parse(await readFile(target.provenance, "utf8")) as {
        schemaVersion: number;
        source: string;
        version: string;
        skillTreeDigest: string;
      };
      expect(provenance).toMatchObject({
        schemaVersion: 1,
        source: "npm",
        version,
        skillTreeDigest: await computeTreeDigest(sourceDirectory),
      });
      const recorded = await readFile(target.provenance, "utf8");
      await installCodex(operation(home, "install"), codexHost());
      expect(await readFile(target.provenance, "utf8")).toBe(recorded);
      expect(await readFile(target.role, "utf8")).toBe(source);
    });
    expect(await readFile(personal, "utf8")).toBe('name = "personal"\n');
  });

  it("adopts an exact unrecorded copy and replaces drifted owned bytes", async () => {
    const home = await temporaryHome();
    const target = paths(home);
    const source = await readFile(sourcePath, "utf8");
    await mkdir(target.agents, { recursive: true });
    await writeFile(target.role, source, "utf8");

    await isolate(home, async () => {
      await installCodex(operation(home, "install"), codexHost());
      expect(await readFile(target.role, "utf8")).toBe(source);
      expect(JSON.parse(await readFile(target.provenance, "utf8")).skillTreeDigest).toBe(await computeTreeDigest(sourceDirectory));
      await writeFile(target.role, 'name = "drifted"\n', "utf8");
      await installCodex(operation(home, "install"), codexHost());
      expect(await readFile(target.role, "utf8")).toBe(source);
    });
  });

  it("refuses unowned files, symlinks, and non-files before any other install write", async () => {
    const home = await temporaryHome();
    const target = paths(home);
    const foreign = 'name = "local-reviewer"\n';
    await mkdir(target.agents, { recursive: true });
    await writeFile(target.role, foreign, "utf8");
    await isolate(home, async () => {
      await expect(installCodex(operation(home, "install"), codexHost())).rejects.toThrow(/Refusing to replace unowned Codex custom agent/);
      await expect(installCodex(operation(home, "install", { dryRun: true }), codexHost())).rejects.toThrow(/Refusing to replace unowned Codex custom agent/);
    });
    expect(await readFile(target.role, "utf8")).toBe(foreign);
    expect(existsSync(target.config)).toBe(false);
    expect(existsSync(target.provenance)).toBe(false);
    expect(existsSync(target.rule)).toBe(false);

    const linked = await temporaryHome();
    const linkTarget = paths(linked);
    const outside = path.join(linked, "outside.toml");
    await writeFile(outside, "external\n", "utf8");
    await mkdir(linkTarget.agents, { recursive: true });
    await symlink(outside, linkTarget.role);
    await isolate(linked, async () => {
      await expect(installCodex(operation(linked, "install"), codexHost())).rejects.toThrow(/Refusing to replace symlinked/);
    });
    expect(await readFile(outside, "utf8")).toBe("external\n");
    expect(existsSync(linkTarget.config)).toBe(false);

    const linkedDir = await temporaryHome();
    const dirPaths = paths(linkedDir);
    const realAgents = path.join(linkedDir, "real-agents");
    await mkdir(realAgents, { recursive: true });
    await writeFile(path.join(realAgents, "personal.toml"), "keep\n", "utf8");
    await mkdir(path.dirname(dirPaths.agents), { recursive: true });
    await symlink(realAgents, dirPaths.agents);
    await isolate(linkedDir, async () => {
      await expect(installCodex(operation(linkedDir, "install"), codexHost())).rejects.toThrow(/Refusing to replace symlinked/);
    });
    expect(await readFile(path.join(realAgents, "personal.toml"), "utf8")).toBe("keep\n");
    expect(existsSync(path.join(realAgents, "oms-reviewer.toml"))).toBe(false);
    expect(existsSync(dirPaths.config)).toBe(false);

    const directory = await temporaryHome();
    const directoryPaths = paths(directory);
    await mkdir(directoryPaths.role, { recursive: true });
    await writeFile(path.join(directoryPaths.role, "keep.txt"), "keep\n", "utf8");
    await isolate(directory, async () => {
      await expect(installCodex(operation(directory, "install"), codexHost())).rejects.toThrow(/not a regular file/);
    });
    expect(await readFile(path.join(directoryPaths.role, "keep.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(directoryPaths.config)).toBe(false);
  });

  it("refuses invalid and newer provenance without rewriting config", async () => {
    const invalidHome = await temporaryHome();
    const invalid = paths(invalidHome);
    const source = await readFile(sourcePath, "utf8");
    await mkdir(invalid.agents, { recursive: true });
    await writeFile(invalid.role, source, "utf8");
    await writeFile(invalid.provenance, "{}\n", "utf8");
    await isolate(invalidHome, async () => {
      await expect(installCodex(operation(invalidHome, "install"), codexHost())).rejects.toThrow(/not valid npm provenance/);
    });
    expect(await readFile(invalid.role, "utf8")).toBe(source);
    expect(existsSync(invalid.config)).toBe(false);

    const newerHome = await temporaryHome();
    const newer = paths(newerHome);
    await isolate(newerHome, async () => {
      await installCodex(operation(newerHome, "install"), codexHost());
      const config = await readFile(newer.config, "utf8");
      const role = await readFile(newer.role, "utf8");
      const provenance = JSON.parse(await readFile(newer.provenance, "utf8")) as { version: string };
      provenance.version = "99.0.0";
      await writeFile(newer.provenance, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
      await expect(installCodex(operation(newerHome, "install", { vault: "/other" }), codexHost())).rejects.toThrow(/newer than this package/);
      expect(await readFile(newer.config, "utf8")).toBe(config);
      expect(await readFile(newer.role, "utf8")).toBe(role);
    });
  });

  it("dry-run reports the role path and eight registry skills without creating the Codex home", async () => {
    const home = await temporaryHome();
    const host = codexHost();
    const skills = [
      "distill",
      "doctor",
      "interview",
      "link",
      "search",
      "status",
      "template",
      "write",
    ].map(skill => path.join(home, ".codex", "skills", `oms-${skill}`));
    await isolate(home, async () => {
      const result = await installCodex(operation(home, "install", { dryRun: true }), host);
      expect(result.changed).toBe(false);
      expect(host.skillDirs).toEqual(["distill", "doctor", "interview", "link", "search", "status", "template", "write"]);
      expect(result.paths.filter(candidate => candidate.includes(`${path.sep}skills${path.sep}`))).toEqual(skills);
      expect(result.paths.some(candidate => candidate.endsWith(`${path.sep}oms-setup`))).toBe(false);
      expect(result.paths).toContain(paths(home).role);
      expect(result.paths).toContain(paths(home).provenance);
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

    const copied = await temporaryHome();
    const copiedPaths = paths(copied);
    await mkdir(copiedPaths.agents, { recursive: true });
    await writeFile(copiedPaths.role, await readFile(sourcePath, "utf8"), "utf8");
    await isolate(copied, async () => {
      const removed = await uninstallCodex(operation(copied, "uninstall"));
      expect(removed.changed).toBe(true);
      expect(existsSync(copiedPaths.role)).toBe(false);
    });

    const orphan = await temporaryHome();
    const orphanPaths = paths(orphan);
    await isolate(orphan, async () => {
      await installCodex(operation(orphan, "install"), codexHost());
      await rm(orphanPaths.role);
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
      await writeFile(target.role, foreign, "utf8");
      await rm(target.provenance);
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
