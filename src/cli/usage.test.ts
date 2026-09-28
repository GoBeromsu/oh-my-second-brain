import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import { cliUsageText, mainUsageCommandNames } from "./usage.js";

describe("CLI usage text", () => {
  it("documents setup as the seal with no approval or model flags", () => {
    const usage = cliUsageText();

    expect(usage).toContain("oh-my-second-brain setup [extract|status|host|model|package|bridge] [options]\n");
    expect(usage).toContain("Seal the vault contract");
    expect(usage).toContain("Leaves: extract, status, host, model, package, bridge.");
    expect(usage).not.toContain("--approval-token");
    expect(usage).not.toContain("--approved-digest");
    expect(usage).not.toContain("--dry-run");
    expect(usage).not.toContain("--models-");
    expect(usage).not.toContain("--embedding-");
    // The 0.19 public spellings, with no removed family leaves.
    expect(usage).toContain("search --path <note> | --context [options] | --link <note> [options]");
    expect(usage).toContain("doctor <status|contract|audit|link-check|sync-embeddings|cleanup|build-graph>");
    expect(usage).not.toContain("note <audit|get>");
    expect(usage).not.toContain("link <suggest|check>");
    expect(usage).not.toContain("oh-my-second-brain host <");
    expect(usage).not.toContain("oh-my-second-brain package <");
    expect(usage).not.toContain(" template <");
    expect(usage).not.toContain("default: Templates");
    expect(usage).not.toContain("default: Inbox");
  });

  it("derives main commands from the harness registry and hides the hook", () => {
    const usage = cliUsageText();

    expect(mainUsageCommandNames()).toEqual(["search", "interview", "write", "setup", "doctor", "serve", "hook"]);
    for (const name of mainUsageCommandNames()) {
      expect(harnessSurfaceRegistry.cliCommands.some((command) => command.name === name)).toBe(true);
    }
    expect(usage).not.toContain("  hook      ");
    expect(usage).not.toMatch(/semantic/u);
  });
});
