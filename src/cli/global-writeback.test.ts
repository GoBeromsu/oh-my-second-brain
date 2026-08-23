import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGlobalConfig } from "../kernel/link/global-config.js";
import { backfillGlobalVaultFromEnv, nonFatalGlobalWriteback, registerGlobalVault } from "./global-writeback.js";

describe("global-writeback", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "oms-global-writeback-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("registerGlobalVault writes a config readable by readGlobalConfig", async () => {
    const homeDir = path.join(tmpRoot, "home1");
    const vault = path.join(tmpRoot, "vault1");
    await mkdir(vault, { recursive: true });

    const result = await registerGlobalVault({ vault, homeDir, overwrite: false });
    expect(result.wrote).toBe(true);

    const config = await readGlobalConfig(homeDir);
    expect(config).not.toBeNull();
    expect(config?.vault).toBe(vault);
  });

  it("register with overwrite=true replaces an existing different vault", async () => {
    const homeDir = path.join(tmpRoot, "home2");
    const vaultA = path.join(tmpRoot, "vaultA");
    const vaultB = path.join(tmpRoot, "vaultB");
    await mkdir(vaultA, { recursive: true });
    await mkdir(vaultB, { recursive: true });

    await registerGlobalVault({ vault: vaultA, homeDir, overwrite: false });
    const result = await registerGlobalVault({ vault: vaultB, homeDir, overwrite: true });
    expect(result.wrote).toBe(true);

    const config = await readGlobalConfig(homeDir);
    expect(config?.vault).toBe(vaultB);
  });

  it("backfill writes when config absent and OMS_VAULT points at an existing dir", async () => {
    const homeDir = path.join(tmpRoot, "home3");
    const vault = path.join(tmpRoot, "vault3");
    await mkdir(vault, { recursive: true });

    const result = await backfillGlobalVaultFromEnv({ env: { OMS_VAULT: vault }, homeDir });
    expect(result.wrote).toBe(true);

    const config = await readGlobalConfig(homeDir);
    expect(config?.vault).toBe(vault);
  });

  it("backfill does NOT overwrite an existing config", async () => {
    const homeDir = path.join(tmpRoot, "home4");
    const originalVault = path.join(tmpRoot, "vault4-original");
    const otherVault = path.join(tmpRoot, "vault4-other");
    await mkdir(originalVault, { recursive: true });
    await mkdir(otherVault, { recursive: true });

    await registerGlobalVault({ vault: originalVault, homeDir, overwrite: false });
    const result = await backfillGlobalVaultFromEnv({ env: { OMS_VAULT: otherVault }, homeDir });
    expect(result.wrote).toBe(false);

    const config = await readGlobalConfig(homeDir);
    expect(config?.vault).toBe(originalVault);
  });

  it("backfill no-ops when OMS_VAULT unset or points at a missing dir", async () => {
    const homeDir = path.join(tmpRoot, "home5");

    const unset = await backfillGlobalVaultFromEnv({ env: {}, homeDir });
    expect(unset.wrote).toBe(false);
    expect(await readGlobalConfig(homeDir)).toBeNull();

    const missing = await backfillGlobalVaultFromEnv({
      env: { OMS_VAULT: path.join(tmpRoot, "does-not-exist") },
      homeDir,
    });
    expect(missing.wrote).toBe(false);
    expect(await readGlobalConfig(homeDir)).toBeNull();
  });

  it("backfill treats a corrupt existing config as present and does not touch it", async () => {
    const homeDir = path.join(tmpRoot, "home6");
    const otherVault = path.join(tmpRoot, "vault6-other");
    await mkdir(otherVault, { recursive: true });
    await mkdir(path.join(homeDir, ".oms"), { recursive: true });
    await writeFile(path.join(homeDir, ".oms", "config.yaml"), "not: [valid", "utf-8");

    const result = await backfillGlobalVaultFromEnv({ env: { OMS_VAULT: otherVault }, homeDir });
    expect(result.wrote).toBe(false);
  });

  it("nonFatalGlobalWriteback does not throw when homeDir/.oms cannot be created (a file occupies that path)", async () => {
    const homeDir = path.join(tmpRoot, "home7");
    await mkdir(homeDir, { recursive: true });
    // Create a FILE at <home>/.oms so mkdir(recursive) inside writeGlobalConfig fails.
    await writeFile(path.join(homeDir, ".oms"), "not a directory", "utf-8");
    const vault = path.join(tmpRoot, "vault7");
    await mkdir(vault, { recursive: true });

    const result = await nonFatalGlobalWriteback(() =>
      registerGlobalVault({ vault, homeDir, overwrite: true }),
    );
    expect(result.wrote).toBe(false);
  });
});
