#!/usr/bin/env node
/**
 * oms-guard — thin PreToolUse wrapper for Claude Code settings.json.
 *
 * Filters vault-relevant Write/Edit tool calls and delegates to
 * `oms hook pre-tool-use --vault <vault>` only when the target path is
 * inside a configured vault. Vault 무관 호출은 spawn 없이 즉시 통과.
 *
 * Configuration (env vars set by the settings.json hook definition):
 *   OMS_VAULT        — primary vault path (e.g. /Users/…/Ataraxia)
 *   OMS_AGENT_VAULT  — agent vault path  (e.g. /Users/…/agent)
 *   OMS_GUARD        — set to "off" to bypass all checks
 *
 * Fail-open: any error (oms crash, timeout, invalid JSON) → {"continue": true}.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set(["Write", "write", "Edit", "edit"]);

/**
 * Resolve how to invoke the oms CLI for the hook.
 *
 * Prefer running the co-located dist entry via `node <dist>` so the guard is
 * immune to the `oms` bin losing its executable bit on a bare `tsc` rebuild
 * (which silently breaks `spawnSync("oms")` with EACCES and fails the guard
 * open). Fall back to the `oms` bin on PATH only if dist can't be located.
 */
function resolveOmsCommand() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = resolve(here, "../../../dist/cli/oms.js");
    if (existsSync(dist)) return { cmd: process.execPath, prefix: [dist] };
  } catch {
    // fall through to PATH lookup
  }
  return { cmd: "oms", prefix: [] };
}

function allow() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
}

async function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    }, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    });
    process.stdin.on("error", () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(""); }
    });
    if (process.stdin.readableEnded) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }
  });
}

async function main() {
  // Global escape hatch.
  if (process.env.OMS_GUARD === "off") { allow(); return; }

  const vaultPaths = [
    process.env.OMS_VAULT,
    process.env.OMS_AGENT_VAULT,
  ].filter(Boolean);

  // No vaults configured → pass through.
  if (vaultPaths.length === 0) { allow(); return; }

  let rawInput;
  try { rawInput = await readStdin(); }
  catch { allow(); return; }

  let data;
  try { data = JSON.parse(rawInput); }
  catch { allow(); return; }

  const toolName = data.tool_name || data.toolName || "";

  // Skip non-Write/Edit tools immediately — zero spawn overhead.
  if (!WRITE_TOOLS.has(toolName)) { allow(); return; }

  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = String(toolInput.path || toolInput.file_path || "");
  if (!filePath) { allow(); return; }

  // Determine which vault this path belongs to.
  const targetVault = vaultPaths.find(
    (v) => filePath === v || filePath.startsWith(v + "/"),
  );
  if (!targetVault) { allow(); return; }

  // Spawn `oms hook pre-tool-use --vault <vault>` with the raw stdin payload.
  try {
    const { cmd, prefix } = resolveOmsCommand();
    const result = spawnSync(
      cmd,
      [...prefix, "hook", "pre-tool-use", "--vault", targetVault],
      { input: rawInput, encoding: "utf-8", timeout: 10000 },
    );
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      process.stdout.write(result.stdout);
    } else {
      // oms exited non-zero or produced no output → fail-open.
      if (result.stderr) process.stderr.write("[oms-guard] " + result.stderr);
      allow();
    }
  } catch {
    // spawn failure → fail-open.
    allow();
  }
}

main().catch(() => allow());
