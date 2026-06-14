import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runHostOperation,
  formatHostOperationResults,
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
    expect(existsSync(path.join(codexDir, "skills", "oms-capture", "SKILL.md"))).toBe(true);

    await runHostOperation({ action: "uninstall", runtime: "codex", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const uninstalled = await readFile(path.join(codexDir, "config.toml"), "utf-8");
    expect(uninstalled).not.toContain("mcp_servers.oms");
    expect(uninstalled).toContain("[other]");
    expect(existsSync(path.join(codexDir, "plugins", "oms"))).toBe(false);
    expect(existsSync(path.join(codexDir, "rules", "oms.md"))).toBe(false);
    expect(existsSync(path.join(codexDir, "skills", "oms-capture"))).toBe(false);
  });

  it("installs and uninstalls Hermes native skill bundle and MCP config", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-hermes-"));
    await runHostOperation({ action: "install", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const config = await readFile(path.join(home, ".hermes", "config.yaml"), "utf-8");
    expect(config).toContain("oms:");
    expect(config).toContain("command: oms");
    expect(existsSync(path.join(home, ".hermes", "skills", "knowledge-management", "oms", "capture", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".hermes", "adapters", "oms", "SOUL.md"))).toBe(true);

    await runHostOperation({ action: "uninstall", runtime: "hermes", vault: "/tmp/Vault", homeDir: home, adapterRoot });
    const after = await readFile(path.join(home, ".hermes", "config.yaml"), "utf-8");
    expect(after).not.toContain("oms:");
    expect(existsSync(path.join(home, ".hermes", "skills", "knowledge-management", "oms"))).toBe(false);
    expect(existsSync(path.join(home, ".hermes", "adapters", "oms"))).toBe(false);
  });

  it("dry-run reports all host plans without mutating home", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-install-dry-"));
    const results = await runHostOperation({ action: "install", runtime: "all", vault: "/tmp/Vault", homeDir: home, adapterRoot, dryRun: true });
    expect(results.map((result) => result.runtime)).toEqual(["claude", "codex", "hermes"]);
    expect(formatHostOperationResults(results, true)).toContain("dry-run");
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
    expect(existsSync(path.join(home, ".hermes"))).toBe(false);
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
    const entry = { matcher: ".*", hooks: [{ type: "command", command: "OMS_VAULT=$HOME/V oms-guard" }] };
    expect(isOmsHookEntry(entry, "oms-guard")).toBe(true);
    expect(isOmsHookEntry(entry, "oms-post-guard")).toBe(false);
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

  it("removeClaudeHooks removes only OMS entries, leaves others intact", async () => {
    const claudeDir = await makeClaudeDir("remove");
    const home = path.dirname(claudeDir);
    const vaultPath = path.join(home, "Vault");
    await upsertClaudeHooks({ vault: vaultPath, homeDir: home }, claudeDir);
    // Add an unrelated hook to PreToolUse.
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
    // File must be unchanged.
    const raw = await readFile(settingsPath, "utf-8");
    expect(raw).toBe("{ this is not valid json");
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
