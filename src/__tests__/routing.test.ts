import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveDestination,
  resolveDestinationWithProposal,
} from "../routing/resolver.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-routing-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
describe("resolveDestination", () => {
  it("returns explicit destination when one target exists", () => {
    const result = resolveDestination("terminology", {
      note_targets: { terminology: ["20. Terminology"] },
      inbox_fallback: "Inbox",
    });
    assert.deepEqual(result, {
      kind: "explicit",
      destination: "20. Terminology",
    });
  });

  it("returns proposal when multiple targets exist", () => {
    const result = resolveDestination("terminology", {
      note_targets: { terminology: ["A", "B"] },
      inbox_fallback: "Inbox",
    });
    assert.deepEqual(result, {
      kind: "propose",
      candidates: ["A", "B"],
      reason: "ambiguous",
    });
  });

  it("returns inbox fallback when target is missing", () => {
    const result = resolveDestination("terminology", {
      inbox_fallback: "Inbox",
    });
    assert.deepEqual(result, {
      kind: "inbox",
      destination: "Inbox",
    });
  });

  it("returns proposal when routing config is missing", () => {
    const result = resolveDestination("terminology");
    assert.deepEqual(result, {
      kind: "propose",
      candidates: [],
      reason: "missing-config",
    });
  });

  it("writes a proposal artifact for ambiguous routing", () => {
    const result = resolveDestinationWithProposal(tmpDir, "terminology", "terminology", {
      note_targets: { terminology: ["A", "B"] },
      inbox_fallback: "Inbox",
    });
    assert.equal(result.kind, "propose");
    assert.ok(result.proposalPath);
    assert.ok(fs.existsSync(result.proposalPath!));
  });
});
