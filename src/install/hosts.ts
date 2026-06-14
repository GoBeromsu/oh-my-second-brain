import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

export type HostRuntime = "claude" | "codex" | "hermes";
export type RuntimeSelection = HostRuntime | "auto" | "all";
export type HostAction = "install" | "uninstall";

export interface HostOperationOptions {
  action: HostAction;
  runtime: RuntimeSelection;
  vault: string;
  /** Optional second vault path (e.g. agent/raw vault). Emitted as OMS_AGENT_VAULT. */
  agentVault?: string;
  packageSpec?: string;
  dryRun?: boolean;
  executeExternal?: boolean;
  yes?: boolean;
  homeDir?: string;
  adapterRoot: string;
}

export interface HostOperationResult {
  runtime: HostRuntime;
  action: HostAction;
  changed: boolean;
  skipped: boolean;
  paths: string[];
  commands: string[];
  messages: string[];
}

const HOSTS: HostRuntime[] = ["claude", "codex", "hermes"];
const MANAGED_CODEX_START = "# BEGIN OMS MANAGED MCP";
const MANAGED_CODEX_END = "# END OMS MANAGED MCP";
const CODEX_SKILL_PREFIX = "oms-";
const CODEX_RULE_FILENAME = "oms.md";
const HERMES_SKILL_CATEGORY = "knowledge-management";
const HERMES_SKILL_NAME = "oms";

function commandExists(command: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    stdio: "ignore",
    shell: process.platform !== "win32",
  });
  return result.status === 0;
}

export function detectAvailableHosts(): HostRuntime[] {
  const detected: HostRuntime[] = [];
  if (commandExists("claude")) detected.push("claude");
  if (commandExists("codex")) detected.push("codex");
  if (commandExists("hermes")) detected.push("hermes");
  return detected;
}

export function resolveRuntimeSelection(selection: RuntimeSelection): HostRuntime[] {
  if (selection === "all") return [...HOSTS];
  if (selection === "auto") {
    const detected = detectAvailableHosts();
    return detected.length > 0 ? detected : ["claude"];
  }
  return [selection];
}

function hostHome(homeDir: string | undefined, dirname: string, envName: string): string {
  return process.env[envName] ? path.resolve(process.env[envName]!) : path.join(homeDir ?? homedir(), dirname);
}

function mcpArgs(options: HostOperationOptions): string[] {
  return ["mcp", "--vault", options.vault];
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonObject(file: string, data: Record<string, unknown>, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return true;
}

async function readYamlObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = yamlParse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeYamlObject(file: string, data: Record<string, unknown>, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, yamlStringify(data), "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// Claude Code settings.json hook wiring
// ---------------------------------------------------------------------------

/** Sentinel strings that identify OMS-managed hook entries. */
const GUARD_MARKER = "oms-guard";
const POST_GUARD_MARKER = "oms-post-guard";
const HOOK_MATCHER = "Write|Edit|NotebookEdit";

/**
 * Convert an absolute vault path to a shell-safe `$HOME`-relative reference.
 * Returns `"$HOME/rel/path"` when the path is under homeDir, otherwise falls
 * back to a quoted absolute path.  The outer double-quotes let the shell expand
 * `$HOME` at hook execution time, so paths survive across reboots and username
 * changes.
 */
export function toShellVaultPath(absPath: string, homeDir: string): string {
  const rel = path.relative(homeDir, absPath);
  if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `"$HOME/${rel.replace(/\\/g, "/")}"`;
  }
  // Not under $HOME — use an absolute quoted path.
  return `"${absPath}"`;
}

/** Build the shell command string for a guard binary entry. */
export function buildGuardCommandString(
  vault: string,
  agentVault: string | undefined,
  homeDir: string,
  guardBin: string,
): string {
  const parts: string[] = [`OMS_VAULT=${toShellVaultPath(vault, homeDir)}`];
  if (agentVault) {
    parts.push(`OMS_AGENT_VAULT=${toShellVaultPath(agentVault, homeDir)}`);
  }
  parts.push(guardBin);
  return parts.join(" ");
}

/** Build a single `{matcher, hooks:[{type,command}]}` entry. */
function buildOmsHookEntry(matcher: string, command: string): Record<string, unknown> {
  return { matcher, hooks: [{ type: "command", command }] };
}

/** Return true when any inner `hooks[*].command` contains the given marker string. */
export function isOmsHookEntry(entry: unknown, marker: string): boolean {
  if (!isRecord(entry)) return false;
  const inner = entry["hooks"];
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h) => isRecord(h) && typeof h["command"] === "string" && (h["command"] as string).includes(marker),
  );
}

