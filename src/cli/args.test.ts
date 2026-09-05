import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";

describe("CLI argument parser", () => {
  it("keeps public family arguments raw for their handlers", () => {
    for (const [family, args] of [
      ["host", ["install", "--runtime", "hermes", "--vault", "Vault"]],
      ["package", ["update", "--bogus"]],
      ["note", ["audit", "--folder", "references"]],
      ["link", ["check", "--json"]],
    ] as const) {
      const parsed = parseCliArgs([family, ...args], "/tmp/oms-cli");
      expect(parsed.command).toBe(family);
      expect(parsed.error).toBeUndefined();
      expect(parsed.unknownFlags).toEqual(args);
      expect(parsed.vault).toBe("/tmp/oms-cli");
      expect(parsed.vaultExplicit).toBe(false);
    }
  });

  it("parses an approved setup digest and rejects a missing value", () => {
    const digest = `sha256:${"0".repeat(64)}`;
    expect(parseCliArgs(["setup", "--approved-digest", digest]).approvedDigest).toBe(digest);
    expect(parseCliArgs(["setup", "--approved-digest"]).error?.message).toBe(
      "[oms] Missing value for --approved-digest.",
    );
  });

  it("appends distinct explicitly selected setup template folders in argument order", () => {
    const parsed = parseCliArgs([
      "setup", "--template-folder", "Meta/Templates", "--template-folder", "Team/Templates",
      "--template-folder", "Meta/Templates", "--dry-run", "--models-no-default",
    ]);
    expect(parsed.templateFolders).toEqual(["Meta/Templates", "Team/Templates"]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.modelsNoDefault).toBe(true);
  });

  it("accepts setup's shared facade flags", () => {
    const parsed = parseCliArgs([
      "setup", "--vault", "Vault", "--runtime", "hermes", "--agent-vault", "AgentVault",
      "--dry-run", "--execute", "--yes", "--install-claude", "--models-no-default",
    ], "/tmp/oms-cli");
    expect(parsed.error).toBeUndefined();
    expect(parsed.unknownFlags).toEqual([]);
    expect(parsed.vault).toBe("/tmp/oms-cli/Vault");
    expect(parsed.vaultExplicit).toBe(true);
    expect(parsed.runtime).toBe("hermes");
    expect(parsed.agentVault).toBe("/tmp/oms-cli/AgentVault");
    expect(parsed.executeExternal).toBe(true);
    expect(parsed.yes).toBe(true);
  });

  it("parses help without retaining it as an unknown family flag", () => {
    for (const args of [["--help"], ["-h"], ["setup", "--help"], ["note", "--help", "--vault", "missing"]]) {
      const parsed = parseCliArgs(args);
      expect(parsed.help).toBe(true);
      expect(parsed.unknownFlags).not.toContain("--help");
      expect(parsed.unknownFlags).not.toContain("-h");
    }
    expect(parseCliArgs(["--help"]).command).toBeUndefined();
  });

  it("parses the mutually exclusive setup model options", () => {
    const supplied = parseCliArgs(["setup", "--models-descriptor", "models.json"], "/tmp/oms-cli");
    expect(parseCliArgs(["setup", "--models-default"]).modelsDefault).toBe(true);
    expect(supplied.modelsDescriptorPath).toBe("/tmp/oms-cli/models.json");
    expect(parseCliArgs(["setup", "--models-no-default"]).modelsNoDefault).toBe(true);
    expect(parseCliArgs(["setup", "--models-default", "--models-no-default"]).error?.message).toContain(
      "Mutually exclusive setup model options",
    );
  });

  it("requires a non-option model descriptor path", () => {
    for (const args of [["setup", "--models-descriptor"], ["setup", "--models-descriptor", "--yes"]]) {
      expect(parseCliArgs(args).error?.message).toContain("Missing value for --models-descriptor");
    }
  });

  it("preserves retired embedding flags for actionable setup rejection", () => {
    expect(parseCliArgs(["setup", "--embedding-default"]).unknownFlags).toEqual(["--embedding-default"]);
    expect(parseCliArgs(["setup", "--embedding-no-default"]).unknownFlags).toEqual(["--embedding-no-default"]);
    expect(parseCliArgs(["setup", "--embedding-descriptor", "legacy.json"]).unknownFlags).toEqual([
      "--embedding-descriptor",
    ]);
  });
});
