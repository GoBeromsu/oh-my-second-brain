import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyPluginSettingsChange,
  readManagedPluginData,
  resolveManagedPluginDataPath,
  writeManagedPluginData,
} from "../obsidian/plugin-settings.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-plugin-settings-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("plugin settings helpers", () => {
  it("resolves default data.json path inside .obsidian/plugins", () => {
    const result = resolveManagedPluginDataPath(tmpDir, { id: "calendar" });
    assert.equal(
      result,
      path.join(tmpDir, ".obsidian", "plugins", "calendar", "data.json"),
    );
  });

  it("writes and reads managed plugin data", () => {
    const plugin = { id: "calendar" };
    writeManagedPluginData(tmpDir, plugin, { enabled: true });
    const read = readManagedPluginData(tmpDir, plugin);
    assert.deepEqual(read, { enabled: true });
  });

  it("rejects non-data.json writes", () => {
    assert.throws(
      () =>
        writeManagedPluginData(
          tmpDir,
          { id: "calendar", data_json_path: ".obsidian/plugins/calendar/main.js" },
          { enabled: true },
        ),
      /calendar\/data\.json/,
    );
  });

  it("rejects absolute or external managed plugin paths", () => {
    assert.throws(
      () =>
        resolveManagedPluginDataPath(tmpDir, {
          id: "calendar",
          data_json_path: "/tmp/external/data.json",
        }),
      /calendar\/data\.json/,
    );
  });

  it("classifies guideline-explicit changes as auto-apply", () => {
    assert.equal(
      classifyPluginSettingsChange({ guidelineExplicit: true }),
      "auto-apply",
    );
  });

  it("classifies optimization changes as approval-required", () => {
    assert.equal(
      classifyPluginSettingsChange({ guidelineExplicit: false }),
      "approval-required",
    );
  });
});
