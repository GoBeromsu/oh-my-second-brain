import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeProposal } from "../proposals/writer.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-proposal-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeProposal", () => {
  it("writes proposal artifacts under .omsb/proposals", () => {
    const outPath = writeProposal(
      tmpDir,
      "terminology-routing",
      "# Proposal\n\nNeed approval",
      new Date("2026-04-09T10:00:00Z"),
    );

    assert.ok(outPath.includes(path.join(".omsb", "proposals")));
    assert.ok(fs.existsSync(outPath));
    assert.match(path.basename(outPath), /terminology-routing\.md$/);
  });
});
