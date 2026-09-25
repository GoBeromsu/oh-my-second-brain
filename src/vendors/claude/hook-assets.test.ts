import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRealTarget } from "../../kernel/vault/paths.js";
import { HOOK_MATCHER, READ_MATCHER } from "./claude-hooks.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GUARD_SOURCE = path.join(REPO_ROOT, "assets", "claude", "hooks", "oms-guard.mjs");
const ALLOW = '{"continue":true,"suppressOutput":true}\n';
const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: '[oms] write denied: [{"field":"status","kind":"not-allowed"}] Run: oms contract doctor' } });
const temporaryDirectories: string[] = [];

const STUB_CLI = `
import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf-8");
writeFileSync(process.env.OMS_STUB_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }));
if (process.env.OMS_STUB_STDOUT) process.stdout.write(process.env.OMS_STUB_STDOUT);
if (process.env.OMS_STUB_STDERR) process.stderr.write(process.env.OMS_STUB_STDERR);
process.exit(Number(process.env.OMS_STUB_STATUS || "0"));
`;

interface Fixture {
  root: string;
  home: string;
  capture: string;
  hook: string;
  vault: string;
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(dir);
  return dir;
}

function fixture(): Fixture {
  const root = tempDir("oms-claude-hook-assets-");
  const hooks = path.join(root, "assets", "claude", "hooks");
  const cli = path.join(root, "dist", "cli");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(cli, { recursive: true });
  copyFileSync(GUARD_SOURCE, path.join(hooks, "oms-guard.mjs"));
  writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n', "utf-8");
  writeFileSync(path.join(cli, "oms.js"), STUB_CLI, "utf-8");
  const vault = path.join(root, "vault");
  const home = path.join(root, "home");
  mkdirSync(vault, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, capture: path.join(root, "capture.json"), hook: path.join(hooks, "oms-guard.mjs"), vault };
}

function runHook(target: Fixture, input: unknown, stub: { stdout?: string; stderr?: string; status?: number } = {}) {
  return spawnSync(process.execPath, [target.hook], {
    encoding: "utf-8",
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: {
      ...process.env,
      HOME: target.home,
      OMS_VAULT: target.vault,
      OMS_AGENT_VAULT: "",
      OMS_STUB_CAPTURE: target.capture,
      OMS_STUB_STDOUT: stub.stdout ?? "",
      OMS_STUB_STDERR: stub.stderr ?? "",
      OMS_STUB_STATUS: String(stub.status ?? 0),
    },
  });
}

function captured(target: Fixture): { argv: string[]; stdin: string } {
  return JSON.parse(readFileSync(target.capture, "utf-8")) as { argv: string[]; stdin: string };
}

function guardEvents(target: Fixture): Array<{ ts: string; kind: string }> {
  const file = path.join(target.home, ".oms", "guard-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").map(line => JSON.parse(line) as { ts: string; kind: string });
}

function writePayload(target: Fixture, note = "a.md") {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(target.vault, note), content: "x" } };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("oms-guard.mjs routing", () => {
  it("routes a vault write to `oms hook pre --vault` with the raw payload and forwards the allow shape", () => {
    const target = fixture();
    const payload = writePayload(target);
    const result = runHook(target, payload, { stdout: ALLOW });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALLOW);
    expect(captured(target)).toEqual({ argv: ["hook", "pre", "--vault", target.vault], stdin: JSON.stringify(payload) });
    expect(guardEvents(target)).toEqual([]);
  });

  it("forwards the judge's deny shape unchanged", () => {
    const target = fixture();
    const result = runHook(target, writePayload(target), { stdout: `${DENY}\n` });
    expect(result.stdout).toBe(`${DENY}\n`);
    expect(Object.hasOwn(JSON.parse(result.stdout) as object, "continue")).toBe(false);
  });

  it("does not spawn for writes outside every configured vault or for other tools", () => {
    const target = fixture();
    const outside = runHook(target, { tool_name: "Write", tool_input: { file_path: path.join(target.root, "elsewhere.md"), content: "x" } });
    const other = runHook(target, { tool_name: "Bash", tool_input: { command: "ls" } });
    expect([outside.stdout, other.stdout]).toEqual([ALLOW, ALLOW]);
    expect(existsSync(target.capture)).toBe(false);
  });

  it("denies control paths without spawning", () => {
    const target = fixture();
    const result = runHook(target, { tool_name: "Read", tool_input: { file_path: path.join(target.home, ".oms", "vaults", "x", "folders.json") } });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: '[oms] write denied: [{"field":"path","kind":"control-path"}] Run: oms status' },
    });
    expect(existsSync(target.capture)).toBe(false);
  });
});

