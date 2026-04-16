import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatRuleSummary, generateConfig } from "../init/generator.js";
import type { EnforcementRule } from "../rules/types.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-generator-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRule(
  overrides: Partial<EnforcementRule> & Pick<EnforcementRule, "type" | "config">
): EnforcementRule {
  return {
    id: overrides.id ?? "test-rule",
    type: overrides.type,
    severity: overrides.severity ?? "deny",
    config: overrides.config,
    source: overrides.source ?? { file: "omsb.config.json", tier: 1 },
  };
}

describe("formatRuleSummary", () => {
  it("formats path-boundary rule", () => {
    const rule = makeRule({
      id: "raw-boundary",
      type: "path-boundary",
      severity: "block",
      config: { path: "80. References/**" },
    });
    const result = formatRuleSummary(rule);
    assert.equal(result, "- [BLOCK] raw-boundary: 80. References/** is read-only");
  });

  it("formats path-boundary-exception rule", () => {
    const rule = makeRule({
      id: "raw-exception",
      type: "path-boundary-exception",
      severity: "deny",
      config: { allowed_fields: ["status", "tags"], allowed_ops: ["frontmatter"] },
    });
    const result = formatRuleSummary(rule);
    assert.match(result, /\[DENY\]/);
    assert.match(result, /allowed fields: status, tags/);
    assert.match(result, /allowed ops: frontmatter/);
  });

  it("formats path-boundary-exception with empty arrays", () => {
    const rule = makeRule({
      type: "path-boundary-exception",
      config: { allowed_fields: [], allowed_ops: [] },
    });
    const result = formatRuleSummary(rule);
    assert.ok(result.includes("allowed fields: ,"));
    assert.ok(result.includes("allowed ops: "));
  });

  it("formats frontmatter-required rule", () => {
    const rule = makeRule({
      id: "fm-tags",
      type: "frontmatter-required",
      severity: "advisory",
      config: { field: "tags" },
    });
    const result = formatRuleSummary(rule);
    assert.equal(
      result,
      '- [ADVISORY] fm-tags: Field "tags" required in frontmatter'
    );
  });

  it("formats frontmatter-value rule with enum", () => {
    const rule = makeRule({
      id: "fm-type",
      type: "frontmatter-value",
      severity: "deny",
      config: { field: "type", enum: "wiki,note,raw" },
    });
    const result = formatRuleSummary(rule);
    assert.match(result, /\[DENY\]/);
    assert.match(result, /"type"/);
    assert.match(result, /enum: wiki,note,raw/);
  });

  it("formats frontmatter-value rule with format", () => {
    const rule = makeRule({
      type: "frontmatter-value",
      config: { field: "date", format: "YYYY-MM-DD" },
    });
    const result = formatRuleSummary(rule);
    assert.match(result, /format: YYYY-MM-DD/);
  });

  it("formats naming-convention rule", () => {
    const rule = makeRule({
      id: "slug-names",
      type: "naming-convention",
      severity: "deny",
      config: { glob: "wiki/**", pattern: "^[a-z0-9-]+\\.md$" },
    });
    const result = formatRuleSummary(rule);
    assert.match(result, /\[DENY\]/);
    assert.ok(result.includes('wiki/**'));
    assert.ok(result.includes('^[a-z0-9-]+\\.md$'));
  });

  it("includes severity in uppercase", () => {
    const rule = makeRule({
      type: "path-boundary",
      severity: "block",
      config: { path: "raw/" },
    });
    const result = formatRuleSummary(rule);
    assert.ok(result.startsWith("- [BLOCK]"));
  });

  it("handles missing config fields gracefully", () => {
    const rule = makeRule({
      type: "frontmatter-required",
      config: {},
    });
    const result = formatRuleSummary(rule);
    assert.match(result, /Field ""/);
  });
});

describe("generateConfig", () => {
  it("persists explicit guideline domain mappings when provided", async () => {
    await generateConfig({
      vaultPath: tmpDir,
      vaultName: "Vault",
      guidelineRoot: "Guidelines",
      guidelineFiles: ["Folder Guideline.md", "Frontmatter Guide.md"],
      guidelineRequirements: ["folder", "frontmatter"],
      guidelineDomains: {
        folder: "Folder Guideline.md",
        frontmatter: "Frontmatter Guide.md",
      },
      rawPaths: ["References/**"],
      frontmatterRequired: ["title"],
      inboxFallback: "Inbox",
      managedPlugins: [{ id: "calendar" }],
    });

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "omsb.config.json"), "utf-8"),
    );

    assert.deepEqual(written.guidelines.domains, {
      folder: "Folder Guideline.md",
      frontmatter: "Frontmatter Guide.md",
    });
    assert.deepEqual(written.governance, {
      runtime_enforcement: {
        docs_are_runtime_authority: false,
        human_guidelines: "authoritative",
        config_rules: "tier1-operational-input",
      },
    });
  });
});
