import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
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
