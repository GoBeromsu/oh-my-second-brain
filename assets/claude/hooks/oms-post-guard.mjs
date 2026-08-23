#!/usr/bin/env node
/**
 * oms-post-guard — thin PostToolUse wrapper for Claude Code settings.json.
 *
 * Filters vault-relevant Write/Edit completions and delegates to
 * `oms hook post-tool-use --vault <vault>` for frontmatter audit and
 * graph cache debounce. Vault 무관 호출은 spawn 없이 즉시 통과.
 *
 * Configuration (env vars set by the settings.json hook definition):
 *   OMS_VAULT        — primary vault path
 *   OMS_AGENT_VAULT  — agent vault path
 *
 * Fail-open: any error → silent return (PostToolUse hooks are advisory).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set(["Write", "write", "Edit", "edit"]);

/**
 * Resolve how to invoke the oms CLI. Prefer `node <dist>` over the `oms` bin so
 * the hook survives a bare `tsc` rebuild stripping the bin's executable bit
 * (which makes spawnSync("oms") fail with EACCES). Fall back to PATH `oms`.
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
  const vaultPaths = [
    process.env.OMS_VAULT,
    process.env.OMS_AGENT_VAULT,
  ].filter(Boolean);

  if (vaultPaths.length === 0) return;

  let rawInput;
  try { rawInput = await readStdin(); }
  catch { return; }

  let data;
  try { data = JSON.parse(rawInput); }
  catch { return; }

  const toolName = data.tool_name || data.toolName || "";
  if (!WRITE_TOOLS.has(toolName)) return;

  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = String(toolInput.path || toolInput.file_path || "");
  if (!filePath) return;

  const targetVault = vaultPaths.find(
    (v) => filePath === v || filePath.startsWith(v + "/"),
  );
  if (!targetVault) return;

  try {
    const { cmd, prefix } = resolveOmsCommand();
    const result = spawnSync(
      cmd,
      [...prefix, "hook", "post-tool-use", "--vault", targetVault],
      { input: rawInput, encoding: "utf-8", timeout: 30000 },
    );
    // Forward any additionalContext output from the post-tool-use hook.
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) process.stderr.write("[oms-post-guard] " + result.stderr);
  } catch {
    // Fail silently — post-tool-use is advisory.
  }
}

main().catch(() => {});