describe("oms-guard.mjs transport failures", () => {
  const cases: Array<[string, { stdout?: string; status?: number }, string]> = [
    ["a non-zero exit", { stdout: ALLOW, status: 7 }, "exit-nonzero"],
    ["empty output", {}, "empty-output"],
    ["output that is not JSON", { stdout: "nope" }, "malformed-output"],
    ["JSON that is neither the allow nor the deny shape", { stdout: '{"continue":true}' }, "malformed-output"],
    ["a deny with an extra continue key", { stdout: JSON.stringify({ continue: true, ...JSON.parse(DENY) as object }) }, "malformed-output"],
  ];
  for (const [label, stub, kind] of cases) {
    it(`allows with one warning and one guard event on ${label}`, () => {
      const target = fixture();
      const result = runHook(target, writePayload(target), stub);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(ALLOW);
      expect(result.stderr).toBe("[oms] guard could not reach the judge; write allowed. Run: oms contract doctor\n");
      const events = guardEvents(target);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe(kind);
      expect(Object.keys(events[0] ?? {}).sort()).toEqual(["kind", "ts"]);
    });
  }

  it("writes the guard-event log owner-only and never through a symlink", () => {
    const target = fixture();
    const decoy = path.join(target.root, "decoy.txt");
    writeFileSync(decoy, "", { mode: 0o644 });
    mkdirSync(path.join(target.home, ".oms"), { recursive: true });
    symlinkSync(decoy, path.join(target.home, ".oms", "guard-events.jsonl"));
    const result = runHook(target, writePayload(target), { status: 7, stdout: ALLOW });
    expect(result.stdout).toBe(ALLOW);
    expect(readFileSync(decoy, "utf-8")).toBe("");

    const fresh = fixture();
    runHook(fresh, writePayload(fresh), { status: 7, stdout: ALLOW });
    expect(statSync(path.join(fresh.home, ".oms", "guard-events.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("forwards only the judge's [oms] stderr lines", () => {
    const target = fixture();
    const result = runHook(target, writePayload(target), { stdout: ALLOW, stderr: `internal ${target.vault}\n[oms] note\nstack at x\n` });
    expect(result.stdout).toBe(ALLOW);
    expect(result.stderr).toBe("[oms] note\n");
  });

  it("allows unparseable input with one warning and no spawn", () => {
    const target = fixture();
    const result = runHook(target, "{not json");
    expect(result.stdout).toBe(ALLOW);
    expect(result.stderr).toMatch(/^\[oms\] .*\n$/);
    expect(existsSync(target.capture)).toBe(false);
  });

  it("ignores the retired guard environment switch", () => {
    const target = fixture();
    const result = spawnSync(process.execPath, [target.hook], {
      encoding: "utf-8",
      input: JSON.stringify(writePayload(target)),
      env: { ...process.env, HOME: target.home, OMS_VAULT: target.vault, OMS_AGENT_VAULT: "", [["OMS", "GUARD"].join("_")]: "0", OMS_STUB_CAPTURE: target.capture, OMS_STUB_STDOUT: DENY },
    });
    expect(result.stdout).toBe(`${DENY}\n`);
  });
});

describe("oms-guard.mjs parity with the kernel", () => {
  const source = readFileSync(GUARD_SOURCE, "utf-8");

  function toolSet(name: string): string[] {
    const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
    if (!match?.[1]) throw new Error(`${name} not found in oms-guard.mjs`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1] ?? "").sort();
  }

  it("routes exactly the tools the installed matchers name", () => {
    expect(toolSet("WRITE_TOOLS")).toEqual(HOOK_MATCHER.toLowerCase().split("|").sort());
    expect(toolSet("READ_TOOLS")).toEqual(READ_MATCHER.toLowerCase().split("|").sort());
  });

  it("resolves real targets the same way as resolveRealTarget", async () => {
    const match = /function realTarget\(target, cwd\) \{\n([\s\S]*?)\n\}\n/.exec(source);
    if (!match?.[1]) throw new Error("realTarget not found in oms-guard.mjs");
    const realTarget = new Function("path", "realpathSync", "target", "cwd", match[1]) as
      (p: typeof path, r: typeof realpathSync, target: string, cwd: string) => string;
    const base = tempDir("oms-guard-realpath-");
    mkdirSync(path.join(base, "real", "dir"), { recursive: true });
    writeFileSync(path.join(base, "real", "dir", "note.md"), "x");
    symlinkSync(path.join(base, "real"), path.join(base, "alias"));
    const cases = [
      path.join(base, "real", "dir", "note.md"),
      path.join(base, "alias", "dir", "note.md"),
      path.join(base, "alias", "missing", "deeper", "n.md"),
      "alias/dir/../dir/new.md",
      "../outside.md",
      path.join(base, "nothing-here"),
    ];
    for (const candidate of cases) {
      expect(realTarget(path, realpathSync, candidate, base)).toBe(await resolveRealTarget(candidate, base));
    }
  });
});
