import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord, writeJsonObject } from "./common.js";
import type { HostOperationOptions } from "./types.js";

const GUARD_MARKER = "oms-guard";
const POST_GUARD_MARKER = "oms-post-guard";
const HOOK_MATCHER = "Write|Edit|NotebookEdit";

export function toShellVaultPath(absPath: string, homeDir: string): string {
  const rel = path.relative(homeDir, absPath);
  if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `"$HOME/${rel.replace(/\\/g, "/")}"`;
  }
  return `"${absPath}"`;
}

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

function buildOmsHookEntry(matcher: string, command: string): Record<string, unknown> {
  return { matcher, hooks: [{ type: "command", command }] };
}

export function isOmsHookEntry(entry: unknown, marker: string): boolean {
  if (!isRecord(entry)) return false;
  const inner = entry["hooks"];
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h) => isRecord(h) && typeof h["command"] === "string" && h["command"].includes(marker),
  );
}

interface SettingsReadResult {
  readonly data: Record<string, unknown> | null;
  readonly corrupt: boolean;
}

function isHookMap(value: unknown): value is Record<string, unknown[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => Array.isArray(entry));
}

async function readSettingsJsonSafe(settingsPath: string): Promise<SettingsReadResult> {
  try {
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return { data: isRecord(parsed) ? parsed : {}, corrupt: false };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { data: {}, corrupt: false };
    }
    return { data: null, corrupt: true };
  }
}

export async function upsertClaudeHooks(
  options: Pick<HostOperationOptions, "vault" | "agentVault" | "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const homeDir = options.homeDir ?? homedir();
  const { data, corrupt } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt || data === null) {
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

  const settings = data;
  const rawHooks = settings["hooks"];
  const hooks: Record<string, unknown[]> = isHookMap(rawHooks) ? rawHooks : {};
  let changed = false;

  const preCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, GUARD_MARKER);
  const postCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, POST_GUARD_MARKER);

  const preArr = Array.isArray(hooks["PreToolUse"]) ? [...hooks["PreToolUse"]] : [];
  if (!preArr.some((e) => isOmsHookEntry(e, GUARD_MARKER))) {
    preArr.push(buildOmsHookEntry(HOOK_MATCHER, preCmd));
    hooks["PreToolUse"] = preArr;
    changed = true;
  }

  const postArr = Array.isArray(hooks["PostToolUse"]) ? [...hooks["PostToolUse"]] : [];
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

export async function removeClaudeHooks(
  options: Pick<HostOperationOptions, "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const { data, corrupt } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt || data === null) {
    messages.push(`WARNING: ${settingsPath} is not valid JSON — skipping hook removal.`);
    return { changed: false, messages };
  }

  const settings = data;
  const rawHooks = settings["hooks"];
  if (!isRecord(rawHooks)) {
    return { changed: false, messages };
  }
  const hooks = rawHooks;
  let changed = false;

  for (const [eventName, marker] of [
    ["PreToolUse", GUARD_MARKER],
    ["PostToolUse", POST_GUARD_MARKER],
  ] as const) {
    const arr = hooks[eventName];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((e) => !isOmsHookEntry(e, marker));
    if (filtered.length < arr.length) {
      hooks[eventName] = filtered.length > 0 ? filtered : undefined;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, messages };
  }

  const hasRemainingHooks = Object.values(hooks).some((v) => v !== undefined && Array.isArray(v) && v.length > 0);
  if (!hasRemainingHooks) {
    delete settings["hooks"];
  } else {
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
