import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { validateConfig } from "../config/schema.js";

const MINIMAL_VALID: unknown = {
  version: 1,
  vault_path: "/vault",
  vault_name: "MyVault",
  guidelines: { root: "guidelines", files: ["rules.md"] },
  rules: { raw_paths: ["raw/**"] },
  enforcement: { raw_boundary: "block", frontmatter: "deny", naming: "advisory" },
};

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const result = validateConfig(MINIMAL_VALID);
    assert.equal(result.version, 1);
    assert.equal(result.vault_path, "/vault");
    assert.equal(result.vault_name, "MyVault");
    assert.deepEqual(result.rules.raw_paths, ["raw/**"]);
  });

  it("throws when version is missing", () => {
    const data = { ...MINIMAL_VALID as Record<string, unknown>, version: undefined };
    assert.throws(() => validateConfig(data), /version/);
  });

  it("throws when version is wrong number", () => {
    const data = { ...MINIMAL_VALID as Record<string, unknown>, version: 2 };
    assert.throws(() => validateConfig(data), /version/);
  });

  it("throws when vault_path is missing", () => {
    const data = { ...MINIMAL_VALID as Record<string, unknown> };
    delete data["vault_path"];
    assert.throws(() => validateConfig(data), /vault_path/);
  });

  it("throws when enforcement severity is invalid", () => {
    const data = {
      ...MINIMAL_VALID as Record<string, unknown>,
      enforcement: { raw_boundary: "invalid", frontmatter: "deny", naming: "advisory" },
    };
    assert.throws(() => validateConfig(data), /raw_boundary|block|deny|advisory/);
  });

  it("accepts optional authorship block", () => {
    const data = {
      ...MINIMAL_VALID as Record<string, unknown>,
      authorship: {
        enabled: true,
        agent_name: "claude",
        created_by_field: "created_by",
        modified_by_field: "modified_by",
      },
    };
    const result = validateConfig(data);
    assert.equal(result.authorship?.enabled, true);
    assert.equal(result.authorship?.agent_name, "claude");
  });

  it("returns config with all enforcement severities preserved", () => {
    const result = validateConfig(MINIMAL_VALID);
    assert.equal(result.enforcement.raw_boundary, "block");
    assert.equal(result.enforcement.frontmatter, "deny");
    assert.equal(result.enforcement.naming, "advisory");
  });

  it("accepts frontmatter_required and frontmatter_values", () => {
    const data = {
      ...MINIMAL_VALID as Record<string, unknown>,
      rules: {
        raw_paths: ["raw/**"],
        frontmatter_required: ["title", "tags"],
        frontmatter_values: {
          type: { enum: ["note", "article"] },
        },
      },
    };
    const result = validateConfig(data);
    assert.deepEqual(result.rules.frontmatter_required, ["title", "tags"]);
    assert.deepEqual(result.rules.frontmatter_values?.type?.enum, ["note", "article"]);
  });

  it("throws when root value is not an object", () => {
    assert.throws(() => validateConfig("not-an-object"), /root value must be a JSON object/);
  });
});
