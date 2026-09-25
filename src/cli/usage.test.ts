import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import { cliUsageText, mainUsageCommandNames } from "./usage.js";

describe("CLI usage text", () => {
  it("documents setup as the interactive seal with no approval or model flags", () => {
    const usage = cliUsageText();

    expect(usage).toContain("oh-my-second-brain setup [--vault <path>]\n");
    expect(usage).toContain("Interview the vault and seal its contract");
    expect(usage).toContain("same as `oms contract setup`");
    expect(usage).not.toContain("--approval-token");
    expect(usage).not.toContain("--approved-digest");
    expect(usage).not.toContain("--dry-run");
    expect(usage).not.toContain("--models-");
    expect(usage).not.toContain("--embedding-");
    // The approved public leaves, with no retired note-write or link-apply verbs.
    expect(usage).toContain("note <audit|get>");
    expect(usage).toContain("link <suggest|check>");
    expect(usage).not.toContain("template <");
    expect(usage).not.toContain("note <create|append|update");
    expect(usage).not.toContain("link <check|suggest|apply>");
    expect(usage).not.toContain("default: Templates");
    expect(usage).not.toContain("default: Inbox");
  });

  it("derives public runtime choices and main commands from harness registry", () => {
    const usage = cliUsageText();

    expect(usage).toContain("oh-my-second-brain host <install|remove|sync|status> [options]");
    expect(usage).toContain("oh-my-second-brain package <check|update> [options]");
    expect(mainUsageCommandNames()).toEqual([
      "setup",
      "contract",
      "note",
      "link",
      "bridge",
      "search",
      "index",
      "graph",
      "host",
      "package",
      "model",
      "serve",
      "hook",
      "status",
    ]);
    for (const name of mainUsageCommandNames()) {
      expect(harnessSurfaceRegistry.cliCommands.some((command) => command.name === name)).toBe(true);
    }
    expect(usage).not.toMatch(/semantic/u);
  });
});
