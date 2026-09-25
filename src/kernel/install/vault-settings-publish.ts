import { atomicWrite } from "../contract/fs-private.js";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH, type VaultSettings } from "../vault/settings.js";
import { verifyControlPath } from "../vault/paths.js";

/** Publishes `.oms/settings.json`, the only vault-internal OMS file, and reads it back. */
export async function publishVaultSettings(vault: string, settings: VaultSettings): Promise<VaultSettings> {
  const bytes = serializeVaultSettings(settings);
  const verified = await verifyControlPath(vault, SETTINGS_PATH, { expected: "either" });
  await atomicWrite(verified.absolutePath, bytes);
  const readback = await readVaultSettings(vault);
  if (readback === null || serializeVaultSettings(readback) !== bytes) {
    throw new Error("VAULT_SETTINGS_READBACK_FAILED: settings.json did not read back as published");
  }
  return readback;
}

/** Merges an embedding model into existing settings. Settings must already exist (`oms setup` issues them). */
export async function publishEmbeddingModel(vault: string, model: string): Promise<VaultSettings> {
  const current = await readVaultSettings(vault);
  if (current === null) throw new Error("VAULT_SETTINGS_MISSING: run `oms setup` before selecting an embedding model");
  return publishVaultSettings(vault, { ...current, embedding: { model } });
}
