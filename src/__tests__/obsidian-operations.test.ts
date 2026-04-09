import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { resolveVaultOperationMode } from "../obsidian/operations.js";

describe("resolveVaultOperationMode", () => {
  it("prefers obsidian-native mode for user-visible note mutations", () => {
    assert.equal(resolveVaultOperationMode("note-move", true), "obsidian-native");
    assert.equal(resolveVaultOperationMode("note-route", true), "obsidian-native");
  });

  it("downgrades user-visible note mutations to proposal-only without native support", () => {
    assert.equal(resolveVaultOperationMode("note-create", false), "proposal-only");
    assert.equal(resolveVaultOperationMode("note-rename", false), "proposal-only");
  });

  it("keeps non-user-visible artifact writes on filesystem mode", () => {
    assert.equal(resolveVaultOperationMode("config-write", false), "filesystem");
    assert.equal(resolveVaultOperationMode("plugin-data-write", true), "filesystem");
  });
});
