import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runHostOperation,
  formatHostOperationResults,
  formatHostOperationResultsJson,
  upsertClaudeHooks,
  removeClaudeHooks,
  toShellVaultPath,
  buildGuardCommandString,
  isOmsHookEntry,
} from "./hosts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const adapterRoot = path.join(repoRoot, "adapters");

describe("host installer/uninstaller", () => {
  it("installs and uninstalls Codex managed MCP config without removing unrelated sections", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-codex-"));
    const codexDir = path.join(home, ".codex");
    await writeFile(path.join(codexDir, "config.toml"), 'model = "gpt-5"\n\n[other]\nfoo = 1\n', { encoding: "utf-8" }).catch(async () => {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(codexDir, { recursive: true }));
      await writeFile(path.join(codexDir, "config.toml"), 'model = "gpt-5"\n\n[other]\nfoo = 1\n', "utf-8");
    });

    await runHostOperation({ action: "install", runtime: "codex", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const installed = await readFile(path.join(codexDir, "config.toml"), "utf-8");
    expect(installed).toContain("# BEGIN OMS MANAGED MCP");
    expect(installed).toContain("[mcp_servers.oms]");
    expect(installed).toContain('command = "oms"');
    expect(installed).toContain('args = ["mcp", "--vault", "/tmp/Vault"]');
    expect(installed).toContain("[other]");
    expect(existsSync(path.join(codexDir, "plugins", "oms", "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(codexDir, "rules", "oms.md"))).toBe(true);
    expect(existsSync(path.join(codexDir, "skills", "oms-write", "SKILL.md"))).toBe(true);

    await runHostOperation({ action: "uninstall", runtime: "codex", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const uninstalled = await readFile(path.join(codexDir, "config.toml"), "utf-8");
    expect(uninstalled).not.toContain("mcp_servers.oms");
    expect(uninstalled).toContain("[other]");
    expect(existsSync(path.join(codexDir, "plugins", "oms"))).toBe(false);
    expect(existsSync(path.join(codexDir, "rules", "oms.md"))).toBe(false);
    expect(existsSync(path.join(codexDir, "skills", "oms-write"))).toBe(false);
  });

  it("removes only stale Codex OMS skill directories during install", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-codex-stale-"));
    const codexSkillsDir = path.join(home, ".codex", "skills");
    await mkdir(path.join(codexSkillsDir, "oms-old-skill"), { recursive: true });
    await mkdir(path.join(codexSkillsDir, "personal-skill"), { recursive: true });

    await runHostOperation({ action: "install", runtime: "codex", vault: "/tmp/Vault", homeDir: home, adapterRoot });

    expect(existsSync(path.join(codexSkillsDir, "oms-old-skill"))).toBe(false);
    expect(existsSync(path.join(codexSkillsDir, "personal-skill"))).toBe(true);
  });

  it("installs the plugin-owned Claude MCP surface when executing external install", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-external-"));
    const binDir = path.join(home, "bin");
    const argvLog = path.join(home, "claude-argv.log");
    const claudePath = path.join(binDir, "claude");
    const originalPath = process.env.PATH;
    const originalArgvLog = process.env.CLAUDE_ARGV_LOG;
    await mkdir(binDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        "#!/bin/sh",
        "printf 'claude' >> \"$CLAUDE_ARGV_LOG\"",
        "for arg in \"$@\"; do",
        "  printf ' %s' \"$arg\" >> \"$CLAUDE_ARGV_LOG\"",
        "done",
        "printf '\\n' >> \"$CLAUDE_ARGV_LOG\"",
      ].join("\n"),
      "utf-8",
    );
    await chmod(claudePath, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CLAUDE_ARGV_LOG = argvLog;

    try {
      await runHostOperation({
        action: "install",
        runtime: "claude",
        vault: "/tmp/Vault",
        homeDir: home,
        adapterRoot,
        executeExternal: true,
      });

      const executedCommands = (await readFile(argvLog, "utf-8")).trim().split("\n");
      expect(executedCommands).toContain("claude mcp remove oms --scope local");
      expect(executedCommands).toContain("claude mcp remove oms --scope project");
      expect(executedCommands).toContain("claude mcp remove oms --scope user");
      expect(executedCommands.some((command) => command.startsWith("claude plugin install "))).toBe(true);
      expect(executedCommands.every((command) => !command.includes("mcp add oms"))).toBe(true);
      const pluginManifest = await readFile(path.join(adapterRoot, "claude-code", ".claude-plugin", "plugin.json"), "utf-8");
      const pluginMcp = await readFile(path.join(adapterRoot, "claude-code", ".mcp.json"), "utf-8");
      expect(pluginManifest).toContain('"mcpServers": "./.mcp.json"');
      expect(pluginMcp).toContain('"oms"');
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalArgvLog === undefined) {
        delete process.env.CLAUDE_ARGV_LOG;
      } else {
        process.env.CLAUDE_ARGV_LOG = originalArgvLog;
      }
    }
  });

  it("installs through the marketplace flow when the Claude CLI is present", async () => {
    // Given: a Claude CLI on PATH that records every argv it is invoked with
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-marketplace-"));
    const binDir = path.join(home, "bin");
    const argvLog = path.join(home, "claude-argv.log");
    const claudePath = path.join(binDir, "claude");
    const originalPath = process.env.PATH;
    const originalArgvLog = process.env.CLAUDE_ARGV_LOG;
    await mkdir(binDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        "#!/bin/sh",
        "printf 'claude' >> \"$CLAUDE_ARGV_LOG\"",
        "for arg in \"$@\"; do printf ' %s' \"$arg\" >> \"$CLAUDE_ARGV_LOG\"; done",
        "printf '\\n' >> \"$CLAUDE_ARGV_LOG\"",
        "exit 0",
      ].join("\n"),
      "utf-8",
    );
    await chmod(claudePath, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CLAUDE_ARGV_LOG = argvLog;

    try {
      // When: the Claude runtime is installed with external execution enabled
      const [result] = await runHostOperation({
        action: "install",
        runtime: "claude",
        vault: "/tmp/Vault",
        homeDir: home,
        adapterRoot,
        executeExternal: true,
      });

      // Then: the marketplace is added and the plugin is installed by marketplace id
      const executedCommands = (await readFile(argvLog, "utf-8")).trim().split("\n");
      const marketplaceAdd = executedCommands.find((command) => command.startsWith("claude plugin marketplace add "));
      expect(marketplaceAdd).toBeDefined();
      expect(executedCommands).toContain("claude plugin install oms@oms");
      // Then: the local-path install is not used while the marketplace flow succeeds
      expect(executedCommands.some((command) => /^claude plugin install [^o]/.test(command))).toBe(false);
      // Then: the reported command list matches what was executed
      expect(result?.commands).toContain("claude plugin install oms@oms");
      expect(result?.commands.some((command) => command.startsWith("claude plugin marketplace add "))).toBe(true);
      // Then: auto-update stays the user's decision, surfaced as guidance only
      expect(result?.messages.join(" ")).toContain("autoUpdate");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalArgvLog === undefined) delete process.env.CLAUDE_ARGV_LOG;
      else process.env.CLAUDE_ARGV_LOG = originalArgvLog;
    }
  });

  it("falls back to the local plugin path when the marketplace add fails", async () => {
    // Given: a Claude CLI whose marketplace add fails but whose plugin install succeeds
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-market-fail-"));
    const binDir = path.join(home, "bin");
    const argvLog = path.join(home, "claude-argv.log");
    const claudePath = path.join(binDir, "claude");
    const originalPath = process.env.PATH;
    const originalArgvLog = process.env.CLAUDE_ARGV_LOG;
    await mkdir(binDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        "#!/bin/sh",
        "printf 'claude' >> \"$CLAUDE_ARGV_LOG\"",
        "for arg in \"$@\"; do printf ' %s' \"$arg\" >> \"$CLAUDE_ARGV_LOG\"; done",
        "printf '\\n' >> \"$CLAUDE_ARGV_LOG\"",
        "if [ \"$2\" = \"marketplace\" ]; then",
        "  printf 'network unreachable\\n' >&2",
        "  exit 3",
        "fi",
        "exit 0",
      ].join("\n"),
      "utf-8",
    );
    await chmod(claudePath, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CLAUDE_ARGV_LOG = argvLog;

    try {
      // When: the Claude runtime is installed
      const [result] = await runHostOperation({
        action: "install",
        runtime: "claude",
        vault: "/tmp/Vault",
        homeDir: home,
        adapterRoot,
        executeExternal: true,
      });

      // Then: the offline local-path install runs instead, and no throw escapes
      const executedCommands = (await readFile(argvLog, "utf-8")).trim().split("\n");
      expect(executedCommands.some((command) => command.startsWith("claude plugin marketplace add "))).toBe(true);
      expect(executedCommands).not.toContain("claude plugin install oms@oms");
      expect(
        executedCommands.some(
          (command) => command.startsWith("claude plugin install ") && command.includes(path.join("claude-code")),
        ),
      ).toBe(true);
      expect(result?.messages.join(" ")).toContain("local plugin path");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalArgvLog === undefined) delete process.env.CLAUDE_ARGV_LOG;
      else process.env.CLAUDE_ARGV_LOG = originalArgvLog;
    }
  });

  it("leaves settings.json auto-update bytes untouched during a marketplace install", async () => {
    // Given: a settings.json carrying an unmanaged marketplace entry with autoUpdate off
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-autoupdate-"));
    const claudeDir = path.join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const original = [
      "{",
      '  "extraKnownMarketplaces": {',
      '    "other": { "source": { "source": "github", "repo": "someone/else" }, "autoUpdate": false }',
      "  },",
      '  "custom": "  unmanaged spacing  "',
      "}",
      "",
    ].join("\n");
    await writeFile(settingsPath, original, "utf-8");

    // When: the Claude runtime is installed
    await runHostOperation({
      action: "install",
      runtime: "claude",
      vault: path.join(home, "Vault"),
      homeDir: home,
      adapterRoot,
    });

    // Then: OMS never seeds itself into extraKnownMarketplaces nor flips autoUpdate
    const updated = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(updated) as {
      extraKnownMarketplaces: Record<string, { autoUpdate?: boolean }>;
      custom: string;
    };
    expect(Object.keys(parsed.extraKnownMarketplaces)).toEqual(["other"]);
    expect(parsed.extraKnownMarketplaces["other"]?.autoUpdate).toBe(false);
    // Then: the unmanaged bytes around the managed hooks edit survive verbatim
    expect(updated).toContain('  "custom": "  unmanaged spacing  "');
    expect(updated).toContain('"repo": "someone/else"');
  });

  it("continues plugin installation when one scoped cleanup fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-cleanup-failure-"));
    const binDir = path.join(home, "bin");
    const argvLog = path.join(home, "claude-argv.log");
    const claudePath = path.join(binDir, "claude");
    const originalPath = process.env.PATH;
    const originalArgvLog = process.env.CLAUDE_ARGV_LOG;
    await mkdir(binDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        "#!/bin/sh",
        "printf 'claude' >> \"$CLAUDE_ARGV_LOG\"",
        "for arg in \"$@\"; do printf ' %s' \"$arg\" >> \"$CLAUDE_ARGV_LOG\"; done",
        "printf '\\n' >> \"$CLAUDE_ARGV_LOG\"",
        "if [ \"$1\" = \"mcp\" ] && [ \"$5\" = \"project\" ]; then",
        "  printf 'permission denied\\n' >&2",
        "  exit 7",
        "fi",
        "if [ \"$1\" = \"mcp\" ] && [ \"$5\" = \"user\" ]; then",
        "  printf 'No local mcp server found with name: oms\\n' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      "utf-8",
    );
    await chmod(claudePath, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CLAUDE_ARGV_LOG = argvLog;

    try {
      const [result] = await runHostOperation({
        action: "install",
        runtime: "claude",
        vault: "/tmp/Vault",
        homeDir: home,
        adapterRoot,
        executeExternal: true,
      });

      expect(result.cleanup).toEqual([
        expect.objectContaining({ scope: "local", status: "removed" }),
        expect.objectContaining({ scope: "project", status: "failed", reasonCode: "legacy_cleanup_failed" }),
        expect.objectContaining({ scope: "user", status: "failed", reasonCode: "legacy_cleanup_failed" }),
      ]);
      expect(result.messages.some((message) => message.includes("Install continued"))).toBe(true);
      expect((await readFile(argvLog, "utf-8"))).toContain("claude plugin install");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalArgvLog === undefined) delete process.env.CLAUDE_ARGV_LOG;
      else process.env.CLAUDE_ARGV_LOG = originalArgvLog;
    }
  });

  it("dry-run lists all scoped Claude cleanup attempts without mutating", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-cleanup-dry-"));
    const [result] = await runHostOperation({
      action: "install",
      runtime: "claude",
      vault: "/tmp/Vault",
      homeDir: home,
      adapterRoot,
      dryRun: true,
      executeExternal: true,
    });

    expect(result.messages).toEqual(expect.arrayContaining([
      expect.stringContaining("claude mcp remove oms --scope local"),
      expect.stringContaining("claude mcp remove oms --scope project"),
      expect.stringContaining("claude mcp remove oms --scope user"),
    ]));
    expect(existsSync(path.join(home, ".claude", "mcp.json"))).toBe(false);
  });

  it("reports manual plugin activation when Claude CLI is unavailable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-no-cli-"));
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(home, "missing-bin");
    try {
      const [result] = await runHostOperation({
        action: "install",
        runtime: "claude",
        vault: "/tmp/Vault",
        homeDir: home,
        adapterRoot,
        executeExternal: true,
      });

      expect(result.cleanup).toEqual([
        expect.objectContaining({ scope: "local", status: "failed", reasonCode: "claude_cli_unavailable" }),
        expect.objectContaining({ scope: "project", status: "failed", reasonCode: "claude_cli_unavailable" }),
        expect.objectContaining({ scope: "user", status: "failed", reasonCode: "claude_cli_unavailable" }),
      ]);
      expect(result.messages.join(" ")).toContain("no plugin or MCP activation was performed");
      expect(result.messages.join(" ")).not.toContain("wrote MCP config");
      expect(existsSync(path.join(home, ".claude", "mcp.json"))).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("removes a stale direct Claude MCP entry without rewriting unrelated config bytes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-mcp-migrate-"));
    const claudeDir = path.join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const original = '{"custom":"  unmanaged spacing  ","mcpServers":{"oms":{"command":"oms"},"other":{"command":"keep"}}}';
    const mcpPath = path.join(claudeDir, "mcp.json");
    await writeFile(mcpPath, original, "utf-8");

    await runHostOperation({
      action: "install",
      runtime: "claude",
      vault: "/tmp/Vault",
      homeDir: home,
      adapterRoot,
    });
    const updated = await readFile(mcpPath, "utf-8");
    expect(updated).not.toContain('"oms":');
    const parsed = JSON.parse(updated) as { mcpServers: { other: { command: string } }; custom: string };
    expect(parsed.mcpServers.other.command).toBe("keep");
    expect(parsed.custom).toBe("  unmanaged spacing  ");
  });

  it("installs and uninstalls Hermes native skill bundle and MCP config", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-hermes-"));
    await runHostOperation({ action: "install", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const config = await readFile(path.join(home, ".hermes", "config.yaml"), "utf-8");
    expect(config).toContain("oms:");
    expect(config).toContain("command: oms");
    expect(existsSync(path.join(home, ".hermes", "skills", "knowledge-management", "oms", "write", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".hermes", "adapters", "oms", "SOUL.md"))).toBe(true);

    await runHostOperation({ action: "uninstall", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const after = await readFile(path.join(home, ".hermes", "config.yaml"), "utf-8");
    expect(after).not.toContain("oms:");
    expect(existsSync(path.join(home, ".hermes", "skills", "knowledge-management", "oms"))).toBe(false);
    expect(existsSync(path.join(home, ".hermes", "adapters", "oms"))).toBe(false);
  });

  it("keeps other runtimes installing when one runtime throws", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-isolation-"));
    const decoy = await mkdtemp(path.join(tmpdir(), "oms-install-isolation-decoy-"));
    const hermesSkillTarget = path.join(home, ".hermes", "skills", "knowledge-management", "oms");
    await mkdir(path.dirname(hermesSkillTarget), { recursive: true });
    await symlink(decoy, hermesSkillTarget, "dir");

    const results = await runHostOperation({ action: "install", runtime: "all", vault: "/tmp/Vault", homeDir: home, adapterRoot });

    expect(results.map((result) => result.runtime)).toEqual(["claude", "codex", "hermes"]);
    const hermes = results.find((result) => result.runtime === "hermes");
    expect(hermes?.changed).toBe(false);
    expect(hermes?.messages.join(" ")).toContain("Refusing to replace symlinked");
    expect(results.find((result) => result.runtime === "codex")?.changed).toBe(true);
    expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
  });

  it("preserves unrelated comments in the Hermes config during install and uninstall", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-hermes-comments-"));
    const configPath = path.join(home, ".hermes", "config.yaml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      ["# user top-level comment", "model: hermes-4 # trailing note", "", "mcp_servers:", "  # keep this server", "  other:", "    command: other-bin", ""].join("\n"),
      "utf-8",
    );

    await runHostOperation({ action: "install", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const installed = await readFile(configPath, "utf-8");
    expect(installed).toContain("# user top-level comment");
    expect(installed).toContain("model: hermes-4 # trailing note");
    expect(installed).toContain("# keep this server");
    expect(installed).toContain("oms:");

    await runHostOperation({ action: "uninstall", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const uninstalled = await readFile(configPath, "utf-8");
    expect(uninstalled).toContain("# user top-level comment");
    expect(uninstalled).toContain("# keep this server");
    expect(uninstalled).toContain("command: other-bin");
    expect(uninstalled).not.toContain("oms:");
  });

  it("reports an unusable Hermes config instead of overwriting it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-hermes-invalid-"));
    const configPath = path.join(home, ".hermes", "config.yaml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "- not\n- a mapping\n", "utf-8");

    const [result] = await runHostOperation({ action: "install", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });

    expect(result?.messages.join(" ")).toContain("not a supported YAML mapping");
    expect(await readFile(configPath, "utf-8")).toBe("- not\n- a mapping\n");
  });

  it("dry-run reports all host plans without mutating home", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-dry-"));
    const results = await runHostOperation({ action: "install", runtime: "all", vault: "/tmp/Vault", homeDir: home, adapterRoot, dryRun: true });
    expect(results.map((result) => result.runtime)).toEqual(["claude", "codex", "hermes"]);
    expect(formatHostOperationResults(results, true)).toContain("dry-run");
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
    expect(existsSync(path.join(home, ".hermes"))).toBe(false);
  });

  it("renders cleanup outcomes as stable JSON", async () => {
    const results = await runHostOperation({
      action: "install",
      runtime: "claude",
      vault: "/tmp/Vault",
      homeDir: await mkdtemp(path.join(tmpdir(), "oms-install-json-")),
      adapterRoot,
      dryRun: true,
    });
    const parsed = JSON.parse(formatHostOperationResultsJson(results, true)) as {
      dryRun: boolean;
      results: Array<{ cleanup: unknown[]; messages: string[] }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.results[0]?.cleanup).toEqual([]);
    expect(parsed.results[0]?.messages.join(" ")).toContain("scope local");
  });
});

