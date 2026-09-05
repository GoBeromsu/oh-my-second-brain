import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

const STUB_CLI = `
import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf-8");
writeFileSync(process.env.OMS_STUB_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }));
if (process.env.OMS_STUB_STDOUT) process.stdout.write(process.env.OMS_STUB_STDOUT);
if (process.env.OMS_STUB_STDERR) process.stderr.write(process.env.OMS_STUB_STDERR);
process.exit(Number(process.env.OMS_STUB_STATUS || "0"));
`;

type HookName = "oms-guard.mjs" | "oms-post-guard.mjs";

interface Fixture {
  capture: string;
  hook(name: HookName): string;
  vault: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "oms-claude-hook-assets-"));
  temporaryDirectories.push(root);
  const hooks = path.join(root, "assets", "claude", "hooks");
  const cli = path.join(root, "dist", "cli");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(cli, { recursive: true });
  for (const name of ["oms-guard.mjs", "oms-post-guard.mjs"] as const) {
    copyFileSync(path.join(REPO_ROOT, "assets", "claude", "hooks", name), path.join(hooks, name));
  }
  writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n', "utf-8");
  writeFileSync(path.join(cli, "oms.js"), STUB_CLI, "utf-8");
  return {
    capture: path.join(root, "capture.json"),
    hook: (name) => path.join(hooks, name),
    vault: path.join(root, "vault"),
  };
}

function runHook(
  target: Fixture,
  hook: HookName,
  input: unknown,
  stub: { stdout?: string; stderr?: string; status?: number } = {},
) {
  return spawnSync(process.execPath, [target.hook(hook)], {
    encoding: "utf-8",
    input: JSON.stringify(input),
    env: {
      ...process.env,
      OMS_VAULT: target.vault,
      OMS_AGENT_VAULT: "",
      OMS_GUARD: "",
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shipped Claude hook assets", () => {
  it("delegates PreToolUse input to the unique hook pre leaf and forwards its result", () => {
    const target = fixture();
    const input = { tool_name: "Write", tool_input: { file_path: path.join(target.vault, "notes", "a.md") } };
    const result = runHook(target, "oms-guard.mjs", input, { stdout: '{"continue":false}\n' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"continue":false}\n');
    expect(captured(target)).toEqual({
      argv: ["hook", "pre", "--vault", target.vault],
      stdin: JSON.stringify(input),
    });
  });

  it("delegates PostToolUse input to the unique hook post leaf and forwards advisory output", () => {
    const target = fixture();
    const input = { toolName: "Edit", toolInput: { path: path.join(target.vault, "notes", "a.md") } };
    const result = runHook(target, "oms-post-guard.mjs", input, {
      stdout: '{"hookSpecificOutput":{"additionalContext":"audit"}}\n',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"hookSpecificOutput":{"additionalContext":"audit"}}\n');
    expect(captured(target)).toEqual({
      argv: ["hook", "post", "--vault", target.vault],
      stdin: JSON.stringify(input),
    });
  });

  it.each(["oms-guard.mjs", "oms-post-guard.mjs"] as const)(
    "%s does not spawn for an unrelated file",
    (hook) => {
      const target = fixture();
      const result = runHook(target, hook, {
        tool_name: "Write",
        tool_input: { file_path: path.join(path.dirname(target.vault), "unrelated", "a.md") },
      });

      expect(result.status).toBe(0);
      expect(existsSync(target.capture)).toBe(false);
    },
  );

  it("keeps the pre hook fail-open response and error forwarding on CLI failure", () => {
    const target = fixture();
    const result = runHook(
      target,
      "oms-guard.mjs",
      { tool_name: "Write", tool_input: { file_path: path.join(target.vault, "a.md") } },
      { stdout: "ignored", stderr: "pre failed\n", status: 7 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"continue":true,"suppressOutput":true}\n');
    expect(result.stderr).toBe("[oms-guard] pre failed\n");
  });

  it("keeps the post hook advisory error handling on CLI failure", () => {
    const target = fixture();
    const result = runHook(
      target,
      "oms-post-guard.mjs",
      { tool_name: "Edit", tool_input: { file_path: path.join(target.vault, "a.md") } },
      { stdout: "ignored", stderr: "post failed\n", status: 8 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("[oms-post-guard] post failed\n");
  });
});
