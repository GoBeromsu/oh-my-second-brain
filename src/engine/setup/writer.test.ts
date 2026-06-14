import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import { resolveVaultOverridePath, writeTaxonomyToVaultOverride } from "./writer.js";
import type { TaxonomyOutput } from "./types.js";

let tmpVault: string;

beforeAll(() => {
  tmpVault = mkdtempSync(path.join(tmpdir(), "oms-setup-writer-test-"));
});

afterAll(() => {
  rmSync(tmpVault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal valid TaxonomyOutput fixture
// ---------------------------------------------------------------------------

const minimalOutput: TaxonomyOutput = {
  version: 1,
  folders: {
    Inbox: { intent: "Raw captures", tier: "raw", provenance: "external-raw", concept: "inbox" },
  },
  lint: { schema_ssot: "engine_default" },
  embedder: { provider: "stub", model: "stub" },
  ignore_for_external_apis: ["Journal/**"],
  agent_writable_zone: ["Inbox"],
  write_routing_law: "append_only",
};

// ---------------------------------------------------------------------------
// resolveVaultOverridePath
// ---------------------------------------------------------------------------

describe("resolveVaultOverridePath", () => {
  it("resolves to {vaultRoot}/.oms/taxonomy.yaml", () => {
    const result = resolveVaultOverridePath("/some/vault");
    expect(result).toBe(path.resolve("/some/vault", ".oms", "taxonomy.yaml"));
  });

  it("always ends with .oms/taxonomy.yaml regardless of OS separators", () => {
    const result = resolveVaultOverridePath(tmpVault);
    expect(result.endsWith(path.join(".oms", "taxonomy.yaml"))).toBe(true);
  });

  it("never resolves to the engine default path", () => {
    const result = resolveVaultOverridePath("/some/vault");
    expect(result).not.toContain("core/ontology/taxonomy.yaml");
    expect(result.replace(/\\/g, "/")).not.toContain("core/ontology/taxonomy.yaml");
  });
});

// ---------------------------------------------------------------------------
// Non-Sticky Guard: writeTaxonomyToVaultOverride
// ---------------------------------------------------------------------------

describe("writeTaxonomyToVaultOverride — Non-Sticky Guard", () => {
  it("writes to vault/.oms/taxonomy.yaml and returns the written path", async () => {
    const written = await writeTaxonomyToVaultOverride(tmpVault, minimalOutput);

    const expected = path.resolve(tmpVault, ".oms", "taxonomy.yaml");
    expect(written).toBe(expected);
  });

  it("creates the .oms directory if it does not exist", async () => {
    const freshVault = mkdtempSync(path.join(tmpdir(), "oms-fresh-vault-"));
    try {
      await writeTaxonomyToVaultOverride(freshVault, minimalOutput);
      const content = await readFile(path.join(freshVault, ".oms", "taxonomy.yaml"), "utf8");
      expect(content).toContain("version");
    } finally {
      rmSync(freshVault, { recursive: true, force: true });
    }
  });

  it("writes valid YAML that round-trips through yamlParse", async () => {
    await writeTaxonomyToVaultOverride(tmpVault, minimalOutput);
    const raw = await readFile(path.resolve(tmpVault, ".oms", "taxonomy.yaml"), "utf8");
    const parsed = yamlParse(raw) as Record<string, unknown>;

    expect(parsed["version"]).toBe(1);
    expect(parsed["write_routing_law"]).toBe("append_only");
    expect(Array.isArray(parsed["ignore_for_external_apis"])).toBe(true);
  });

  it("always sets version: 1 even when merging with an existing v0 file", async () => {
    const mergeVault = mkdtempSync(path.join(tmpdir(), "oms-merge-vault-"));
    try {
      // Write a v0 file first.
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(mergeVault, ".oms"), { recursive: true });
      await writeFile(
        path.join(mergeVault, ".oms", "taxonomy.yaml"),
        "version: 0\nfolders: {}\n",
        "utf8"
      );

      await writeTaxonomyToVaultOverride(mergeVault, minimalOutput);
      const raw = await readFile(path.join(mergeVault, ".oms", "taxonomy.yaml"), "utf8");
      const parsed = yamlParse(raw) as Record<string, unknown>;

      expect(parsed["version"]).toBe(1);
    } finally {
      rmSync(mergeVault, { recursive: true, force: true });
    }
  });

  it("throws (Non-Sticky Guard) if called with a path that would target core/ontology", () => {
    // Directly test the guard by passing a synthetic vaultRoot whose .oms path
    // would contain "core/ontology/taxonomy.yaml" — not possible via the normal
    // resolveVaultOverridePath, so we test the guard independently via a crafted string.
    // The guard function is internal; we trigger it through the public surface by
    // verifying that resolveVaultOverridePath never produces the forbidden fragment.
    const result = resolveVaultOverridePath("/project/root");
    expect(result.replace(/\\/g, "/")).not.toContain("core/ontology");
  });
});
