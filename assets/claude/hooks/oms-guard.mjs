#!/usr/bin/env node
/**
 * oms-guard — PreToolUse wrapper for Claude Code settings.json.
 *
 * Order: parse stdin → normalise the tool name → deny `~/.oms/**` (reads and writes,
 * no spawn) → read tools decided here (no spawn) → deny writes to this guard file, the
 * installed oms package and Claude's settings files → writes inside a configured vault
 * (the deepest one) are judged by `oms hook pre --vault <vault>`; everything else passes
 * without a spawn.
 *
 * Configuration (env vars set by the settings.json hook definition):
 *   OMS_VAULT        — primary vault path
 *   OMS_AGENT_VAULT  — agent vault path
 *
 * The judge's deny is forwarded as is. When the judge cannot be reached (spawn failure,
 * non-zero exit, timeout, malformed output) the write is allowed with one stderr line and
 * the failure kind is recorded in `~/.oms/guard-events.jsonl` for `oms contract doctor`.
 * A payload that cannot be parsed (or exceeds the stdin cap) is denied when its raw text
 * names a configured vault or `~/.oms`, and otherwise allowed with one stderr line.
 *
 * Claude's settings files, where this hook is registered, are write-protected like the
 * guard itself: `settings.json` and `settings.local.json` in `~/.claude` (or
 * `$CLAUDE_CONFIG_DIR`, `$OMS_CLAUDE_HOME`) and in each configured vault's `.claude/`.
 * Reads stay allowed; the user edits these files outside the agent.
 *
 * Known limit: only the tools in the hook matchers reach this guard. A Bash command that
 * writes one of these files is not seen here.
 */

import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRANSPORT_FAILURE_POLICY = "allow-warn";
const JUDGE_TIMEOUT_MS = 10000;
const EVENTS_CAP_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

// Keep in step with HOOK_MATCHER / READ_MATCHER in src/vendors/claude/claude-hooks.ts (parity test).
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "grep", "glob"]);

const ALLOW = JSON.stringify({ continue: true, suppressOutput: true });
const CONTROL_PATH_REASON = `[oms] write denied: ${JSON.stringify([{ field: "path", kind: "control-path" }])} Run: oms status`;
const SEARCH_REASON = `[oms] write denied: ${JSON.stringify([{ field: "path", kind: "control-path" }])} Narrow the search path or glob so it cannot reach ~/.oms. Run: oms status`;
const UNSAFE_PATH_REASON = `[oms] write denied: ${JSON.stringify([{ field: "path", kind: "path-unsafe" }])} Run: oms status`;
const INPUT_REASON = `[oms] write denied: ${JSON.stringify([{ field: "input", kind: "unsupported-input" }])} Run: oms host sync`;

/**
 * Prefer the co-located dist entry via `node <dist>` so the guard does not depend on the
 * `oms` bin keeping its executable bit; fall back to `oms` on PATH.
 */
function resolveOmsCommand() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.resolve(here, "../../../dist/cli/oms.js");
    if (existsSync(dist)) return { cmd: process.execPath, prefix: [dist] };
  } catch {
    // fall through to PATH lookup
  }
  return { cmd: "oms", prefix: [] };
}

function allow() {
  process.stdout.write(ALLOW + "\n");
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n");
}

/** Resolves `{ text, truncated }`; input beyond `MAX_STDIN_BYTES` is dropped and marks `truncated`. */
async function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (truncated) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString("utf-8"), truncated });
    };
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      finish(false);
    }, timeoutMs);
    process.stdin.on("data", (c) => {
      if (size + c.length > MAX_STDIN_BYTES) {
        chunks.push(c.subarray(0, MAX_STDIN_BYTES - size));
        size = MAX_STDIN_BYTES;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        finish(true);
        return;
      }
      size += c.length;
      chunks.push(c);
    });
    process.stdin.on("end", () => finish(false));
    process.stdin.on("error", () => { chunks.length = 0; finish(false); });
    if (process.stdin.readableEnded) finish(false);
  });
}

/** `~` and `~/rest` expand to the home directory; `~user` forms cannot be resolved and give null. */
function expandHome(target) {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));
  if (target.startsWith("~")) return null;
  return target;
}

