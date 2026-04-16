import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateConfig, generateRules } from "../init/generator.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-hook-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function runHook(scriptName: string, cwd: string, payload: unknown): unknown {
  const scriptPath = path.resolve(process.cwd(), "scripts", scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0, `expected output from ${scriptName}`);
  return JSON.parse(result.stdout);
}

async function writeInitializedVault(vaultPath: string): Promise<void> {
  const guidelineRoot = path.join(vaultPath, "Guidelines");
  fs.mkdirSync(guidelineRoot, { recursive: true });
  fs.writeFileSync(path.join(guidelineRoot, "Folder Guideline.md"), "# Folder\n", "utf-8");
  fs.writeFileSync(
    path.join(guidelineRoot, "Frontmatter Guideline.md"),
    "# Frontmatter\n",
    "utf-8",
  );

  await generateConfig({
    vaultPath,
    vaultName: "Hook Smoke Vault",
    guidelineRoot: "Guidelines",
    guidelineFiles: ["Folder Guideline.md", "Frontmatter Guideline.md"],
    guidelineRequirements: ["folder", "frontmatter"],
    rawPaths: ["80. References/**"],
    frontmatterRequired: ["title"],
    inboxFallback: "Inbox",
    managedPlugins: [{ id: "calendar" }],
  });

  const configPath = path.join(vaultPath, "omsb.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  config.authorship = {
    enabled: true,
    agent_name: "claude",
    created_by_field: "created_by",
    modified_by_field: "modified_by",
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  await generateRules(vaultPath);
}

describe("hook smoke flows", () => {
  it("guideline-enforcer denies writes into protected raw paths", async () => {
    const vaultPath = makeVault();
    await writeInitializedVault(vaultPath);
    const target = path.join(vaultPath, "80. References", "source-note.md");

    const output = runHook("guideline-enforcer.mjs", vaultPath, {
      tool_name: "Write",
      tool_input: {
        file_path: target,
        content: "# source note\n",
      },
    }) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      systemMessage: string;
    };

    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /write to protected path/i);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /raw boundary pattern/i);
    assert.match(output.systemMessage, /protected/i);
  });

  it("guideline-enforcer emits recovery guidance when the rules snapshot is stale", async () => {
    const vaultPath = makeVault();
    await writeInitializedVault(vaultPath);
    fs.writeFileSync(
      path.join(vaultPath, "Guidelines", "Folder Guideline.md"),
      "# Folder\nupdated\n",
      "utf-8",
    );

    const output = runHook("guideline-enforcer.mjs", vaultPath, {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(vaultPath, "Notes", "fresh.md"),
        content: "---\ntitle: Fresh\n---\nBody\n",
      },
    }) as {
      continue: boolean;
      hookSpecificOutput: { additionalContext: string };
    };

    assert.equal(output.continue, true);
    assert.match(output.hookSpecificOutput.additionalContext, /enforcement is inactive/i);
    assert.match(output.hookSpecificOutput.additionalContext, /\/omsb init/i);
  });

  it("authorship-marker adds created_by for non-raw markdown files", async () => {
    const vaultPath = makeVault();
    await writeInitializedVault(vaultPath);

    const notesDir = path.join(vaultPath, "Notes");
    fs.mkdirSync(notesDir, { recursive: true });
    const filePath = path.join(notesDir, "idea.md");
    fs.writeFileSync(filePath, "# Idea\n", "utf-8");

    const output = runHook("authorship-marker.mjs", vaultPath, {
      tool_name: "Write",
      tool_input: {
        file_path: filePath,
      },
    }) as {
      continue: boolean;
      suppressOutput: boolean;
    };

    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);

    const content = fs.readFileSync(filePath, "utf-8");
    assert.match(content, /^---\ncreated_by: "\[\[claude\]\]"\n---\n# Idea/s);
  });
});
