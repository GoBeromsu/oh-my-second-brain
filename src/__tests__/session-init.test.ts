import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileRules, writeRuleManifest } from "../rules/compiler.js";
import type { OmsbConfig } from "../rules/types.js";

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-session-init-"));
  createdDirs.push(dir);
  return dir;
}

function makeConfig(vaultPath: string, guidelineRoot = "90. Guidelines"): OmsbConfig {
  return {
    version: 1,
    vault_path: vaultPath,
    vault_name: "Vault",
    guidelines: {
      root: guidelineRoot,
      files: ["Folder Guideline.md"],
      required: ["folder"],
      domains: {
        folder: "Folder Guideline.md",
      },
    },
    rules: {
      raw_paths: ["80. References/**"],
    },
    enforcement: {
      raw_boundary: "deny",
      frontmatter: "advisory",
      naming: "advisory",
    },
    routing: {
      inbox_fallback: "Inbox",
    },
  };
}

function writeInitializedVault(vaultPath: string, config: OmsbConfig): void {
  const guidelineDir = path.join(vaultPath, config.guidelines.root);
  fs.mkdirSync(guidelineDir, { recursive: true });
  fs.writeFileSync(
    path.join(guidelineDir, "Folder Guideline.md"),
    "# Folder Guideline\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(vaultPath, "omsb.config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );

  const manifest = compileRules(config, vaultPath);
  writeRuleManifest(manifest, vaultPath);
}

function runSessionInit(cwd: string): unknown {
  const scriptPath = path.resolve(process.cwd(), "scripts/session-init.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    input: "",
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 0, "expected session-init to emit JSON output");
  return JSON.parse(result.stdout);
}

describe("session-init hook", () => {
  it("stays silent when the initialized vault is fresh", () => {
    const vaultPath = makeVault();
    writeInitializedVault(vaultPath, makeConfig(vaultPath));

    const output = runSessionInit(vaultPath) as {
      continue: boolean;
      suppressOutput?: boolean;
    };

    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });

  it("reports added guideline files in the recovery message", () => {
    const vaultPath = makeVault();
    const config = makeConfig(vaultPath);
    writeInitializedVault(vaultPath, config);

    fs.writeFileSync(
      path.join(vaultPath, config.guidelines.root, "Frontmatter Guideline.md"),
      "# Frontmatter Guideline\n",
      "utf-8",
    );

    const output = runSessionInit(vaultPath) as {
      hookSpecificOutput: { additionalContext: string };
    };

    assert.match(output.hookSpecificOutput.additionalContext, /added guideline files/i);
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Frontmatter Guideline\.md/,
    );
  });

  it("reports renamed guideline files as removed or missing tracked sources", () => {
    const vaultPath = makeVault();
    const config = makeConfig(vaultPath);
    writeInitializedVault(vaultPath, config);

    fs.renameSync(
      path.join(vaultPath, config.guidelines.root, "Folder Guideline.md"),
      path.join(vaultPath, config.guidelines.root, "Folder Rules.md"),
    );

    const output = runSessionInit(vaultPath) as {
      hookSpecificOutput: { additionalContext: string };
    };

    assert.match(output.hookSpecificOutput.additionalContext, /missing tracked sources/i);
    assert.match(output.hookSpecificOutput.additionalContext, /removed or renamed guideline files/i);
    assert.match(output.hookSpecificOutput.additionalContext, /Folder Guideline\.md/);
  });

  it("reports a missing guideline folder and suggests likely candidates", () => {
    const vaultPath = makeVault();
    const config = makeConfig(vaultPath, "90. Guidelines");
    writeInitializedVault(vaultPath, config);

    fs.renameSync(
      path.join(vaultPath, "90. Guidelines"),
      path.join(vaultPath, "91. Guidelines"),
    );

    const output = runSessionInit(vaultPath) as {
      hookSpecificOutput: { additionalContext: string };
    };

    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Configured guideline folder is missing or unreadable/i,
    );
    assert.match(output.hookSpecificOutput.additionalContext, /Likely guideline folders: 91\. Guidelines/i);
  });
});
