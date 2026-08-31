import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";

describe("CLI argument parser", () => {
  it("parses shared install/update flags without owning host runtime literals", () => {
    const parsed = parseCliArgs(
      [
        "install",
        "--vault",
        "Vault",
        "--runtime",
        "hermes",
        "--agent-vault",
        "AgentVault",
        "--dry-run",
        "--execute",
        "--yes",
      ],
      "/tmp/oms-cli",
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.command).toBe("install");
    expect(parsed.vault).toBe("/tmp/oms-cli/Vault");
    expect(parsed.vaultExplicit).toBe(true);
    expect(parsed.agentVault).toBe("/tmp/oms-cli/AgentVault");
    expect(parsed.runtime).toBe("hermes");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.executeExternal).toBe(true);
    expect(parsed.yes).toBe(true);
  });

  it("preserves unsupported runtime and malformed numeric flag errors", () => {
    expect(parseCliArgs(["install", "--runtime", "banana"]).error?.message).toBe(
      "[oms] Unsupported runtime: banana",
    );
    expect(parseCliArgs(["doctor", "--max", "0"]).error?.message).toBe(
      "[oms] Unsupported --max value: 0",
    );
    expect(parseCliArgs(["update", "--timeout-ms", "nope"]).error?.message).toBe(
      "[oms] Unsupported timeout: nope",
    );
  });

  it("preserves existing unknown-flag collection for command handlers", () => {
    const parsed = parseCliArgs(["doctor", "--runtime"]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.unknownFlags).toEqual(["--runtime"]);
  });

  it("parses repeated link folders and distinguishes implicit vault defaults", () => {
    const implicit = parseCliArgs(["doctor"], "/tmp/oms-cli");
    const linked = parseCliArgs(
      ["link", "--vault", "../Vault", "--folder", "notes", "--folder", "15. Work/Project", "--no-convention-note"],
      "/tmp/oms-cli/repo",
    );

    expect(implicit.vault).toBe("/tmp/oms-cli");
    expect(implicit.vaultExplicit).toBe(false);
    expect(implicit.folders).toEqual([]);
    expect(implicit.conventionNote).toBe(true);
    expect(linked.vault).toBe("/tmp/oms-cli/Vault");
    expect(linked.vaultExplicit).toBe(true);
    expect(linked.folders).toEqual(["notes", "15. Work/Project"]);
    expect(linked.conventionNote).toBe(false);
  });

  it("parses the three mutually exclusive setup model-set options independently", () => {
    const pinned = parseCliArgs(["setup", "--models-default"], "/tmp/oms-cli");
    const supplied = parseCliArgs(
      ["setup", "--models-descriptor", "models.json"],
      "/tmp/oms-cli",
    );
    const waived = parseCliArgs(["setup", "--models-no-default"], "/tmp/oms-cli");

    expect(pinned.modelsDefault).toBe(true);
    expect(pinned.modelsDescriptorPath).toBeUndefined();
    expect(pinned.modelsNoDefault).toBe(false);
    expect(pinned.unknownFlags).toEqual([]);

    expect(supplied.modelsDescriptorPath).toBe("/tmp/oms-cli/models.json");
    expect(supplied.modelsDefault).toBe(false);

    expect(waived.modelsNoDefault).toBe(true);
    expect(waived.modelsDefault).toBe(false);
  });

  it("keeps conflicting setup model-set selections for oms to reject fail-loudly", () => {
    const parsed = parseCliArgs(
      ["setup", "--models-descriptor", "models.json", "--models-default", "--models-no-default"],
      "/tmp/oms-cli",
    );

    expect(parsed.modelsDescriptorPath).toBe("/tmp/oms-cli/models.json");
    expect(parsed.modelsDefault).toBe(true);
    expect(parsed.modelsNoDefault).toBe(true);
  });

  it("defaults every setup model-set option to unselected and rejects retired flags", () => {
    const parsed = parseCliArgs(["setup"], "/tmp/oms-cli");

    expect(parsed.modelsDefault).toBe(false);
    expect(parsed.modelsNoDefault).toBe(false);
    expect(parsed.modelsDescriptorPath).toBeUndefined();
    expect(parseCliArgs(["setup", "--embedding-default"]).unknownFlags).toEqual(["--embedding-default"]);
    expect(parseCliArgs(["setup", "--embedding-no-default"]).unknownFlags).toEqual(["--embedding-no-default"]);
    expect(parseCliArgs(["setup", "--embedding-descriptor", "legacy.json"]).unknownFlags).toEqual([
      "--embedding-descriptor",
      "legacy.json",
    ]);
  });

  it("parses audit flags", () => {
    const parsed = parseCliArgs(
      ["audit", "--vault", "Vault", "--folder", "references", "--json", "--suggest-fields"],
      "/tmp/oms-cli",
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.command).toBe("audit");
    expect(parsed.vault).toBe("/tmp/oms-cli/Vault");
    expect(parsed.folders).toEqual(["references"]);
    expect(parsed.json).toBe(true);
    expect(parsed.suggestFields).toBe(true);
  });
});
