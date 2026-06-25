import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../harness/surface-registry.js";
import { resolveHostAdapterSource } from "./adapter-source.js";
import { hostHome, jsonString, mcpArgs, replaceDirectory } from "./common.js";
import type { HostOperationOptions, HostOperationResult } from "./types.js";

const MANAGED_CODEX_START = "# BEGIN OMS MANAGED MCP";
const MANAGED_CODEX_END = "# END OMS MANAGED MCP";
const CODEX_SKILL_PREFIX = "oms-";
const CODEX_RULE_FILENAME = "oms.md";

export class CodexSkillNamespaceError extends Error {
  readonly skillDir: string;
  readonly prefix: string;

  constructor(skillDir: string, prefix: string) {
    super(`Codex skill directory must be namespaced ${prefix}*: ${skillDir}`);
    this.name = "CodexSkillNamespaceError";
    this.skillDir = skillDir;
    this.prefix = prefix;
  }
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
  const start = MANAGED_CODEX_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = MANAGED_CODEX_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
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
  return { content: `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, removed: markerRemoved || removedLegacy };
}

async function installCodexNativeArtifacts(
  codexDir: string,
  options: HostOperationOptions,
  adapterSource: string,
): Promise<string[]> {
  const paths: string[] = [];
  const rulesSource = path.join(adapterSource, "rules", CODEX_RULE_FILENAME);
  const rulesTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsSource = path.join(adapterSource, "skills");
  const skillsTargetRoot = path.join(codexDir, "skills");

  if (!options.dryRun) {
    await mkdir(path.dirname(rulesTarget), { recursive: true });
    await cp(rulesSource, rulesTarget);
    await mkdir(skillsTargetRoot, { recursive: true });
    const entries = await readdir(skillsSource, { withFileTypes: true });
    const desired = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(skillsTargetRoot, entry.name);
      if (!entry.name.startsWith(CODEX_SKILL_PREFIX)) {
        throw new CodexSkillNamespaceError(entry.name, CODEX_SKILL_PREFIX);
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

export async function installCodex(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const pluginSource = resolveHostAdapterSource(options.adapterRoot, host);
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
    nativePaths = await installCodexNativeArtifacts(codexDir, options, pluginSource);
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

export async function uninstallCodex(options: HostOperationOptions): Promise<HostOperationResult> {
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
