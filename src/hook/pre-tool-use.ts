import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readStdinTimeout } from "./stdin.js";

interface PreToolUsePayload {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
}

interface HookResponse {
  continue: boolean;
  suppressOutput?: boolean;
  reason?: string;
}

function writeResponse(resp: HookResponse): void {
  process.stdout.write(JSON.stringify(resp) + "\n");
}

/**
 * Check whether a vault-relative path is covered by any registered folder entry.
 *
 * Handles both top-level registrations (`00. Inbox`) and 2-depth registrations
 * (`80. References/03 Clippings`) so Ataraxia and agent vault taxonomies are
 * treated identically.
 */
export function isPathAllowed(relPath: string, registeredFolders: readonly string[]): boolean {
  for (const folder of registeredFolders) {
    if (relPath === folder || relPath.startsWith(folder + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Load registered folder keys from <vault>/.oms/taxonomy.yaml.
 * Returns null on any I/O or parse error (caller must fail-open).
 */
export async function loadRegisteredFolders(vault: string): Promise<string[] | null> {
  try {
    const raw = await readFile(path.join(vault, ".oms", "taxonomy.yaml"), "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const folders = parsed["folders"];
    if (!folders || typeof folders !== "object" || Array.isArray(folders)) return null;
    return Object.keys(folders as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function runPreToolUse(opts: { vault: string }): Promise<void> {
  // Escape hatch: OMS_GUARD=off bypasses all checks.
  if (process.env["OMS_GUARD"] === "off") {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  const vault = path.resolve(opts.vault);

  // Fail-open on stdin errors.
  let rawInput: string;
  try {
    rawInput = await readStdinTimeout();
  } catch {
    process.stderr.write("[oms-guard] stdin read error — fail-open\n");
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  // Fail-open on invalid JSON.
  let payload: PreToolUsePayload;
  try {
    payload = JSON.parse(rawInput) as PreToolUsePayload;
  } catch {
    process.stderr.write("[oms-guard] invalid JSON on stdin — fail-open\n");
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  const toolName = (payload.tool_name ?? payload.toolName ?? "").toLowerCase();

  // Only intercept Write and Edit. Bash is too ambiguous to parse safely.
  if (toolName !== "write" && toolName !== "edit") {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  const toolInput = payload.tool_input ?? {};
  // Write tool uses `path`; Edit tool uses `path` or `file_path`.
  const rawFilePath = String(toolInput["path"] ?? toolInput["file_path"] ?? "");
  if (!rawFilePath) {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  const absFilePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(rawFilePath);
  const relPath = path.relative(vault, absFilePath).replace(/\\/g, "/");

  // Outside vault — not our concern.
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  // Load taxonomy — fail-open if unreadable or corrupt.
  const registeredFolders = await loadRegisteredFolders(vault);
  if (registeredFolders === null) {
    process.stderr.write(`[oms-guard] taxonomy.yaml unreadable at ${vault} — fail-open\n`);
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  // Empty taxonomy → fail-open (avoid blocking everything on an unconfigured vault).
  if (registeredFolders.length === 0) {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  if (isPathAllowed(relPath, registeredFolders)) {
    writeResponse({ continue: true, suppressOutput: true });
    return;
  }

  const topFolder = relPath.split("/")[0] ?? relPath;
  const reason =
    `[oms-guard] Blocked: "${topFolder}" is not registered in .oms/taxonomy.yaml.\n` +
    `Vault: ${vault}\n` +
    `To register this folder run: oms setup --vault ${vault}\n` +
    `To bypass temporarily set: OMS_GUARD=off`;

  writeResponse({ continue: false, reason });
}
