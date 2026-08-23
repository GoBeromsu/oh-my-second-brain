import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readGlobalConfig, writeGlobalConfig } from "./global-config.js";

let tmpHomeDir: string;

// Fresh tmpHomeDir for each test to avoid flakiness
function freshTmpHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "oms-global-config-test-"));
}

describe("global-config", () => {
  it("returns null when config file is missing", async () => {
    const homeDir = freshTmpHome();
    try {
      const result = await readGlobalConfig(homeDir);
      expect(result).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("round-trips a valid config with ~ expanded vault", async () => {
    const homeDir = freshTmpHome();
    try {
      const vaultDir = mkdtempSync(path.join(os.tmpdir(), "oms-vault-"));
      try {
        // Write config with ~ prefix
        const configPath = await writeGlobalConfig(
          { version: 1, vault: `~${path.sep}vault-test` },
          homeDir,
        );
        expect(configPath).toBe(path.join(homeDir, ".oms", "config.yaml"));

        // Read it back
        const config = await readGlobalConfig(homeDir);
        expect(config).not.toBeNull();
        expect(config!.version).toBe(1);
        // vault should be expanded to absolute path
        expect(path.isAbsolute(config!.vault)).toBe(true);
        expect(config!.vault).toContain("vault-test");
      } finally {
        rmSync(vaultDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("throws with config path in message when YAML is invalid", async () => {
    const homeDir = freshTmpHome();
    try {
      const omsDir = path.join(homeDir, ".oms");
      await mkdir(omsDir, { recursive: true });
      const configPath = path.join(omsDir, "config.yaml");
      await writeFile(configPath, "invalid: [yaml\n", "utf-8");

      await expect(readGlobalConfig(homeDir)).rejects.toThrow(configPath);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("throws when vault field is missing", async () => {
    const homeDir = freshTmpHome();
    try {
      const omsDir = path.join(homeDir, ".oms");
      await mkdir(omsDir, { recursive: true });
      const configPath = path.join(omsDir, "config.yaml");
      await writeFile(configPath, "version: 1\n", "utf-8");

      await expect(readGlobalConfig(homeDir)).rejects.toThrow(configPath);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("throws when vault is a bare relative path", async () => {
    const homeDir = freshTmpHome();
    try {
      const omsDir = path.join(homeDir, ".oms");
      await mkdir(omsDir, { recursive: true });
      const configPath = path.join(omsDir, "config.yaml");
      await writeFile(configPath, "version: 1\nvault: ../notes\n", "utf-8");

      await expect(readGlobalConfig(homeDir)).rejects.toThrow(/relative/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("write-then-read round-trip returns identical vault expansion", async () => {
    const homeDir = freshTmpHome();
    const vaultDir = mkdtempSync(path.join(os.tmpdir(), "oms-vault-rtrip-"));
    try {
      const config = { version: 1, vault: vaultDir };
      const writePath = await writeGlobalConfig(config, homeDir);
      expect(writePath).toBe(path.join(homeDir, ".oms", "config.yaml"));

      const readBack = await readGlobalConfig(homeDir);
      expect(readBack).not.toBeNull();
      expect(readBack!.vault).toBe(vaultDir); // absolute path, so identical
      expect(readBack!.version).toBe(1);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
