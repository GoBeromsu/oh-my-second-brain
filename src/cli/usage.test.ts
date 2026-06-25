import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../harness/surface-registry.js";
import { cliUsageText, mainUsageCommandNames } from "./usage.js";

describe("CLI usage text", () => {
  it("derives public runtime choices and main commands from harness registry", () => {
    const usage = cliUsageText();

    expect(usage).toContain("oh-my-second-brain install [--vault <path>] [--runtime <auto|all|claude|codex|hermes>]");
    expect(usage).toContain("oh-my-second-brain uninstall [--runtime <all|claude|codex|hermes>]");
    expect(mainUsageCommandNames()).toEqual([
      "setup",
      "install",
      "uninstall",
      "update",
      "doctor",
      "lint",
      "link",
      "semantic",
      "mcp",
      "hook",
    ]);
    for (const name of mainUsageCommandNames()) {
      expect(harnessSurfaceRegistry.cliCommands.some((command) => command.name === name)).toBe(true);
    }
  });
});
