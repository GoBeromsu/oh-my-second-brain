import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

describe("OMSB plugin runtime contract", () => {
  it("does not redeclare the standard hooks manifest in plugin.json", () => {
    const manifest = JSON.parse(readRepoFile(".claude-plugin/plugin.json")) as Record<string, unknown>;
    assert.equal(manifest["hooks"], undefined);
    assert.equal(manifest["skills"], "./skills/");
  });

  it("uses bare skill names so the plugin namespace can expose slash commands", () => {
    const expected = new Map([
      ["skills/init/SKILL.md", "init"],
      ["skills/compile/SKILL.md", "compile"],
      ["skills/terminology/SKILL.md", "terminology"],
      ["skills/plugin-settings/SKILL.md", "plugin-settings"],
    ]);

    for (const [file, skillName] of expected.entries()) {
      const text = readRepoFile(file);
      assert.match(text, new RegExp(`^name:\\s*${skillName}$`, "m"));
      assert.match(text, /^level:\s*2$/m);
    }
  });
});
