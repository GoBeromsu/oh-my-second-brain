import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractTier2Rules } from "../rules/tier2-extractor.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-t2-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeGuide(filename: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, filename), content, "utf-8");
}

describe("extractTier2Rules", () => {
  it("parses a single path-boundary annotation", () => {
    writeGuide("guide1.md", `# Vault structure\n<!-- omsb: rule-type="path-boundary" severity="block" paths="raw/**" -->\nSome text.`);
    const rules = extractTier2Rules(tmpDir, ["guide1.md"]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, "path-boundary");
    assert.equal(rules[0].severity, "block");
    assert.deepEqual(rules[0].config["paths"], ["raw/**"]);
  });

  it("parses multiple annotations in one file", () => {
    writeGuide("guide2.md", [
      `<!-- omsb: rule-type="path-boundary" severity="block" paths="raw/**" -->`,
      `Some content`,
      `<!-- omsb: rule-type="frontmatter-required" severity="deny" field="title" -->`,
    ].join("\n"));
    const rules = extractTier2Rules(tmpDir, ["guide2.md"]);
    assert.equal(rules.length, 2);
    const types = rules.map((r) => r.type);
    assert.ok(types.includes("path-boundary"));
    assert.ok(types.includes("frontmatter-required"));
  });

  it("skips annotation missing rule-type without crashing", () => {
    writeGuide("guide3.md", `<!-- omsb: severity="block" paths="raw/**" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide3.md"]);
    assert.equal(rules.length, 0);
  });

  it("handles Korean text around annotations", () => {
    writeGuide("guide4.md", [
      `# 규칙 문서`,
      `이 파일은 중요한 규칙을 담고 있습니다.`,
      `<!-- omsb: rule-type="naming-convention" severity="advisory" pattern="^[a-z]" -->`,
      `한국어 텍스트가 계속됩니다.`,
    ].join("\n"));
    const rules = extractTier2Rules(tmpDir, ["guide4.md"]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, "naming-convention");
    assert.equal(rules[0].config["pattern"], "^[a-z]");
  });

  it("does not crash for non-existent file", () => {
    const rules = extractTier2Rules(tmpDir, ["does-not-exist.md"]);
    assert.equal(rules.length, 0);
  });

  it("returns empty array for empty file list", () => {
    const rules = extractTier2Rules(tmpDir, []);
    assert.equal(rules.length, 0);
  });

  it("all parsed rules have source.tier === 2", () => {
    writeGuide("guide5.md", `<!-- omsb: rule-type="frontmatter-required" severity="deny" field="tags" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide5.md"]);
    for (const rule of rules) {
      assert.equal(rule.source.tier, 2);
    }
  });

  it("source.file matches the relative guideline filename", () => {
    writeGuide("guide6.md", `<!-- omsb: rule-type="frontmatter-required" severity="deny" field="type" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide6.md"]);
    assert.equal(rules[0].source.file, "guide6.md");
  });

  it("uses advisory severity when severity attribute is omitted", () => {
    writeGuide("guide7.md", `<!-- omsb: rule-type="frontmatter-required" field="title" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide7.md"]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].severity, "advisory");
  });

  it("skips annotation with unknown rule-type without crashing", () => {
    writeGuide("guide8.md", `<!-- omsb: rule-type="unknown-type" severity="block" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide8.md"]);
    assert.equal(rules.length, 0);
  });

  it("parses comma-separated paths into array", () => {
    writeGuide("guide9.md", `<!-- omsb: rule-type="path-boundary" severity="block" paths="raw/**,inbox/**" -->`);
    const rules = extractTier2Rules(tmpDir, ["guide9.md"]);
    assert.deepEqual(rules[0].config["paths"], ["raw/**", "inbox/**"]);
  });
});
