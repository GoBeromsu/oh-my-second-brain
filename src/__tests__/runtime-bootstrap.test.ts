import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runtime bootstrap scripts", () => {
  it("plugin-setup patches hook commands to the absolute node path", () => {
    const root = makeTempDir("omsb-plugin-setup-");
    const scriptsDir = path.join(root, "scripts");
    const hooksDir = path.join(root, "hooks");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });

    const source = fs.readFileSync(path.join(process.cwd(), "scripts", "plugin-setup.mjs"), "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "plugin-setup.mjs"), source, "utf-8");
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Write|Edit|Bash",
                hooks: [
                  { type: "command", command: 'node "$CLAUDE_PLUGIN_ROOT/scripts/run.cjs" "$CLAUDE_PLUGIN_ROOT/scripts/guideline-enforcer.mjs"' },
                  { type: "command", command: '"\/old\/node" "$CLAUDE_PLUGIN_ROOT/scripts/run.cjs" "$CLAUDE_PLUGIN_ROOT/scripts/authorship-marker.mjs"' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const result = spawnSync(process.execPath, [path.join(scriptsDir, "plugin-setup.mjs")], {
      cwd: root,
      encoding: "utf-8",
    });

    assert.equal(result.status, 0, result.stderr);
    const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, "hooks.json"), "utf-8"));
    const commands = hooks.hooks.PreToolUse[0].hooks.map((hook: { command: string }) => hook.command);
    for (const command of commands) {
      assert.match(command, new RegExp(`^"${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    }
  });

  it("run.cjs resolves a stale CLAUDE_PLUGIN_ROOT target to the latest cache version", () => {
    const root = makeTempDir("omsb-runner-");
    const scriptsDir = path.join(root, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts", "run.cjs"), path.join(scriptsDir, "run.cjs"));

    const cacheBase = path.join(root, "plugin-cache");
    const oldVersion = path.join(cacheBase, "1.0.0");
    const newVersion = path.join(cacheBase, "1.2.0");
    fs.mkdirSync(path.join(oldVersion, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(newVersion, "scripts"), { recursive: true });

    const hookScript = path.join(newVersion, "scripts", "echo-hook.mjs");
    fs.writeFileSync(
      hookScript,
      [
        "import * as fs from 'node:fs';",
        "const out = process.argv[2];",
        "fs.writeFileSync(out, 'resolved-latest-version', 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const outputFile = path.join(root, "hook-output.txt");
    const staleTarget = path.join(oldVersion, "scripts", "echo-hook.mjs");

    const result = spawnSync(
      process.execPath,
      [path.join(scriptsDir, "run.cjs"), staleTarget, outputFile],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: oldVersion,
        },
        encoding: "utf-8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(outputFile, "utf-8"), "resolved-latest-version");
  });
});
