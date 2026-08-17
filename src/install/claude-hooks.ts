import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord, writeJsonObject } from "./common.js";
import type { HostOperationOptions } from "./types.js";

const GUARD_MARKER = "oms-guard";
const POST_GUARD_MARKER = "oms-post-guard";
const HOOK_MATCHER = "Write|Edit|NotebookEdit";

function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

export function toShellVaultPath(absPath: string, homeDir: string): string {
  const rel = path.relative(homeDir, absPath);
  if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `"$HOME/${escapeShellDoubleQuoted(rel.replace(/\\/g, "/"))}"`;
  }
  return `"${escapeShellDoubleQuoted(absPath)}"`;
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

function tokenizeHookCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      token += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      token += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      token += character;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }

  if (quote !== null || escaped) return null;
  if (token.length > 0) tokens.push(token);
  return tokens;
}

function isOwnedAssignment(token: string, key: "OMS_VAULT" | "OMS_AGENT_VAULT"): boolean {
  const prefix = `${key}="`;
  if (!token.startsWith(prefix) || !token.endsWith('"')) return false;
  const value = token.slice(prefix.length, -1);
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped !== '"' && escaped !== "\\" && escaped !== "$" && escaped !== "`") return false;
      index++;
      continue;
    }
    if (character === "$" && index === 0 && value.length > "$HOME/".length && value.startsWith("$HOME/")) {
      index += "$HOME/".length - 1;
      continue;
    }
    if (character === '"' || character === "$" || character === "`") return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

export function isOmsHookEntry(entry: unknown, marker: string): boolean {
  if (!isRecord(entry)) return false;
  if (!hasExactKeys(entry, ["hooks", "matcher"])) return false;
  if (entry["matcher"] !== HOOK_MATCHER) return false;
  const inner = entry["hooks"];
  if (!Array.isArray(inner) || inner.length !== 1) return false;
  return inner.every((h) => {
    if (!isRecord(h) || h["type"] !== "command" || typeof h["command"] !== "string") return false;
    if (!hasExactKeys(h, ["command", "type"])) return false;
    const tokens = tokenizeHookCommand(h["command"]);
    if (tokens === null || tokens.at(-1) !== marker) return false;
    if (tokens.length === 2) return isOwnedAssignment(tokens[0] ?? "", "OMS_VAULT");
    if (tokens.length === 3) {
      return (
        isOwnedAssignment(tokens[0] ?? "", "OMS_VAULT") &&
        isOwnedAssignment(tokens[1] ?? "", "OMS_AGENT_VAULT")
      );
    }
    return false;
  });
}

interface SettingsReadResult {
  readonly data: Record<string, unknown> | null;
  readonly corrupt: boolean;
  readonly raw: string | null;
}

function isHookMap(value: unknown): value is Record<string, unknown[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => Array.isArray(entry));
}

async function readSettingsJsonSafe(settingsPath: string): Promise<SettingsReadResult> {
  try {
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed)
      ? { data: parsed, corrupt: false, raw }
      : { data: null, corrupt: true, raw };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { data: {}, corrupt: false, raw: null };
    }
    return { data: null, corrupt: true, raw: null };
  }
}

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index] ?? "")) index++;
  return index;
}

function scanJsonString(raw: string, start: number): number | null {
  if (raw[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < raw.length; index++) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return null;
}

function scanJsonValue(raw: string, start: number): number | null {
  const first = raw[start];
  if (first === '"') return scanJsonString(raw, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < raw.length && !",}]".includes(raw[index] ?? "")) index++;
    return index;
  }

  const closing = first === "{" ? "}" : "]";
  let index = start + 1;
  while (index < raw.length) {
    index = skipJsonWhitespace(raw, index);
    if (raw[index] === closing) return index + 1;
    if (first === "{") {
      const keyEnd = scanJsonString(raw, index);
      if (keyEnd === null) return null;
      index = skipJsonWhitespace(raw, keyEnd);
      if (raw[index] !== ":") return null;
      index = skipJsonWhitespace(raw, index + 1);
    }
    const valueEnd = scanJsonValue(raw, index);
    if (valueEnd === null) return null;
    index = skipJsonWhitespace(raw, valueEnd);
    if (raw[index] === ",") {
      index++;
      continue;
    }
    if (raw[index] === closing) return index + 1;
    return null;
  }
  return null;
}

