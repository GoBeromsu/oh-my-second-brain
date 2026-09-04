import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../../kernel/harness/surface-registry.js";
import { resolveHostAdapterSource } from "../../kernel/install/adapter-source.js";
import { resolveSharedSkillsSource } from "../../assets/shared-skills.js";
import { hostHome, jsonString, mcpArgs, replaceDirectory } from "../../kernel/install/common.js";
import type { HostOperationOptions, HostOperationResult } from "../../kernel/install/types.js";

const MANAGED_CODEX_START = "# BEGIN OMS MANAGED MCP";
const MANAGED_CODEX_END = "# END OMS MANAGED MCP";
const CODEX_SKILL_PREFIX = "oms-";
const CODEX_RULE_FILENAME = "oms.md";

function codexManagedBlockForVault(vault: string): string {
  const args = mcpArgs({ vault } as HostOperationOptions).map(jsonString).join(", ");
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


/** Recognizes exactly the managed MCP block rendered by this adapter. */
export function isCodexOmsRegistration(content: string, configPath = "Codex config"): boolean {
  const block = managedCodexBlock(content, configPath);
  if (block === undefined) return false;
  const managed = content.slice(block.start, block.end);
  const vault = /^args = \["mcp", "--vault", ("(?:[^"\\]|\\.)*")\]$/m.exec(managed)?.[1];
  if (vault === undefined) return false;
  let parsedVault: unknown;
  try {
    parsedVault = JSON.parse(vault);
  } catch {
    return false;
  }
  return typeof parsedVault === "string" && managed === codexManagedBlockForVault(parsedVault);
}

function isCodexOMSTable(line: string): boolean {
  return line === "[mcp_servers.oms]" || line.startsWith("[mcp_servers.oms.");
}

type CodexManagedMarker = {
  readonly token: typeof MANAGED_CODEX_START | typeof MANAGED_CODEX_END;
  readonly line: number;
  readonly lineStart: number;
  readonly offset: number;
  readonly valid: boolean;
};

type ManagedCodexBlock = {
  readonly start: number;
  readonly end: number;
};

class CodexManagedBlockAmbiguousError extends Error {
  constructor(configPath: string, markers: readonly CodexManagedMarker[]) {
    const locations = markers.length === 0
      ? "none"
      : markers.map((marker) => `${marker.token} (line ${marker.line})`).join(", ");
    super(
      `Ambiguous OMS managed MCP markers in ${configPath}: ${locations}. `
      + "No changes were made. Manually remove every OMS managed MCP block and its markers, then rerun oms install or uninstall.",
    );
    this.name = "CodexManagedBlockAmbiguousError";
  }
}

function scanCodexManagedMarkers(content: string): CodexManagedMarker[] {
  const markers: CodexManagedMarker[] = [];
  let offset = 0;
  let line = 1;
  for (const sourceLine of content.split(/(?<=\n)/)) {
    const lineContent = sourceLine.replace(/\r?\n$/, "");
    let position = 0;
    while (position < sourceLine.length) {
      const start = sourceLine.indexOf(MANAGED_CODEX_START, position);
      const end = sourceLine.indexOf(MANAGED_CODEX_END, position);
      if (start === -1 && end === -1) break;
      const isStart = start !== -1 && (end === -1 || start < end);
      const token = isStart ? MANAGED_CODEX_START : MANAGED_CODEX_END;
      const tokenOffset = isStart ? start : end;
      markers.push({
        token,
        line,
        lineStart: offset,
        offset: offset + tokenOffset,
        valid: lineContent === `${sourceLine.slice(0, tokenOffset)}${token}`
          && /^[ \t]*$/.test(sourceLine.slice(0, tokenOffset)),
      });
      position = tokenOffset + token.length;
    }
    offset += sourceLine.length;
    line++;
  }
  return markers;
}

function managedCodexBlock(content: string, configPath: string): ManagedCodexBlock | undefined {
  const markers = scanCodexManagedMarkers(content);
  if (markers.length === 0) return undefined;
  if (
    markers.length !== 2
    || markers.some((marker) => !marker.valid)
    || markers[0]?.token !== MANAGED_CODEX_START
    || markers[1]?.token !== MANAGED_CODEX_END
  ) {
    throw new CodexManagedBlockAmbiguousError(configPath, markers);
  }
  const start = markers[0];
  const end = markers[1];
  if (
    start === undefined
    || end === undefined
    || start.offset >= end.offset
    || start.line >= end.line
  ) {
    throw new CodexManagedBlockAmbiguousError(configPath, markers);
  }

  let blockEnd = end.offset + MANAGED_CODEX_END.length;
  if (content.slice(blockEnd, blockEnd + 2) === "\r\n") blockEnd += 2;
  else if (content[blockEnd] === "\n") blockEnd++;
  return { start: start.lineStart, end: blockEnd };
}

function removeManagedCodexBlock(
  content: string,
  configPath: string,
): { content: string; removed: boolean; block: ManagedCodexBlock | undefined } {
  const block = managedCodexBlock(content, configPath);
  if (block !== undefined) {
    return {
      content: `${content.slice(0, block.start)}${content.slice(block.end)}`,
      removed: true,
      block,
    };
  }
  const lines = content.split(/\r?\n/);
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
  return {
    content: `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`,
    removed: removedLegacy,
    block: undefined,
  };
}

async function installCodexNativeArtifacts(
  codexDir: string,
  options: HostOperationOptions,
  packageRoot: string,
  skillsSource: string,
): Promise<string[]> {
  const paths: string[] = [];
  const rulesSource = path.join(packageRoot, "assets", "codex", "rules", CODEX_RULE_FILENAME);
  const rulesTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsTargetRoot = path.join(codexDir, "skills");

  if (!options.dryRun) {
    await mkdir(path.dirname(rulesTarget), { recursive: true });
    await cp(rulesSource, rulesTarget);
    await mkdir(skillsTargetRoot, { recursive: true });
    const entries = await readdir(skillsSource, { withFileTypes: true });
    const desired = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => `${CODEX_SKILL_PREFIX}${entry.name}`),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(skillsTargetRoot, `${CODEX_SKILL_PREFIX}${entry.name}`);
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

/** Codex install uses native file copies for its rules and skills. */
export async function installCodex(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const packageRoot = resolveHostAdapterSource(options.adapterRoot, host);
  const skillsSource = resolveSharedSkillsSource(packageRoot);
  const guidanceSource = path.join(packageRoot, "assets", "codex", "AGENTS.md");
  const guidanceTarget = path.join(codexDir, "plugins", "oms", "AGENTS.md");
  const configPath = path.join(codexDir, "config.toml");
  const original = existsSync(configPath) ? await readFile(configPath, "utf-8") : "";
  const removed = removeManagedCodexBlock(original, configPath);
  const next = removed.block === undefined
    ? `${removed.content.trimEnd()}\n\n${codexManagedBlockForVault(options.vault)}`
    : `${original.slice(0, removed.block.start)}${codexManagedBlockForVault(options.vault)}${original.slice(removed.block.end)}`;
  let nativePaths: string[] = [];
  if (!options.dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf-8");
    await rm(path.dirname(guidanceTarget), { recursive: true, force: true });
    await mkdir(path.dirname(guidanceTarget), { recursive: true });
    await cp(guidanceSource, guidanceTarget);
    nativePaths = await installCodexNativeArtifacts(codexDir, options, packageRoot, skillsSource);
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
    paths: [configPath, guidanceTarget, ...nativePaths],
    commands: [`Codex MCP config: ${configPath}`],
    messages: ["Installed Codex-native Oh My Second Brain rules, namespaced skills, and managed MCP/env config."],
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
    const removed = removeManagedCodexBlock(original, configPath);
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
