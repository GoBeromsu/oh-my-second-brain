import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractTier1Rules } from "../rules/tier1-extractor.js";
import type { OmsbConfig } from "../rules/types.js";

function baseConfig(overrides: Partial<OmsbConfig["rules"]> = {}): OmsbConfig {
  return {
    version: 1,
    vault_path: "/vault",
    vault_name: "TestVault",
    guidelines: { root: "guidelines", files: [] },
    rules: { raw_paths: [], ...overrides },
    enforcement: { raw_boundary: "block", frontmatter: "deny", naming: "advisory" },
  };
}

describe("extractTier1Rules", () => {
  it("returns empty array when rules are empty", () => {
    const rules = extractTier1Rules(baseConfig());
    assert.equal(rules.length, 0);
  });

  it("produces path-boundary rules from raw_paths", () => {
    const config = baseConfig({ raw_paths: ["raw/**", "inbox/**"] });
    const rules = extractTier1Rules(config);
    const pathRules = rules.filter((r) => r.type === "path-boundary");
    assert.equal(pathRules.length, 2);
    assert.equal(pathRules[0].config["path"], "raw/**");
    assert.equal(pathRules[1].config["path"], "inbox/**");
  });

  it("path-boundary rules use enforcement.raw_boundary severity", () => {
    const config = baseConfig({ raw_paths: ["raw/**"] });
    const rules = extractTier1Rules(config);
    assert.equal(rules[0].severity, "block");
  });

  it("all rules have source.tier === 1", () => {
    const config = baseConfig({
      raw_paths: ["raw/**"],
      frontmatter_required: ["title"],
      naming_conventions: { notes: { pattern: "^[a-z]" } },
    });
    const rules = extractTier1Rules(config);
    for (const rule of rules) {
      assert.equal(rule.source.tier, 1);
    }
  });

  it("produces frontmatter-required rules", () => {
    const config = baseConfig({ raw_paths: [], frontmatter_required: ["title", "tags"] });
    const rules = extractTier1Rules(config);
    const fmRules = rules.filter((r) => r.type === "frontmatter-required");
    assert.equal(fmRules.length, 2);
    assert.equal(fmRules[0].config["field"], "title");
    assert.equal(fmRules[1].config["field"], "tags");
  });

  it("frontmatter-required rules use enforcement.frontmatter severity", () => {
    const config = baseConfig({ raw_paths: [], frontmatter_required: ["title"] });
    const rules = extractTier1Rules(config);
    assert.equal(rules[0].severity, "deny");
  });

  it("produces frontmatter-value rules", () => {
    const config = baseConfig({
      raw_paths: [],
      frontmatter_values: {
        type: { enum: ["note", "article"] },
        status: { enum: ["draft", "done"] },
      },
    });
    const rules = extractTier1Rules(config);
    const fvRules = rules.filter((r) => r.type === "frontmatter-value");
    assert.equal(fvRules.length, 2);
    const typeRule = fvRules.find((r) => r.config["field"] === "type");
    assert.ok(typeRule);
    assert.deepEqual(typeRule.config["enum"], ["note", "article"]);
  });

  it("produces naming-convention rules", () => {
    const config = baseConfig({
      raw_paths: [],
      naming_conventions: {
        notes: { pattern: "^[a-z][a-z0-9-]+$" },
      },
    });
    const rules = extractTier1Rules(config);
    const namingRules = rules.filter((r) => r.type === "naming-convention");
    assert.equal(namingRules.length, 1);
    assert.equal(namingRules[0].config["key"], "notes");
    assert.equal(namingRules[0].config["pattern"], "^[a-z][a-z0-9-]+$");
  });

  it("naming-convention rules use enforcement.naming severity", () => {
    const config = baseConfig({
      raw_paths: [],
      naming_conventions: { notes: { pattern: ".*" } },
    });
    const rules = extractTier1Rules(config);
    assert.equal(rules[0].severity, "advisory");
  });

  it("generates a path-boundary-exception rule when raw_path_exceptions present", () => {
    const config = baseConfig({
      raw_paths: ["raw/**"],
      raw_path_exceptions: { allowed_fields: ["tags"], allowed_ops: ["read"] },
    });
    const rules = extractTier1Rules(config);
    const excRule = rules.find((r) => r.type === "path-boundary-exception");
    assert.ok(excRule);
    assert.deepEqual(excRule.config["allowed_fields"], ["tags"]);
    assert.deepEqual(excRule.config["allowed_ops"], ["read"]);
  });

  it("rule IDs are unique strings", () => {
    const config = baseConfig({
      raw_paths: ["raw/**", "inbox/**"],
      frontmatter_required: ["title"],
    });
    const rules = extractTier1Rules(config);
    const ids = rules.map((r) => r.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length);
  });

  it("source.file is omsb.config.json for all T1 rules", () => {
    const config = baseConfig({ raw_paths: ["raw/**"] });
    const rules = extractTier1Rules(config);
    for (const rule of rules) {
      assert.equal(rule.source.file, "omsb.config.json");
    }
  });
});