interface RootJsonProperty {
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

function findRootJsonProperty(raw: string, key: string): RootJsonProperty | null {
  const rootStart = skipJsonWhitespace(raw, 0);
  const rootEnd = scanJsonValue(raw, rootStart);
  if (raw[rootStart] !== "{" || rootEnd === null) return null;
  let index = skipJsonWhitespace(raw, rootStart + 1);
  while (index < rootEnd - 1) {
    const keyStart = index;
    const keyEnd = scanJsonString(raw, keyStart);
    if (keyEnd === null) return null;
    let parsedKey: unknown;
    try {
      parsedKey = JSON.parse(raw.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    index = skipJsonWhitespace(raw, keyEnd);
    if (raw[index] !== ":") return null;
    const valueStart = skipJsonWhitespace(raw, index + 1);
    const valueEnd = scanJsonValue(raw, valueStart);
    if (valueEnd === null) return null;
    if (parsedKey === key) return { keyStart, valueStart, valueEnd };
    index = skipJsonWhitespace(raw, valueEnd);
    if (raw[index] !== ",") break;
    index = skipJsonWhitespace(raw, index + 1);
  }
  return null;
}

function formatJsonValue(value: unknown, propertyIndent: string): string {
  const serialized = JSON.stringify(value, null, 2);
  if (propertyIndent.length === 0) return JSON.stringify(value);
  return serialized
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${propertyIndent}${line}`))
    .join("\n");
}

export function replaceRootJsonPropertyPreservingBytes(raw: string, key: string, value: unknown): string | null {
  const property = findRootJsonProperty(raw, key);
  if (property === null) {
    if (value === undefined) return raw;
    const rootStart = skipJsonWhitespace(raw, 0);
    const rootEnd = scanJsonValue(raw, rootStart);
    if (rootEnd === null) return null;
    const closeIndex = rootEnd - 1;
    const closeLineStart = raw.lastIndexOf("\n", closeIndex) + 1;
    const closeIndent = raw.slice(closeLineStart, closeIndex);
    const hasMembers = raw.slice(rootStart + 1, closeIndex).trim().length > 0;
    if (!/^\s*$/.test(closeIndent)) {
      const compact = `${hasMembers ? "," : ""}${JSON.stringify(key)}:${JSON.stringify(value)}`;
      return `${raw.slice(0, closeIndex)}${compact}${raw.slice(closeIndex)}`;
    }
    const propertyIndent = hasMembers ? closeIndent + "  " : "  ";
    const propertyText = `${JSON.stringify(key)}: ${formatJsonValue(value, propertyIndent)}`;
    const insertion = `${hasMembers ? "," : ""}\n${propertyIndent}${propertyText}\n${closeIndent}`;
    return `${raw.slice(0, closeIndex)}${insertion}${raw.slice(closeIndex)}`;
  }

  const lineStart = raw.lastIndexOf("\n", property.keyStart) + 1;
  const linePrefix = raw.slice(lineStart, property.keyStart);
  const propertyIndent = /^\s*$/.test(linePrefix) ? linePrefix : "";
  if (value !== undefined) {
    return `${raw.slice(0, property.valueStart)}${formatJsonValue(value, propertyIndent)}${raw.slice(property.valueEnd)}`;
  }

  let removeStart = propertyIndent.length > 0 ? lineStart : property.keyStart;
  let removeEnd = property.valueEnd;
  const afterValue = skipJsonWhitespace(raw, removeEnd);
  if (raw[afterValue] === ",") {
    removeEnd = afterValue + 1;
  } else {
    let previous = removeStart - 1;
    while (previous >= 0 && /\s/.test(raw[previous] ?? "")) previous--;
    if (raw[previous] === ",") removeStart = previous;
  }
  return `${raw.slice(0, removeStart)}${raw.slice(removeEnd)}`;
}

async function writeSettingsJson(
  settingsPath: string,
  originalRaw: string | null,
  settings: Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  if (originalRaw === null) return writeJsonObject(settingsPath, settings, false);
  const next = replaceRootJsonPropertyPreservingBytes(originalRaw, "hooks", settings["hooks"]);
  if (next === null) throw new Error(`Could not preserve unmanaged settings bytes in ${settingsPath}.`);
  await writeFile(settingsPath, next, "utf-8");
  return true;
}

export async function upsertClaudeHooks(
  options: Pick<HostOperationOptions, "vault" | "agentVault" | "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const homeDir = options.homeDir ?? homedir();
  const { data, corrupt, raw } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt || data === null) {
    const preCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, GUARD_MARKER);
    const postCmd = buildGuardCommandString(options.vault, options.agentVault, homeDir, POST_GUARD_MARKER);
    messages.push(
      `WARNING: ${settingsPath} is not a supported JSON object — hook wiring skipped to avoid data loss.`,
      `Manual step: add these entries to ${settingsPath}:`,
      `  hooks.PreToolUse:  {"matcher":"${HOOK_MATCHER}","hooks":[{"type":"command","command":"${preCmd}"}]}`,
      `  hooks.PostToolUse: {"matcher":"${HOOK_MATCHER}","hooks":[{"type":"command","command":"${postCmd}"}]}`,
    );
    return { changed: false, messages };
  }

  const settings = data;
  const rawHooks = settings["hooks"];
  if (rawHooks !== undefined && !isHookMap(rawHooks)) {
    messages.push(`WARNING: ${settingsPath} has unsupported hook metadata — hook wiring skipped to avoid data loss.`);
    return { changed: false, messages };
  }
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
  try {
    await writeSettingsJson(settingsPath, raw, settings, Boolean(options.dryRun));
  } catch {
    messages.push(`WARNING: Could not write ${settingsPath}; hook wiring skipped. Add the generated entries manually.`);
    return { changed: false, messages };
  }
  messages.push(`Wired ${GUARD_MARKER}/${POST_GUARD_MARKER} into ${settingsPath}.`);
  return { changed: true, messages };
}

export async function removeClaudeHooks(
  options: Pick<HostOperationOptions, "dryRun" | "homeDir">,
  claudeDir: string,
): Promise<{ changed: boolean; messages: string[] }> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const { data, corrupt, raw } = await readSettingsJsonSafe(settingsPath);
  const messages: string[] = [];

  if (corrupt || data === null) {
    messages.push(`WARNING: ${settingsPath} is not a supported JSON object — skipping hook removal.`);
    return { changed: false, messages };
  }

  const settings = data;
  const rawHooks = settings["hooks"];
  if (rawHooks === undefined) {
    return { changed: false, messages };
  }
  if (!isHookMap(rawHooks)) {
    messages.push(`WARNING: ${settingsPath} has unsupported hook metadata — hook removal skipped to avoid data loss.`);
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
      if (filtered.length > 0) hooks[eventName] = filtered;
      else delete hooks[eventName];
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, messages };
  }

  const hasRemainingHooks = Object.keys(hooks).length > 0;
  if (!hasRemainingHooks) {
    delete settings["hooks"];
  } else {
    settings["hooks"] = hooks;
  }

  try {
    await writeSettingsJson(settingsPath, raw, settings, Boolean(options.dryRun));
  } catch {
    messages.push(`WARNING: Could not write ${settingsPath}; hook removal skipped. Remove OMS entries manually.`);
    return { changed: false, messages };
  }
  messages.push(`Removed ${GUARD_MARKER}/${POST_GUARD_MARKER} entries from ${settingsPath}.`);
  return { changed: true, messages };
}