interface SettingsReadResult {
  /** Parsed settings object, or null when the file is corrupt. */
  data: Record<string, unknown> | null;
  /** True when the file existed but could not be parsed. */
  corrupt: boolean;
}

/**
 * Read `~/.claude/settings.json` carefully:
 * - Missing file → `{ data: {}, corrupt: false }`
 * - Valid JSON   → `{ data: parsed, corrupt: false }`
 * - Corrupt JSON → `{ data: null, corrupt: true }`  (caller must NOT write)
 */
async function readSettingsJsonSafe(settingsPath: string): Promise<SettingsReadResult> {
  try {
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return { data: isRecord(parsed) ? parsed : {}, corrupt: false };
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // File does not exist yet — safe to create.
      return { data: {}, corrupt: false };
    }
    // Parse error or other I/O error — do not touch the file.
    return { data: null, corrupt: true };
  }
}

/**
 * Idempotently merge OMS guard hooks into `~/.claude/settings.json`.
 * Existing non-OMS hook entries are never modified.
 * Returns a human-readable message and whether the file was changed.
 */
export async function upsertClaudeHooks(
  options: Pick<HostOperationOptions, "vault" | "agentVault" | "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const homeDir = options.homeDir ?? homedir();
  const { data, corrupt } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt) {
    const preCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, GUARD_MARKER);
    const postCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, POST_GUARD_MARKER);
    messages.push(
      `WARNING: ${settingsPath} is not valid JSON — hook wiring skipped to avoid data loss.`,
      `Manual step: add these entries to ${settingsPath}:`,
      `  hooks.PreToolUse:  {"matcher":"${HOOK_MATCHER}","hooks":[{"type":"command","command":"${preCmd}"}]}`,
      `  hooks.PostToolUse: {"matcher":"${HOOK_MATCHER}","hooks":[{"type":"command","command":"${postCmd}"}]}`,
    );
    return { changed: false, messages };
  }

  const settings = data!;
  const rawHooks = settings["hooks"];
  const hooks: Record<string, unknown[]> = isRecord(rawHooks)
    ? (rawHooks as Record<string, unknown[]>)
    : {};
  let changed = false;

  const preCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, GUARD_MARKER);
  const postCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, POST_GUARD_MARKER);

  // PreToolUse
  const preArr = Array.isArray(hooks["PreToolUse"]) ? [...(hooks["PreToolUse"] as unknown[])] : [];
  if (!preArr.some((e) => isOmsHookEntry(e, GUARD_MARKER))) {
    preArr.push(buildOmsHookEntry(HOOK_MATCHER, preCmd));
    hooks["PreToolUse"] = preArr;
    changed = true;
  }

  // PostToolUse
  const postArr = Array.isArray(hooks["PostToolUse"]) ? [...(hooks["PostToolUse"] as unknown[])] : [];
  if (!postArr.some((e) => isOmsHookEntry(e, POST_GUARD_MARKER))) {
    postArr.push(buildOmsHookEntry(HOOK_MATCHER, postCmd));
    hooks["PostToolUse"] = postArr;
    changed = true;
  }

  if (!changed) {
    messages.push("Claude Code hook entries already present (idempotent — nothing written).");
    return { changed: false, messages };
  }

  settings["hooks"] = hooks;
  if (!options.dryRun) {
    await writeJsonObject(settingsPath, settings, false);
  }
  messages.push(`Wired ${GUARD_MARKER}/${POST_GUARD_MARKER} into ${settingsPath}.`);
  return { changed: true, messages };
}

