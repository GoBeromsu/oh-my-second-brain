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
      ["link", "--vault", "../Vault", "--folder", "notes", "--folder", "15. Work/Project"],
      "/tmp/oms-cli/repo",
    );

    expect(implicit.vault).toBe("/tmp/oms-cli");
    expect(implicit.vaultExplicit).toBe(false);
    expect(implicit.folders).toEqual([]);
    expect(linked.vault).toBe("/tmp/oms-cli/Vault");
    expect(linked.vaultExplicit).toBe(true);
    expect(linked.folders).toEqual(["notes", "15. Work/Project"]);
  });
});
