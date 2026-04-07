import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { compileRules, writeRuleManifest, readRuleManifest } from "../rules/compiler.js";
import type { OmsbConfig } from "../rules/types.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-compiler-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(vaultPath: string, guidelineFiles: string[] = []): OmsbConfig {
  return {
    version: 1,
    vault_path: vaultPath,
    vault_name: "TestVault",
    guidelines: { root: "", files: guidelineFiles },
    rules: {
      raw_paths: ["raw/**"],
      frontmatter_required: ["title"],
    },
    enforcement: { raw_boundary: "block", frontmatter: "deny", naming: "advisory" },
  };
}

describe("compileRules", () => {
  it("merges T1 and T2 rules into a single manifest", () => {
    const guideFile = "rules.md";
    fs.writeFileSync(
      path.join(tmpDir, guideFile),
      `<!-- omsb: rule-type="naming-convention" severity="advisory" pattern="^[a-z]" -->`,
      "utf-8"
    );
    const config = makeConfig(tmpDir, [guideFile]);
    const manifest = compileRules(config, tmpDir);

    const t1 = manifest.rules.filter((r) => r.source.tier === 1);
    const t2 = manifest.rules.filter((r) => r.source.tier === 2);
    assert.ok(t1.length >= 1, "should have at least 1 T1 rule");
    assert.equal(t2.length, 1);
    assert.equal(manifest.rules.length, t1.length + t2.length);
  });

  it("manifest has correct version and generated_at", () => {
    const config = makeConfig(tmpDir);
    const manifest = compileRules(config, tmpDir);
    assert.equal(manifest.version, 1);
    assert.ok(typeof manifest.generated_at === "string");
    assert.ok(manifest.generated_at.length > 0);
    // generated_at should parse as a valid ISO date
    assert.ok(!isNaN(Date.parse(manifest.generated_at)));
  });

  it("manifest has source_mtimes for config file", () => {
    const config = makeConfig(tmpDir);
    const manifest = compileRules(config, tmpDir);
    const configPath = path.join(tmpDir, "omsb.config.json");
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.source_mtimes, configPath));
  });

  it("produces path-boundary rules from raw_paths", () => {
    const config = makeConfig(tmpDir);
    const manifest = compileRules(config, tmpDir);
    const pathRules = manifest.rules.filter((r) => r.type === "path-boundary");
    assert.equal(pathRules.length, 1);
    assert.equal(pathRules[0].config["path"], "raw/**");
  });
});

describe("writeRuleManifest + readRuleManifest", () => {
  it("round-trips a manifest to disk and back", () => {
    const config = makeConfig(tmpDir);
    const manifest = compileRules(config, tmpDir);

    writeRuleManifest(manifest, tmpDir);

    const rulesPath = path.join(tmpDir, ".omsb", "rules.json");
    assert.ok(fs.existsSync(rulesPath));

    const read = readRuleManifest(tmpDir);
    assert.ok(read !== null);
    assert.equal(read.version, 1);
    assert.equal(read.rules.length, manifest.rules.length);
  });

  it("readRuleManifest returns null for a missing file", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-empty-"));
    try {
      const result = readRuleManifest(emptyDir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("readRuleManifest returns null for malformed JSON", () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-bad-"));
    try {
      const omsbDir = path.join(badDir, ".omsb");
      fs.mkdirSync(omsbDir);
      fs.writeFileSync(path.join(omsbDir, "rules.json"), "{ not valid json", "utf-8");
      const result = readRuleManifest(badDir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("createsDotOmsbDir when it does not exist", () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-fresh-"));
    try {
      const config = makeConfig(freshDir);
      const manifest = compileRules(config, freshDir);
      writeRuleManifest(manifest, freshDir);
      assert.ok(fs.existsSync(path.join(freshDir, ".omsb", "rules.json")));
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("preserved rule IDs are stable across write/read cycle", () => {
    const config = makeConfig(tmpDir);
    const manifest = compileRules(config, tmpDir);
    writeRuleManifest(manifest, tmpDir);
    const read = readRuleManifest(tmpDir);
    assert.ok(read !== null);
    const originalIds = manifest.rules.map((r) => r.id).sort();
    const readIds = read.rules.map((r) => r.id).sort();
    assert.deepEqual(readIds, originalIds);
  });
});
