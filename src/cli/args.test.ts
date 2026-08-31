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

  it("parses the three mutually exclusive setup embedding options independently", () => {
    const pinned = parseCliArgs(["setup", "--embedding-default"], "/tmp/oms-cli");
    const supplied = parseCliArgs(
      ["setup", "--embedding-descriptor", "model.json"],
      "/tmp/oms-cli",
    );
    const waived = parseCliArgs(["setup", "--embedding-no-default"], "/tmp/oms-cli");

    expect(pinned.embeddingDefault).toBe(true);
    expect(pinned.embeddingDescriptorPath).toBeUndefined();
    expect(pinned.embeddingNoDefault).toBe(false);
    expect(pinned.unknownFlags).toEqual([]);

    expect(supplied.embeddingDescriptorPath).toBe("/tmp/oms-cli/model.json");
    expect(supplied.embeddingDefault).toBe(false);

    expect(waived.embeddingNoDefault).toBe(true);
    expect(waived.embeddingDefault).toBe(false);
  });

  it("defaults every setup embedding option to unselected", () => {
    const parsed = parseCliArgs(["setup"], "/tmp/oms-cli");

    expect(parsed.embeddingDefault).toBe(false);
    expect(parsed.embeddingNoDefault).toBe(false);
    expect(parsed.embeddingDescriptorPath).toBeUndefined();
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
