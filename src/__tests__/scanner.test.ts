import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanVault } from "../init/scanner.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-scanner-"));
  fs.mkdirSync(path.join(tmpDir, "Guidelines"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "Guidelines", "Folder Guideline.md"), "# Folder", "utf-8");
  fs.mkdirSync(path.join(tmpDir, "Guidelines", "Nested"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "Guidelines", "Nested", "Frontmatter Guideline.md"),
    "# Frontmatter",
    "utf-8",
  );
  fs.mkdirSync(path.join(tmpDir, "Inbox"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "References"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, ".obsidian", "plugins", "calendar"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".obsidian", "plugins", "calendar", "data.json"),
    "{}",
    "utf-8",
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanVault", () => {
  it("does not treat Inbox as a raw candidate by default", async () => {
    const result = await scanVault(tmpDir);
    assert.ok(result.rawCandidates.includes("References"));
    assert.ok(!result.rawCandidates.includes("Inbox"));
  });

  it("detects managed plugin candidates from .obsidian/plugins/*/data.json", async () => {
    const result = await scanVault(tmpDir);
    assert.deepEqual(result.managedPluginCandidates, ["calendar"]);
  });

  it("lists guideline markdown files recursively relative to the guideline root", async () => {
    const result = await scanVault(tmpDir);
    assert.deepEqual(result.guidelineFiles, [
      "Folder Guideline.md",
      path.join("Nested", "Frontmatter Guideline.md"),
    ]);
  });
});
