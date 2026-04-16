import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyPluginSettingsChange,
  diffManagedPluginData,
  getManagedPlugin,
  listManagedPlugins,
  readManagedPluginData,
  resolveManagedPluginDataPath,
  syncManagedPluginData,
  syncManagedPluginDataFromConfig,
  writeManagedPluginData,
} from "../obsidian/plugin-settings.js";
import type { OmsbConfig } from "../rules/types.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsb-plugin-settings-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): OmsbConfig {
  return {
    version: 1,
    vault_path: tmpDir,
    vault_name: "Vault",
    governance: {
      runtime_enforcement: {
        docs_are_runtime_authority: false,
        human_guidelines: "authoritative",
        config_rules: "tier1-operational-input",
      },
    },
    guidelines: {
      root: "Guidelines",
      files: ["Folder Guideline.md"],
    },
    rules: {
      raw_paths: ["References/**"],
    },
    enforcement: {
      raw_boundary: "deny",
      frontmatter: "advisory",
      naming: "advisory",
    },
    managed_plugins: [
      { id: "calendar" },
      { id: "tasks", data_json_path: ".obsidian/plugins/tasks/data.json" },
    ],
  };
}

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

  it("diffs changed plugin setting keys", () => {
    const changed = diffManagedPluginData(
      { enabled: true, nested: { theme: "light" } },
      { enabled: false, nested: { theme: "light" }, extra: 1 },
    );
    assert.deepEqual(changed, ["enabled", "extra"]);
  });

  it("auto-applies guideline-explicit plugin changes", () => {
    const plugin = { id: "calendar" };
    writeManagedPluginData(tmpDir, plugin, { enabled: false, view: "month" });

    const result = syncManagedPluginData(
      tmpDir,
      plugin,
      { enabled: true, view: "month" },
      { guidelineExplicit: true },
    );

    assert.equal(result.mode, "auto-apply");
    assert.deepEqual(result.changedKeys, ["enabled"]);
    assert.equal(result.proposalPath, undefined);
    assert.deepEqual(readManagedPluginData(tmpDir, plugin), {
      enabled: true,
      view: "month",
    });
  });

  it("creates a proposal instead of writing optimization-only changes", () => {
    const plugin = { id: "calendar" };
    writeManagedPluginData(tmpDir, plugin, { enabled: false, view: "month" });

    const result = syncManagedPluginData(
      tmpDir,
      plugin,
      { enabled: false, view: "week" },
      { guidelineExplicit: false },
      "calendar-optimization",
    );

    assert.equal(result.mode, "approval-required");
    assert.deepEqual(result.changedKeys, ["view"]);
    assert.ok(result.proposalPath);
    assert.ok(fs.existsSync(result.proposalPath!));
    assert.deepEqual(readManagedPluginData(tmpDir, plugin), {
      enabled: false,
      view: "month",
    });

    const proposal = fs.readFileSync(result.proposalPath!, "utf-8");
    assert.match(proposal, /Plugin Settings Proposal: calendar/);
    assert.match(proposal, /Changed keys: view/);
    assert.match(proposal, /"view": "week"/);
  });

  it("returns no-op when desired settings already match current data", () => {
    const plugin = { id: "calendar" };
    writeManagedPluginData(tmpDir, plugin, { enabled: true });

    const result = syncManagedPluginData(
      tmpDir,
      plugin,
      { enabled: true },
      { guidelineExplicit: true },
    );

    assert.equal(result.mode, "no-op");
    assert.deepEqual(result.changedKeys, []);
    assert.equal(result.proposalPath, undefined);
  });

  it("lists and resolves managed plugins from config", () => {
    const config = makeConfig();
    assert.deepEqual(
      listManagedPlugins(config).map((plugin) => plugin.id),
      ["calendar", "tasks"],
    );
    assert.equal(getManagedPlugin(config, "tasks").id, "tasks");
  });

  it("throws when syncing an unregistered managed plugin", () => {
    const config = makeConfig();
    assert.throws(
      () =>
        syncManagedPluginDataFromConfig(
          tmpDir,
          config,
          "missing-plugin",
          { enabled: true },
          { guidelineExplicit: true },
        ),
      /not registered in managed_plugins/,
    );
  });

  it("syncs plugin settings through config-managed plugin lookup", () => {
    const config = makeConfig();
    const plugin = getManagedPlugin(config, "calendar");
    writeManagedPluginData(tmpDir, plugin, { enabled: false });

    const result = syncManagedPluginDataFromConfig(
      tmpDir,
      config,
      "calendar",
      { enabled: true },
      { guidelineExplicit: true },
    );

    assert.equal(result.mode, "auto-apply");
    assert.deepEqual(readManagedPluginData(tmpDir, plugin), { enabled: true });
  });
});
