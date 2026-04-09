import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planTerminologyPlacement } from "../terminology/service.js";
import type { OmsbConfig } from "../rules/types.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-terminology-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): OmsbConfig {
  return {
    version: 1,
    vault_path: tmpDir,
    vault_name: "Vault",
    guidelines: {
      root: "Guidelines",
      files: ["Folder Guideline.md", "Frontmatter Guideline.md"],
      required: ["folder", "frontmatter"],
      domains: {
        folder: "Folder Guideline.md",
        frontmatter: "Frontmatter Guideline.md",
      },
    },
    rules: { raw_paths: ["References/**"] },
    enforcement: { raw_boundary: "block", frontmatter: "deny", naming: "advisory" },
    routing: {
      inbox_fallback: "Inbox",
      note_targets: {
        terminology: ["20. Terminology"],
      },
    },
  };
}

describe("planTerminologyPlacement", () => {
  it("uses obsidian-native mode when routing is explicit and native support is available", () => {
    const result = planTerminologyPlacement(tmpDir, "term", makeConfig(), true);
    assert.equal(result.routing.kind, "explicit");
    assert.equal(result.operationMode, "obsidian-native");
  });

  it("falls back to proposal-only mode for ambiguous routing", () => {
    const config = makeConfig();
    config.routing = {
      inbox_fallback: "Inbox",
      note_targets: {
        terminology: ["A", "B"],
      },
    };

    const result = planTerminologyPlacement(tmpDir, "term", config, true);
    assert.equal(result.routing.kind, "propose");
    assert.equal(result.operationMode, "proposal-only");
    assert.ok(result.routing.proposalPath);
  });
});
