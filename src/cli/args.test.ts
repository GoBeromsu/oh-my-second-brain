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

  it("parses an approved setup digest, defaults it, and rejects a missing value", () => {
    const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const parsed = parseCliArgs(["setup", "--approved-digest", "sha256:old", "--approved-digest", digest]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.approvedDigest).toBe(digest);
    expect(parseCliArgs(["setup"]).approvedDigest).toBeUndefined();
    expect(parseCliArgs(["setup", "--approved-digest"]).error?.message).toBe(
      "[oms] Missing value for --approved-digest.",
    );
    expect(parseCliArgs(["setup", "--approved-digest", "--yes"]).error?.message).toBe(
      "[oms] Missing value for --approved-digest.",
    );
  });

  it("given a setup template folder, when parsing, then the exact folder is retained", () => {
    expect(parseCliArgs(["setup", "--template-folder", "Meta/Templates"]).templateFolder).toBe(
      "Meta/Templates",
    );
    expect(parseCliArgs(["setup", "--template-folder"]).error?.message).toBe(
      "[oms] Missing value for --template-folder.",
    );
  });

  it("accepts only a positive integer max-per-template report limit", () => {
    expect(parseCliArgs(["doctor", "--max-per-template", "3"]).maxPerTemplate).toBe(3);
    expect(parseCliArgs(["doctor", "--max-per-template"]).error?.message).toContain("positive integer");
    expect(parseCliArgs(["doctor", "--max-per-template", "0"]).error?.message).toContain("positive integer");
    expect(parseCliArgs(["doctor", "--max-per-template", "1.5"]).error?.message).toContain("positive integer");
  });

  it("preserves unsupported runtime and malformed numeric flag errors", () => {
    expect(parseCliArgs(["install", "--runtime", "banana"]).error?.message).toBe(
      "[oms] Unsupported runtime: banana",
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

  it("parses help as a first-class flag rather than an unknown option", () => {
    for (const args of [["--help"], ["-h"], ["setup", "--help"], ["mcp", "-h"]]) {
      const parsed = parseCliArgs(args);

      expect(parsed.help).toBe(true);
      expect(parsed.unknownFlags).not.toContain("--help");
      expect(parsed.unknownFlags).not.toContain("-h");
    }
    expect(parseCliArgs(["--help"]).command).toBeUndefined();
    expect(parseCliArgs(["setup", "--help"]).command).toBe("setup");
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

  it("requires a non-option path after --models-descriptor", () => {
    for (const args of [
      ["setup", "--models-descriptor"],
      ["setup", "--models-descriptor", "--yes"],
      ["setup", "--models-descriptor", "-v"],
      ["setup", "--models-descriptor", ""],
    ]) {
      expect(parseCliArgs(args).error?.message).toBe(
        "[oms] Missing value for --models-descriptor. Choose one of --models-default, --models-descriptor <path>, or --models-no-default.",
      );
    }
  });

  it("rejects every conflicting pair of setup model options", () => {
    for (const args of [
      ["setup", "--models-default", "--models-descriptor", "models.json"],
      ["setup", "--models-default", "--models-no-default"],
      ["setup", "--models-descriptor", "models.json", "--models-no-default"],
    ]) {
      expect(parseCliArgs(args, "/tmp/oms-cli").error?.message).toContain(
        "Choose one of --models-default, --models-descriptor <path>, or --models-no-default.",
      );
    }
  });

  it("defaults every setup model-set option to unselected and preserves retired flags for setup rejection", () => {
    const parsed = parseCliArgs(["setup"], "/tmp/oms-cli");

    expect(parsed.modelsDefault).toBe(false);
    expect(parsed.modelsNoDefault).toBe(false);
    expect(parsed.modelsDescriptorPath).toBeUndefined();
    expect(parseCliArgs(["setup", "--embedding-default"]).unknownFlags).toEqual(["--embedding-default"]);
    expect(parseCliArgs(["setup", "--embedding-no-default"]).unknownFlags).toEqual(["--embedding-no-default"]);
    expect(parseCliArgs(["setup", "--embedding-descriptor", "legacy.json"]).unknownFlags).toEqual([
      "--embedding-descriptor",
    ]);
  });

  it("accepts setup's shared install, runtime, vault, dry-run, and approval options", () => {
    const parsed = parseCliArgs(
      [
        "setup",
        "--vault",
        "Vault",
        "--runtime",
        "hermes",
        "--agent-vault",
        "AgentVault",
        "--dry-run",
        "--execute",
        "--yes",
        "--approved-digest",
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "--install-claude",
        "--models-no-default",
      ],
      "/tmp/oms-cli",
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("parses audit flags", () => {
    const parsed = parseCliArgs(
      ["audit", "--vault", "Vault", "--folder", "references", "--json"],
      "/tmp/oms-cli",
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.command).toBe("audit");
    expect(parsed.vault).toBe("/tmp/oms-cli/Vault");
    expect(parsed.folders).toEqual(["references"]);
    expect(parsed.json).toBe(true);
  });
});