/** Same rule as `resolveRealTarget` in src/kernel/vault/paths.ts (equivalence test). */
function realTarget(target, cwd) {
  const absolute = path.resolve(cwd, target);
  const missing = [];
  let current = absolute;
  while (true) {
    try { return path.join(realpathSync.native(current), ...missing.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` is `root` itself or below it. */
function atOrUnder(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** True when `target` is strictly below `root`. */
function under(root, target) {
  return target !== root && atOrUnder(root, target);
}

function controlRoot() {
  const textual = path.join(homedir(), ".oms");
  try { return realTarget(textual, process.cwd()); } catch { return textual; }
}

function eventsPath() {
  return path.join(homedir(), ".oms", "guard-events.jsonl");
}

/** Best effort: one `{ts, kind}` line, the file kept near its cap; a symlinked file is refused. Never throws. */
function recordGuardEvent(kind) {
  try {
    const file = eventsPath();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind }) + "\n";
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      if (fstatSync(fd).size >= EVENTS_CAP_BYTES) ftruncateSync(fd, 0);
      writeSync(fd, line);
    } finally { closeSync(fd); }
  } catch {
    // recording is advisory
  }
}

function transportFailure(kind) {
  recordGuardEvent(kind);
  if (TRANSPORT_FAILURE_POLICY === "allow-warn") {
    process.stderr.write("[oms] guard could not reach the judge; write allowed. Run: oms contract doctor\n");
    allow();
  }
}

/** Accepts exactly the allow shape or the deny shape `oms hook pre` prints. */
function validJudgeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "continue,suppressOutput" && value.continue === true && value.suppressOutput === true) return ALLOW;
  if (keys !== "hookSpecificOutput") return null;
  const out = value.hookSpecificOutput;
  if (out === null || typeof out !== "object" || Array.isArray(out)) return null;
  if (Object.keys(out).sort().join(",") !== "hookEventName,permissionDecision,permissionDecisionReason") return null;
  if (out.hookEventName !== "PreToolUse" || out.permissionDecision !== "deny") return null;
  if (typeof out.permissionDecisionReason !== "string" || !out.permissionDecisionReason.startsWith("[oms] write denied: ")) return null;
  return JSON.stringify(value);
}

const GLOB_META = /[*?[\]{}\\,!\s]/;

/**
 * Conservative: false only when `pattern`, searched from `root`, is anchored by concrete
 * leading segments that leave the path to `control`, or when a relative pattern without
 * `..` is searched from a root that is not an ancestor of the store. An absolute or `~`
 * pattern is judged from its own anchor. No pattern, a pattern without a directory
 * segment (it matches at any depth), and any wildcard met before the path diverges all
 * count as able to reach the store.
 */
function searchCanReach(root, control, pattern) {
  if (typeof pattern !== "string" || !pattern) return under(root, control);
  let text = pattern;
  let base = root;
  if (text.startsWith("~")) {
    const expanded = expandHome(text);
    if (expanded === null) return true;
    text = expanded;
  }
  if (path.isAbsolute(text)) {
    base = path.parse(text).root;
    text = text.slice(base.length);
  } else if (!under(base, control) && !text.split(/[\\/]/).includes("..")) {
    return false;
  }
  while (text.startsWith("./")) text = text.slice(2);
  if (!text.replace(/\/+$/, "").includes("/")) return true;
  const segments = text.split("/");
  const toControl = path.relative(base, control).split(path.sep);
  for (let i = 0; i < toControl.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined || segment === "" || segment === "." || segment === ".." || segment.startsWith("~") || GLOB_META.test(segment)) return true;
    if (segment.toLowerCase() !== toControl[i].toLowerCase()) return false;
  }
  return true;
}

function configuredVaults() {
  const vaults = [];
  for (const value of [process.env.OMS_VAULT, process.env.OMS_AGENT_VAULT]) {
    if (!value) continue;
    try { vaults.push(realpathSync.native(value)); } catch { /* not a vault on this machine */ }
  }
  return vaults;
}

/** Vault and control roots both as spelled and as resolved, for textual checks. */
function protectedRoots(control) {
  const roots = [path.join(homedir(), ".oms"), control, ...configuredVaults()];
  for (const value of [process.env.OMS_VAULT, process.env.OMS_AGENT_VAULT]) {
    const expanded = value ? expandHome(value) : null;
    if (expanded) roots.push(path.resolve(expanded));
  }
  return roots;
}

/** An unparseable payload is judged by its text: does it name a vault or the control store? */
function rawNamesProtectedPath(raw, control) {
  const text = raw.replaceAll("\\/", "/");
  return text.includes("~/.oms") || protectedRoots(control).some((root) => text.includes(root));
}

const HOST_CONFIG_FILES = ["settings.json", "settings.local.json"];

/** Claude config directories whose settings files hold this hook's registration. */
function hostConfigDirs() {
  const dirs = [path.join(homedir(), ".claude")];
  for (const value of [process.env.CLAUDE_CONFIG_DIR, process.env.OMS_CLAUDE_HOME]) {
    const expanded = value ? expandHome(value) : null;
    if (expanded) dirs.push(path.resolve(expanded));
  }
  for (const vault of configuredVaults()) dirs.push(path.join(vault, ".claude"));
  return dirs;
}

/** Each settings file as spelled and as resolved; a symlinked file or directory matches its target. */
function hostConfigFiles() {
  const files = [];
  for (const dir of hostConfigDirs()) {
    for (const name of HOST_CONFIG_FILES) {
      const file = path.join(dir, name);
      files.push(file);
      try { files.push(realTarget(file, process.cwd())); } catch { /* the spelled form still counts */ }
    }
  }
  return files;
}

/** Case-insensitive, so a differently cased name on a case-insensitive disk is still caught. */
function isHostConfig(target, files = hostConfigFiles()) {
  const wanted = target.toLowerCase();
  return files.some((file) => file.toLowerCase() === wanted);
}

const PACKAGE_RUNTIME = ["dist", "assets", "node_modules", "package.json"];

/**
 * This guard file and, when resolvable, the runtime parts of the installed oms package
 * (the one holding its entry, and the one `oms` on PATH resolves into).
 */
function guardOwnedRoots() {
  const roots = [];
  const packageRoots = [];
  try {
    const self = realpathSync.native(fileURLToPath(import.meta.url));
    roots.push(self);
    const packageRoot = path.resolve(path.dirname(self), "../../..");
    if (existsSync(path.join(packageRoot, "dist", "cli", "oms.js"))) packageRoots.push(packageRoot);
  } catch {
    // the guard file itself is best effort
  }
  const suffix = path.join("dist", "cli", "oms.js");
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    let entry;
    try { entry = realpathSync.native(path.join(dir, "oms")); } catch { continue; }
    if (entry.endsWith(path.sep + suffix)) packageRoots.push(entry.slice(0, -(suffix.length + 1)));
    break;
  }
  for (const packageRoot of packageRoots) {
    for (const part of PACKAGE_RUNTIME) roots.push(path.join(packageRoot, part));
  }
  return roots;
}

async function main() {
  const { text: raw, truncated } = await readStdin();
  let data;
  try {
    if (truncated) throw new Error("truncated");
    data = JSON.parse(raw);
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
  } catch {
    if (rawNamesProtectedPath(raw, controlRoot())) { deny(INPUT_REASON); return; }
    process.stderr.write("[oms] guard input could not be parsed; write allowed.\n");
    allow();
    return;
  }

  const tool = String(data.tool_name || data.toolName || "").toLowerCase();
  if (!WRITE_TOOLS.has(tool) && !READ_TOOLS.has(tool)) { allow(); return; }

  const input = data.tool_input || data.toolInput || {};
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const searches = tool === "grep" || tool === "glob";
  const named = searches ? input.path : (input.file_path || input.notebook_path || input.path);
  const targetText = typeof named === "string" && named ? named : (searches ? cwd : "");
  if (!targetText) { allow(); return; }

  const expanded = expandHome(targetText);
  if (expanded === null) { deny(UNSAFE_PATH_REASON); return; }
  const control = controlRoot();
  let target;
  try {
    target = realTarget(expanded, cwd);
  } catch {
    const textual = path.resolve(cwd, expanded);
    const exposed = protectedRoots(control).some((root) => atOrUnder(root, textual)) || (searches && under(textual, control))
      || (WRITE_TOOLS.has(tool) && isHostConfig(textual));
    if (exposed) { deny(UNSAFE_PATH_REASON); return; }
    process.stderr.write("[oms] guard could not resolve the target; allowed.\n");
    allow();
    return;
  }
  if (atOrUnder(control, target)) { deny(CONTROL_PATH_REASON); return; }

  if (READ_TOOLS.has(tool)) {
    const pattern = tool === "grep" ? input.glob : input.pattern;
    if (searches && searchCanReach(target, control, pattern)) { deny(SEARCH_REASON); return; }
    allow();
    return;
  }

  if (guardOwnedRoots().some((root) => atOrUnder(root, target))) { deny(CONTROL_PATH_REASON); return; }
  if (isHostConfig(target)) { deny(CONTROL_PATH_REASON); return; }

  const vault = configuredVaults()
    .filter((root) => under(root, target))
    .sort((a, b) => b.length - a.length)[0];
  if (!vault) { allow(); return; }

  const { cmd, prefix } = resolveOmsCommand();
  const result = spawnSync(cmd, [...prefix, "hook", "pre", "--vault", vault], {
    input: raw, encoding: "utf-8", timeout: JUDGE_TIMEOUT_MS,
  });
  // EPIPE only means the judge exited without reading all of stdin; judge it by its exit and output.
  const judgeRan = result.error?.code === "EPIPE" && result.status !== null;
  if (result.error && !judgeRan) {
    transportFailure(result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed");
    return;
  }
  if (result.status !== 0) { transportFailure("exit-nonzero"); return; }
  if (!result.stdout || !result.stdout.trim()) { transportFailure("empty-output"); return; }
  const output = validJudgeOutput(result.stdout.trim());
  if (output === null) { transportFailure("malformed-output"); return; }
  const notices = (result.stderr || "").split("\n").filter((line) => line.startsWith("[oms] "));
  if (notices.length > 0) process.stderr.write(notices.join("\n") + "\n");
  process.stdout.write(output + "\n");
}

main().catch(() => transportFailure("internal"));