/**
 * Remove OMS guard hook entries from `~/.claude/settings.json`.
 * Only entries whose inner `command` contains `oms-guard` / `oms-post-guard`
 * are removed; all other entries are preserved unchanged.
 */
export async function removeClaudeHooks(
  options: Pick<HostOperationOptions, "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const { data, corrupt } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt) {
    messages.push(`WARNING: ${settingsPath} is not valid JSON — skipping hook removal.`);
    return { changed: false, messages };
  }

  const settings = data!;
  const rawHooks = settings["hooks"];
  if (!isRecord(rawHooks)) {
    return { changed: false, messages };
  }
  const hooks = rawHooks as Record<string, unknown>;
  let changed = false;

  for (const [eventName, marker] of [
    ["PreToolUse", GUARD_MARKER],
    ["PostToolUse", POST_GUARD_MARKER],
  ] as const) {
    const arr = hooks[eventName];
    if (!Array.isArray(arr)) continue;
    const filtered = (arr as unknown[]).filter((e) => !isOmsHookEntry(e, marker));
    if (filtered.length < arr.length) {
      hooks[eventName] = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, messages };
  }

  // Clean up empty hooks object.
  const remaining = Object.values(hooks).filter((v) => v !== undefined && Array.isArray(v) && (v as unknown[]).length > 0);
  if (remaining.length === 0) {
    delete settings["hooks"];
  } else {
    // Remove undefined-valued keys.
    for (const key of Object.keys(hooks)) {
      if (hooks[key] === undefined) delete hooks[key];
    }
    settings["hooks"] = hooks;
  }

  if (!options.dryRun) {
    await writeJsonObject(settingsPath, settings, false);
  }
  messages.push(`Removed ${GUARD_MARKER}/${POST_GUARD_MARKER} entries from ${settingsPath}.`);
  return { changed: true, messages };
}


function mcpServerEntry(options: HostOperationOptions): Record<string, unknown> {
  return {
    command: "oms",
    args: mcpArgs(options),
  };
}

