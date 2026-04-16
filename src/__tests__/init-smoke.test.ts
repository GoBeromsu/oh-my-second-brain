import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, findConfig } from "../config/loader.js";
import {
  generateClaudeMd,
  generateConfig,
  generateRules,
} from "../init/generator.js";
import { readRuleManifest } from "../rules/compiler.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-init-smoke-"));
  tempDirs.push(dir);
  return dir;
}

describe("OMSB init smoke flow", () => {
  it("generates config, rules, and CLAUDE artifacts that can be rediscovered from a nested vault path", async () => {
    const vaultPath = makeVault();
    const guidelineRoot = path.join(vaultPath, "Guidelines");
    fs.mkdirSync(guidelineRoot, { recursive: true });
    fs.writeFileSync(
      path.join(guidelineRoot, "Folder Guideline.md"),
      [
        "# Folder Guideline",
        "",
        '<!-- omsb: rule-type="naming-convention" severity="deny" pattern="^[a-zA-Z0-9 ()-]+$" -->',
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(guidelineRoot, "Frontmatter Guideline.md"),
      "# Frontmatter Guideline\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(vaultPath, "nested", "deep"), { recursive: true });

    await generateConfig({
      vaultPath,
      vaultName: "Smoke Vault",
      guidelineRoot: "Guidelines",
      guidelineFiles: ["Folder Guideline.md", "Frontmatter Guideline.md"],
      guidelineRequirements: ["folder", "frontmatter"],
      rawPaths: ["80. References/**"],
      frontmatterRequired: ["title", "type"],
      inboxFallback: "Inbox",
      managedPlugins: [{ id: "calendar" }],
    });

    const configPath = findConfig(path.join(vaultPath, "nested", "deep"));
    assert.equal(configPath, path.join(vaultPath, "omsb.config.json"));

    const loaded = loadConfig(configPath!);
    assert.equal(loaded.vault_name, "Smoke Vault");
    assert.equal(loaded.governance?.runtime_enforcement.docs_are_runtime_authority, false);
    assert.deepEqual(loaded.guidelines.required, ["folder", "frontmatter"]);

    await generateRules(vaultPath);
    const manifest = readRuleManifest(vaultPath);
    assert.ok(manifest);
    assert.equal(manifest?.source_snapshot.guidelines_root, guidelineRoot);
    assert.equal(
      manifest?.governance?.runtime_enforcement.rules_manifest,
      "generated-runtime-artifact",
    );
    assert.ok(
      manifest?.rules.some(
        (rule) => rule.type === "frontmatter-required" && rule.config["field"] === "title",
      ),
    );
    assert.ok(
      manifest?.rules.some(
        (rule) => rule.type === "naming-convention" && rule.source.tier === 2,
      ),
    );

    await generateClaudeMd(vaultPath, "Guidelines", loaded.guidelines.files, manifest);
    await generateClaudeMd(vaultPath, "Guidelines", loaded.guidelines.files, manifest);

    const omsbClaude = fs.readFileSync(path.join(vaultPath, ".omsb", "CLAUDE.md"), "utf-8");
    const rootClaude = fs.readFileSync(path.join(vaultPath, ".claude", "CLAUDE.md"), "utf-8");

    assert.match(omsbClaude, /## Runtime Source Hierarchy/);
    assert.match(
      omsbClaude,
      /Human guideline docs in the configured guideline folder are authoritative/,
    );
    assert.match(omsbClaude, /@Guidelines\/Folder Guideline\.md/);
    assert.match(omsbClaude, /@Guidelines\/Frontmatter Guideline\.md/);
    assert.equal(
      rootClaude.match(/@file \.omsb\/CLAUDE\.md/g)?.length,
      1,
      "expected exactly one OMSB CLAUDE reference in .claude/CLAUDE.md",
    );
  });
});