describe("Claude Code hook wiring helpers", () => {
  it("toShellVaultPath returns $HOME-relative path when under homeDir", () => {
    const homeDir = "/Users/testuser";
    const absPath = "/Users/testuser/Documents/Vault";
    expect(toShellVaultPath(absPath, homeDir)).toBe('"$HOME/Documents/Vault"');
  });

  it("toShellVaultPath falls back to absolute when not under homeDir", () => {
    const homeDir = "/Users/testuser";
    const absPath = "/opt/vaults/MyVault";
    expect(toShellVaultPath(absPath, homeDir)).toBe('"/opt/vaults/MyVault"');
  });

  it("buildGuardCommandString includes OMS_VAULT and guard bin", () => {
    const cmd = buildGuardCommandString("/Users/testuser/Vault", undefined, "/Users/testuser", "oms-guard");
    expect(cmd).toContain("OMS_VAULT=");
    expect(cmd).toContain("oms-guard");
    expect(cmd).not.toContain("OMS_AGENT_VAULT");
  });

  it("buildGuardCommandString includes OMS_AGENT_VAULT when agentVault provided", () => {
    const cmd = buildGuardCommandString("/Users/testuser/Vault", "/Users/testuser/RawVault", "/Users/testuser", "oms-guard");
    expect(cmd).toContain("OMS_AGENT_VAULT=");
  });

  it("isOmsHookEntry detects marker in hook command", () => {
    const entry = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="$HOME/V" oms-guard' }] };
    expect(isOmsHookEntry(entry, "oms-guard")).toBe(true);
    expect(isOmsHookEntry(entry, "oms-post-guard")).toBe(false);
  });

  it("does not claim a user hook with a suffix after the quoted assignment", () => {
    const entry = {
      matcher: ".*",
      hooks: [{ type: "command", command: 'OMS_VAULT="/x"suffix oms-guard' }],
    };
    expect(isOmsHookEntry(entry, "oms-guard")).toBe(false);
  });

  it("does not claim escaped-quote assignments", () => {
    const entry = {
      matcher: ".*",
      hooks: [{ type: "command", command: 'OMS_VAULT="/x\\q" oms-guard' }],
    };
    expect(isOmsHookEntry(entry, "oms-guard")).toBe(false);
  });

  it("does not claim a matching command under a different hook shape", () => {
    const wrongMatcher = { matcher: ".*", hooks: [{ type: "command", command: 'OMS_VAULT="/x" oms-guard' }] };
    const multipleHooks = {
      matcher: "Write|Edit|NotebookEdit",
      hooks: [
        { type: "command", command: 'OMS_VAULT="/x" oms-guard' },
        { type: "command", command: "other-hook" },
      ],
    };
    const wrongType = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "prompt", command: 'OMS_VAULT="/x" oms-guard' }] };
    const extraField = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="/x" oms-guard', owner: "user" }] };
    const embeddedHome = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="prefix$HOME/foo" oms-guard' }] };
    const emptyAssignment = { matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="" oms-guard' }] };
    expect(isOmsHookEntry(wrongMatcher, "oms-guard")).toBe(false);
    expect(isOmsHookEntry(multipleHooks, "oms-guard")).toBe(false);
    expect(isOmsHookEntry(wrongType, "oms-guard")).toBe(false);
    expect(isOmsHookEntry(extraField, "oms-guard")).toBe(false);
    expect(isOmsHookEntry(embeddedHome, "oms-guard")).toBe(false);
    expect(isOmsHookEntry(emptyAssignment, "oms-guard")).toBe(false);
  });
});