function refuseSymlinkedLeaf(target: string): void {
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked Oh My Second Brain install target: ${target}`);
  }
}

async function replaceDirectory(source: string, target: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;
  refuseSymlinkedLeaf(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}

async function upsertClaudeMcp(options: HostOperationOptions, claudeDir: string): Promise<boolean> {
  const mcpPath = path.join(claudeDir, "mcp.json");
  const data = await readJsonObject(mcpPath);
  const existingServers = data["mcpServers"];
  const mcpServers = isRecord(existingServers) ? existingServers : {};
  mcpServers["oms"] = mcpServerEntry(options);
  data["mcpServers"] = mcpServers;
  return writeJsonObject(mcpPath, data, Boolean(options.dryRun));
}

async function removeClaudeMcp(options: HostOperationOptions, claudeDir: string): Promise<boolean> {
  const mcpPath = path.join(claudeDir, "mcp.json");
  const data = await readJsonObject(mcpPath);
  const existingServers = data["mcpServers"];
  if (!isRecord(existingServers) || !("oms" in existingServers)) return false;
  delete existingServers["oms"];
  data["mcpServers"] = existingServers;
  return writeJsonObject(mcpPath, data, Boolean(options.dryRun));
}

function runExternal(command: string, args: string[]): { ok: boolean; message: string } {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf-8" });
  if (result.status === 0) return { ok: true, message: `${command} ${args.join(" ")}` };
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return { ok: false, message: stderr || stdout || `${command} exited ${result.status ?? "unknown"}` };
}

async function installClaude(options: HostOperationOptions): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const pluginPath = path.join(options.adapterRoot, "claude-code");
  const commands = [
    `claude plugin install ${pluginPath}`,
    `claude mcp add oms -- oms ${mcpArgs(options).join(" ")}`,
  ];
  const messages = ["Claude Code adapter is installed through Claude's plugin/MCP surfaces."];
  let changed = false;

  if (options.executeExternal) {
    if (!commandExists("claude")) {
      messages.push("claude CLI was not found; wrote MCP config only and left plugin command for manual execution.");
    } else if (!options.dryRun) {
      const externalCommands: [string, ...string[]][] = [
        ["claude", "plugin", "install", pluginPath],
        ["claude", "mcp", "add", "oms", "--", "npx", ...mcpArgs(options)],
      ];
      for (const [command, ...args] of externalCommands) {
        const result = runExternal(command, args);
        messages.push(result.ok ? `Executed: ${result.message}` : `External command failed: ${result.message}`);
        changed = changed || result.ok;
      }
    }
  }

  const mcpChanged = await upsertClaudeMcp(options, claudeDir);
  changed = changed || mcpChanged;

  const hookResult = await upsertClaudeHooks(options, claudeDir);
  changed = changed || hookResult.changed;
  messages.push(...hookResult.messages);

  return {
    runtime: "claude",
    action: "install",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [path.join(claudeDir, "mcp.json"), pluginPath],
    commands,
    messages,
  };
}

async function uninstallClaude(options: HostOperationOptions): Promise<HostOperationResult> {
  const claudeDir = hostHome(options.homeDir, ".claude", "OMS_CLAUDE_HOME");
  const commands = ["claude mcp remove oms", "claude plugin uninstall oms"];
  const messages = ["Claude Code uninstall removes the Oh My Second Brain MCP entry and, when requested, asks Claude CLI to uninstall the plugin."];
  let changed = await removeClaudeMcp(options, claudeDir);

  const hookResult = await removeClaudeHooks(options, claudeDir);
  changed = changed || hookResult.changed;
  messages.push(...hookResult.messages);

  if (options.executeExternal && commandExists("claude") && !options.dryRun) {
    const externalCommands: [string, ...string[]][] = [
      ["claude", "mcp", "remove", "oms"],
      ["claude", "plugin", "uninstall", "oms"],
    ];
    for (const [command, ...args] of externalCommands) {
      const result = runExternal(command, args);
      messages.push(result.ok ? `Executed: ${result.message}` : `External command failed: ${result.message}`);
      changed = changed || result.ok;
    }
  }

  return {
    runtime: "claude",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: false,
    paths: [path.join(claudeDir, "mcp.json")],
    commands,
    messages,
  };
}

function codexManagedBlock(options: HostOperationOptions): string {
  const args = mcpArgs(options).map(jsonString).join(", ");
  return [
    MANAGED_CODEX_START,
    "# OMS MCP hookup for Codex CLI. Managed by `oms install/uninstall`.",
    "# Codex-native rules live in ~/.codex/rules/oms.md; skills live in ~/.codex/skills/oms-*.",
    "[mcp_servers.oms]",
    'command = "oms"',
    `args = [${args}]`,
    "",
    "[mcp_servers.oms.env]",
    'OMS_AGENT_RUNTIME = "codex"',
    MANAGED_CODEX_END,
    "",
  ].join("\n");
}

function isCodexOMSTable(line: string): boolean {
  return line === "[mcp_servers.oms]" || line.startsWith("[mcp_servers.oms.");
}

function removeManagedCodexBlock(content: string): { content: string; removed: boolean } {
  const markerPattern = new RegExp(`\\n?${MANAGED_CODEX_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_CODEX_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  const withoutMarkers = content.replace(markerPattern, "\n");
  const markerRemoved = withoutMarkers !== content;
  const lines = withoutMarkers.split(/\r?\n/);
  const output: string[] = [];
  let removedLegacy = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isCodexOMSTable(trimmed)) {
      removedLegacy = true;
      i++;
      while (i < lines.length) {
        const next = (lines[i] ?? "").trim();
        const isTable = /^\[[^\]]+\]$/.test(next);
        if (isTable && !isCodexOMSTable(next)) {
          i--;
          break;
        }
        i++;
      }
      continue;
    }
    if (line.includes("OMS MCP hookup for Codex CLI")) {
      removedLegacy = true;
      continue;
    }
    output.push(line);
  }
  return { content: output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", removed: markerRemoved || removedLegacy };
}

