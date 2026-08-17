import { stat } from "node:fs/promises";
import { readGlobalConfig, writeGlobalConfig } from "../link/global-config.js";

export interface RegisterGlobalVaultOptions {
  readonly vault: string;
  readonly homeDir?: string;
  readonly overwrite: boolean;
}

export interface GlobalWritebackResult {
  readonly wrote: boolean;
  readonly reason?: string;
}

/**
 * Register `vault` in the global config (`<homeDir>/.oms/config.yaml`).
 * When `overwrite` is false, does nothing if a global config already exists
 * (including when reading the existing config throws, e.g. a corrupt file -
 * a corrupt-but-present config is treated as "config exists, do not touch").
 */
export async function registerGlobalVault(options: RegisterGlobalVaultOptions): Promise<GlobalWritebackResult> {
  const { vault, homeDir, overwrite } = options;
  if (!overwrite) {
    let existing;
    try {
      existing = await readGlobalConfig(homeDir);
    } catch {
      return { wrote: false, reason: "existing global config is present but unreadable" };
    }
    if (existing !== null) {
      return { wrote: false, reason: "existing global config present" };
    }
  }
  await writeGlobalConfig({ version: 1, vault }, homeDir);
  return { wrote: true };
}

export interface BackfillGlobalVaultOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

/**
 * Migration backfill: when no global config exists yet and `OMS_VAULT` points
 * at an existing directory, register it. Never overwrites an existing config
 * (including a corrupt-but-present one).
 */
export async function backfillGlobalVaultFromEnv(options: BackfillGlobalVaultOptions): Promise<GlobalWritebackResult> {
  const { env, homeDir } = options;
  const omsVault = env["OMS_VAULT"];
  if (omsVault === undefined || omsVault.trim().length === 0) {
    return { wrote: false, reason: "OMS_VAULT not set" };
  }

  let existing;
  try {
    existing = await readGlobalConfig(homeDir);
  } catch {
    return { wrote: false, reason: "existing global config is present but unreadable" };
  }
  if (existing !== null) {
    return { wrote: false, reason: "existing global config present" };
  }

  try {
    const stats = await stat(omsVault);
    if (!stats.isDirectory()) {
      return { wrote: false, reason: "OMS_VAULT does not point at a directory" };
    }
  } catch {
    return { wrote: false, reason: "OMS_VAULT does not point at an existing directory" };
  }

  await writeGlobalConfig({ version: 1, vault: omsVault }, homeDir);
  return { wrote: true };
}

/**
 * Run a global write-back action, swallowing any failure into a single
 * `[oms] warning:` line on stderr. Never throws.
 */
export async function nonFatalGlobalWriteback(
  action: () => Promise<GlobalWritebackResult>,
): Promise<GlobalWritebackResult> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[oms] warning: could not update global vault registry (${message})`);
    return { wrote: false, reason: message };
  }
}