describe("upsertClaudeHooks / removeClaudeHooks", () => {
  async function makeClaudeDir(suffix: string): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), `oms-hooks-${suffix}-`));
    const claudeDir = path.join(home, ".claude");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    return claudeDir;
  }

  it("writes PreToolUse and PostToolUse entries into missing settings.json", async () => {
    const claudeDir = await makeClaudeDir("write");
    const home = path.dirname(claudeDir);
    const result = await upsertClaudeHooks({ vault: path.join(home, "Vault"), homeDir: home }, claudeDir);
    expect(result.changed).toBe(true);
    const raw = await readFile(path.join(claudeDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hooks = parsed["hooks"] as Record<string, unknown>;
    expect(Array.isArray(hooks["PreToolUse"])).toBe(true);
    expect(Array.isArray(hooks["PostToolUse"])).toBe(true);
  });

  it("is idempotent: running twice does not duplicate entries", async () => {
    const claudeDir = await makeClaudeDir("idem");
    const home = path.dirname(claudeDir);
    await upsertClaudeHooks({ vault: path.join(home, "Vault"), homeDir: home }, claudeDir);
    const result2 = await upsertClaudeHooks({ vault: path.join(home, "Vault"), homeDir: home }, claudeDir);
    expect(result2.changed).toBe(false);
    const raw = await readFile(path.join(claudeDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hooks = parsed["hooks"] as Record<string, unknown>;
    expect((hooks["PreToolUse"] as unknown[]).length).toBe(1);
    expect((hooks["PostToolUse"] as unknown[]).length).toBe(1);
  });

  it("preserves existing non-OMS hook entries", async () => {
    const claudeDir = await makeClaudeDir("preserve");
    const home = path.dirname(claudeDir);
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "other-tool" }] }],
      },
    };
    await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2), "utf-8");
    await upsertClaudeHooks({ vault: path.join(home, "Vault"), homeDir: home }, claudeDir);
    const raw = await readFile(path.join(claudeDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hooks = parsed["hooks"] as Record<string, unknown>;
    const preArr = hooks["PreToolUse"] as unknown[];
    expect(preArr.length).toBe(2);
    expect(JSON.stringify(preArr)).toContain("other-tool");
  });

  it("preserves unmanaged root JSON bytes while splicing hooks", async () => {
    const claudeDir = await makeClaudeDir("bytes");
    const home = path.dirname(claudeDir);
    const original = [
      "{",
      '  "permissions": { "allow": ["keep-exactly"] },',
      '  "hooks": { "PreToolUse": [] },',
      '  "custom": "  unmanaged spacing  "',
      "}",
      "",
    ].join("\n");
    const settingsPath = path.join(claudeDir, "settings.json");
    await writeFile(settingsPath, original, "utf-8");

    await upsertClaudeHooks({ vault: path.join(home, "Vault"), homeDir: home }, claudeDir);
    const updated = await readFile(settingsPath, "utf-8");

    expect(updated).toContain('  "permissions": { "allow": ["keep-exactly"] },');
    expect(updated).toContain('  "custom": "  unmanaged spacing  "');
  });

  it("removeClaudeHooks removes only OMS entries, leaves others intact", async () => {
    const claudeDir = await makeClaudeDir("remove");
    const home = path.dirname(claudeDir);
    const vaultPath = path.join(home, "Vault");
    await upsertClaudeHooks({ vault: vaultPath, homeDir: home }, claudeDir);
    const raw = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const hooks = raw["hooks"] as Record<string, unknown>;
    (hooks["PreToolUse"] as unknown[]).unshift({ matcher: ".*", hooks: [{ type: "command", command: "keep-me" }] });
    await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(raw, null, 2), "utf-8");

    const result = await removeClaudeHooks({ homeDir: home }, claudeDir);
    expect(result.changed).toBe(true);
    const after = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const afterHooks = after["hooks"] as Record<string, unknown>;
    const preArr = afterHooks["PreToolUse"] as unknown[];
    expect(JSON.stringify(preArr)).toContain("keep-me");
    expect(JSON.stringify(preArr)).not.toContain("oms-guard");
  });

  it("corrupt settings.json is left untouched and returns changed=false", async () => {
    const claudeDir = await makeClaudeDir("corrupt");
    const settingsPath = path.join(claudeDir, "settings.json");
    await writeFile(settingsPath, "{ this is not valid json", "utf-8");
    const result = await upsertClaudeHooks({ vault: "/tmp/Vault" }, claudeDir);
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toContain("WARNING");
    const raw = await readFile(settingsPath, "utf-8");
    expect(raw).toBe("{ this is not valid json");
  });

  it("does not overwrite valid non-object settings.json", async () => {
    const claudeDir = await makeClaudeDir("non-object");
    const settingsPath = path.join(claudeDir, "settings.json");
    await writeFile(settingsPath, "[]\n", "utf-8");
    const result = await upsertClaudeHooks({ vault: "/tmp/Vault" }, claudeDir);
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toContain("supported JSON object");
    expect(await readFile(settingsPath, "utf-8")).toBe("[]\n");
  });

  it("does not overwrite unsupported hook metadata", async () => {
    const claudeDir = await makeClaudeDir("metadata");
    const settingsPath = path.join(claudeDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ hooks: { metadata: "keep" } }, null, 2), "utf-8");
    const result = await upsertClaudeHooks({ vault: "/tmp/Vault" }, claudeDir);
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toContain("unsupported hook metadata");
    expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual({ hooks: { metadata: "keep" } });
  });

  it("keeps compact settings JSON valid during hook removal", async () => {
    const claudeDir = await makeClaudeDir("compact");
    const settingsPath = path.join(claudeDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: 1,
        hooks: {
          PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [{ type: "command", command: 'OMS_VAULT="/x" oms-guard' }] }],
        },
      }),
      "utf-8",
    );

    const result = await removeClaudeHooks({}, claudeDir);
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks?: unknown; permissions: number };
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.permissions).toBe(1);
  });

  it("keeps generated quoted vault paths idempotent", async () => {
    const claudeDir = await makeClaudeDir("quoted-vault");
    const home = path.dirname(claudeDir);
    const options = { vault: path.join(home, 'Vault"Quote'), homeDir: home };
    await upsertClaudeHooks(options, claudeDir);
    await upsertClaudeHooks(options, claudeDir);
    const installed = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as {
      hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] };
    };
    expect(installed.hooks.PreToolUse).toHaveLength(1);
    expect(installed.hooks.PostToolUse).toHaveLength(1);

    await removeClaudeHooks({}, claudeDir);
    const removed = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as { hooks?: unknown };
    expect(removed.hooks).toBeUndefined();
  });

  it("reports malformed direct MCP config without mutating it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-claude-mcp-invalid-"));
    const claudeDir = path.join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const mcpPath = path.join(claudeDir, "mcp.json");
    await writeFile(mcpPath, "[]\n", "utf-8");

    const [result] = await runHostOperation({
      action: "install",
      runtime: "claude",
      vault: "/tmp/Vault",
      homeDir: home,
      adapterRoot,
    });
    expect(result.messages.join(" ")).toContain("not a JSON object");
    expect(await readFile(mcpPath, "utf-8")).toBe("[]\n");
  });

  it("install+uninstall Claude runtime writes and then removes hooks from settings.json", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hooks-cycle-"));
    await runHostOperation({ action: "install", runtime: "claude", vault: path.join(home, "Vault"), homeDir: home, adapterRoot });
    const claudeDir = path.join(home, ".claude");
    const afterInstall = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const hooksAfterInstall = afterInstall["hooks"] as Record<string, unknown>;
    expect(JSON.stringify(hooksAfterInstall["PreToolUse"])).toContain("oms-guard");
    expect(JSON.stringify(hooksAfterInstall["PostToolUse"])).toContain("oms-post-guard");

    await runHostOperation({ action: "uninstall", runtime: "claude", vault: path.join(home, "Vault"), homeDir: home, adapterRoot, yes: true });
    const afterUninstall = JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    expect(afterUninstall["hooks"]).toBeUndefined();
  });
});