async function installCodexNativeArtifacts(codexDir: string, options: HostOperationOptions): Promise<string[]> {
  const paths: string[] = [];
  const rulesSource = path.join(options.adapterRoot, "codex", "rules", CODEX_RULE_FILENAME);
  const rulesTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsSource = path.join(options.adapterRoot, "codex", "skills");
  const skillsTargetRoot = path.join(codexDir, "skills");

  if (!options.dryRun) {
    await mkdir(path.dirname(rulesTarget), { recursive: true });
    await cp(rulesSource, rulesTarget);
    await mkdir(skillsTargetRoot, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(skillsSource, { withFileTypes: true });
    const desired = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(skillsTargetRoot, entry.name);
      if (!entry.name.startsWith(CODEX_SKILL_PREFIX)) {
        throw new Error(`Codex skill directory must be namespaced ${CODEX_SKILL_PREFIX}*: ${entry.name}`);
      }
      await replaceDirectory(path.join(skillsSource, entry.name), target, false);
      paths.push(target);
    }
    const installed = await readdir(skillsTargetRoot, { withFileTypes: true });
    for (const entry of installed) {
      if (entry.isDirectory() && entry.name.startsWith(CODEX_SKILL_PREFIX) && !desired.has(entry.name)) {
        await rm(path.join(skillsTargetRoot, entry.name), { recursive: true, force: true });
      }
    }
  } else {
    paths.push(path.join(skillsTargetRoot, `${CODEX_SKILL_PREFIX}setup`));
  }
  return [rulesTarget, ...paths];
}

async function installCodex(options: HostOperationOptions): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const pluginSource = path.join(options.adapterRoot, "codex");
  const pluginTarget = path.join(codexDir, "plugins", "oms");
  const configPath = path.join(codexDir, "config.toml");
  const original = existsSync(configPath) ? await readFile(configPath, "utf-8") : "";
  const stripped = removeManagedCodexBlock(original).content;
  const next = `${stripped.trimEnd()}\n\n${codexManagedBlock(options)}`;
  let nativePaths: string[] = [];
  if (!options.dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf-8");
    await replaceDirectory(pluginSource, pluginTarget, false);
    nativePaths = await installCodexNativeArtifacts(codexDir, options);
  } else {
    nativePaths = [
      path.join(codexDir, "rules", CODEX_RULE_FILENAME),
      path.join(codexDir, "skills", `${CODEX_SKILL_PREFIX}setup`),
    ];
  }
  return {
    runtime: "codex",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [configPath, pluginTarget, ...nativePaths],
    commands: [`Codex MCP config: ${configPath}`],
    messages: ["Installed Codex-native Oh My Second Brain rules, namespaced skills, plugin assets, and managed MCP/env config."],
  };
}

async function uninstallCodex(options: HostOperationOptions): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const pluginTarget = path.join(codexDir, "plugins", "oms");
  const configPath = path.join(codexDir, "config.toml");
  const ruleTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsRoot = path.join(codexDir, "skills");
  let changed = false;
  if (existsSync(configPath)) {
    const original = await readFile(configPath, "utf-8");
    const removed = removeManagedCodexBlock(original);
    changed = removed.removed;
    if (removed.removed && !options.dryRun) await writeFile(configPath, removed.content, "utf-8");
  }
  for (const target of [pluginTarget, ruleTarget]) {
    if (existsSync(target)) {
      changed = true;
      if (!options.dryRun) await rm(target, { recursive: true, force: true });
    }
  }
  if (existsSync(skillsRoot)) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(CODEX_SKILL_PREFIX)) {
        changed = true;
        if (!options.dryRun) await rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  return {
    runtime: "codex",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [configPath, pluginTarget, ruleTarget, path.join(skillsRoot, `${CODEX_SKILL_PREFIX}*`)],
    commands: [],
    messages: ["Removed Codex managed MCP block, Oh My Second Brain rule, namespaced Oh My Second Brain skills, and plugin assets."],
  };
}

