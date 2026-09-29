import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatWarnings, GUIDANCE } from "../../../src/kernel/contract/types.js";
import { buildTruthTableRow, type TruthTableFixture } from "../../fixtures/contract-truth-table.js";
import { absolute } from "../../architecture/repo-root.js";

/**
 * The real Claude guard, spawned as Claude Code spawns it, against a sealed vault in an
 * isolated HOME. A refusal is denied and a contract violation is allowed with warnings
 * through the built `oms hook pre`, every command a deny can name reaches a live 0.19 handler, and a judge that cannot be reached allows
 * the write with one warning.
 */

const GUARD = absolute("assets/claude/hooks/oms-guard.mjs");
const DIST_CLI = absolute("dist/cli/oms.js");
const ALLOW = '{"continue":true,"suppressOutput":true}\n';
const PROBE_FLAG = "--oms-guard-probe";

let fixture: TruthTableFixture;
let home = "";
const scratch: string[] = [];

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OMS_") || key.startsWith("XDG_") || key === "HOME" || key === "USERPROFILE" || key === "CLAUDE_CONFIG_DIR") continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    OMS_UPDATE_NOTICE: "0",
    OMS_NO_UPDATE_NOTICE: "1",
    OMS_NON_INTERACTIVE: "1",
    OMS_VAULT: fixture.vault,
    ...extra,
  };
}

function runGuard(guard: string, payload: unknown, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [guard], { encoding: "utf8", input: JSON.stringify(payload), env: isolatedEnv(extra), cwd: fixture.vault });
}

function writePayload(note: string, content: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(fixture.vault, note), content }, cwd: fixture.vault };
}

function guardEvents(): Array<{ kind: string }> {
  const file = path.join(home, ".oms", "guard-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
}

/** Every `oms ...` spelling a deny or a transport warning can print: the kernel guidance list and the guard's own literals. */
function guidanceCommands(): string[] {
  const guardText = readFileSync(GUARD, "utf8");
  const literals = [...guardText.matchAll(/Run: (oms [a-z -]+?)(?=[`"\\.]|\\n)/gu)].map((match) => match[1]!.trim());
  return [...new Set([...GUIDANCE, ...literals])].sort();
}

beforeAll(async () => {
  if (!existsSync(DIST_CLI)) throw new Error("dist/cli/oms.js is missing; run npm run build before the guard deny gate.");
  fixture = await buildTruthTableRow("sealed");
  home = path.join(fixture.base, "home");
});

afterAll(async () => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  await fixture.cleanup();
});

describe("real oms-guard.mjs over the built CLI", () => {
  it("denies a write to the vault's control path and leaves the vault untouched", () => {
    const before = readdirSync(path.join(fixture.vault, ".oms")).sort();
    const result = runGuard(GUARD, writePayload(".oms/stray.md", "# stray\n"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: '[oms] write denied: [{"field":"path","kind":"control-path"}] Run: oms doctor status',
      },
    });
    expect(readdirSync(path.join(fixture.vault, ".oms")).sort()).toEqual(before);
    expect(guardEvents()).toEqual([]);
  });

  it("forwards a sealed-contract violation as an allow with warnings", () => {
    const message = formatWarnings([{ field: "path", kind: "unregistered-folder" }]);
    const result = runGuard(GUARD, writePayload("Loose/stray.md", "# stray\n"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } });
    expect(result.stdout).not.toContain("permissionDecision");
    expect(guardEvents()).toEqual([]);
  });

  it("allows a write the sealed contract accepts", () => {
    const result = runGuard(GUARD, writePayload("Projects/ok.md", "# ok\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALLOW);
    expect(guardEvents()).toEqual([]);
  });

  it("names only commands the 0.19 CLI dispatches", () => {
    const commands = guidanceCommands();
    expect(commands).toContain("oms doctor status");
    expect(commands).toContain("oms setup host sync");
    for (const command of commands) {
      const argv = command.split(" ").slice(1);
      const result = spawnSync(process.execPath, [DIST_CLI, ...argv, PROBE_FLAG], { encoding: "utf8", input: "", env: isolatedEnv(), cwd: fixture.base });
      const output = `${result.stdout}\n${result.stderr}`;
      // The owning handler rejects the probe flag by name, so the spelling reached it and ran nothing.
      expect(result.status, command).toBe(1);
      expect(output, command).toContain(PROBE_FLAG);
      expect(output, command).not.toMatch(/Unknown command|Unknown doctor leaf|was removed in 0\.19|is retired/u);
    }
  });

  it("allows with one warning and records spawn-failed when the judge cannot be reached", () => {
    // A copy with no co-located dist falls back to `oms` on PATH, and PATH holds nothing.
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-guard-transport-")));
    scratch.push(root);
    const hooks = path.join(root, "assets", "claude", "hooks");
    const emptyBin = path.join(root, "bin");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(emptyBin);
    writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n');
    const guard = path.join(hooks, "oms-guard.mjs");
    copyFileSync(GUARD, guard);
    const before = readdirSync(fixture.vault).sort();

    const result = runGuard(guard, writePayload("Loose/unreached.md", "# x\n"), { PATH: emptyBin });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALLOW);
    expect(result.stderr).toBe("[oms] guard could not reach the judge; write allowed. Run: oms doctor contract\n");
    expect(guardEvents().map((event) => event.kind)).toEqual(["spawn-failed"]);
    expect(readdirSync(fixture.vault).sort()).toEqual(before);
  });
});
