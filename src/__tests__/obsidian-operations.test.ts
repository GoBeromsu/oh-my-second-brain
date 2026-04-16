import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  planUserVisibleVaultOperation,
  resolveVaultOperationMode,
} from "../obsidian/operations.js";

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

  it("creates a proposal artifact when native support is unavailable for an explicit route", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-op-plan-"));
    try {
      const result = planUserVisibleVaultOperation(
        tmpDir,
        "term",
        "note-route",
        "terminology",
        { kind: "explicit", destination: "20. Terminology" },
        false,
      );

      assert.equal(result.mode, "proposal-only");
      assert.equal(result.destination, "20. Terminology");
      assert.equal(result.reason, "native-unavailable");
      assert.ok(result.proposalPath);
      assert.ok(fs.existsSync(result.proposalPath!));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes through routing proposals when the route itself is ambiguous", () => {
    const result = planUserVisibleVaultOperation(
      "/vault",
      "term",
      "note-route",
      "terminology",
      {
        kind: "propose",
        candidates: ["A", "B"],
        reason: "ambiguous",
        proposalPath: "/vault/.omsb/proposals/example.md",
      },
      true,
    );

    assert.deepEqual(result, {
      mode: "proposal-only",
      proposalPath: "/vault/.omsb/proposals/example.md",
      reason: "ambiguous",
    });
  });
});