async function upsertHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  const data = await readYamlObject(hermesConfig);
  const rawServers = data["mcp_servers"];
  const servers = isRecord(rawServers) ? rawServers : {};
  servers["oms"] = { ...mcpServerEntry(options), enabled: true };
  data["mcp_servers"] = servers;
  return writeYamlObject(hermesConfig, data, Boolean(options.dryRun));
}

async function removeHermesMcp(options: HostOperationOptions, hermesConfig: string): Promise<boolean> {
  const data = await readYamlObject(hermesConfig);
  const rawServers = data["mcp_servers"];
  if (!isRecord(rawServers) || !("oms" in rawServers)) return false;
  delete rawServers["oms"];
  data["mcp_servers"] = rawServers;
  return writeYamlObject(hermesConfig, data, Boolean(options.dryRun));
}

async function installHermes(options: HostOperationOptions): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const pluginSource = path.join(options.adapterRoot, "hermes");
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const skillSource = path.join(options.adapterRoot, "hermes", "skills");
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const configPath = path.join(hermesDir, "config.yaml");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  if (!options.dryRun) {
    await rm(legacyPluginTarget, { recursive: true, force: true });
    await rm(legacyMcpPath, { force: true });
    await replaceDirectory(pluginSource, adapterTarget, false);
    await replaceDirectory(skillSource, skillTarget, false);
    await upsertHermesMcp(options, configPath);
  }
  return {
    runtime: "hermes",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [`Hermes MCP config: ${configPath}`],
    messages: ["Installed Hermes-native Oh My Second Brain skill bundle and registered mcp_servers.oms in ~/.hermes/config.yaml."],
  };
}

async function uninstallHermes(options: HostOperationOptions): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const configPath = path.join(hermesDir, "config.yaml");
  let changed = false;
  if (existsSync(configPath)) changed = (await removeHermesMcp(options, configPath)) || changed;
  for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath]) {
    if (existsSync(target)) {
      changed = true;
      if (!options.dryRun) await rm(target, { recursive: true, force: true });
    }
  }
  return {
    runtime: "hermes",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [],
    messages: ["Removed Hermes Oh My Second Brain skill bundle, adapter copy, legacy descriptor files, and mcp_servers.oms."],
  };
}

export async function runHostOperation(options: HostOperationOptions): Promise<HostOperationResult[]> {
  const runtimes = resolveRuntimeSelection(options.runtime);
  const results: HostOperationResult[] = [];
  for (const runtime of runtimes) {
    if (options.action === "install") {
      if (runtime === "claude") results.push(await installClaude(options));
      if (runtime === "codex") results.push(await installCodex(options));
      if (runtime === "hermes") results.push(await installHermes(options));
    } else {
      if (runtime === "claude") results.push(await uninstallClaude(options));
      if (runtime === "codex") results.push(await uninstallCodex(options));
      if (runtime === "hermes") results.push(await uninstallHermes(options));
    }
  }
  return results;
}

export function formatHostOperationResults(results: HostOperationResult[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? "Oh My Second Brain host operation plan (dry-run)." : "Oh My Second Brain host operation complete.");
  for (const result of results) {
    lines.push(`- ${result.runtime} ${result.action}: ${result.skipped ? "skipped" : result.changed || dryRun ? "ok" : "no changes"}`);
    for (const message of result.messages) lines.push(`  ${message}`);
    for (const filePath of result.paths) lines.push(`  path: ${filePath}`);
    for (const command of result.commands) lines.push(`  command: ${command}`);
  }
  return lines.join("\n");
}
