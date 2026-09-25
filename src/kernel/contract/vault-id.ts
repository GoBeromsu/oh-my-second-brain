import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { atomicWrite } from "./fs-private.js";
import { readIndex, readStore, storeExists, storeRoot } from "./store.js";
import type { ContractView } from "./types.js";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH, type VaultSettings } from "../vault/settings.js";
import { verifyControlPath } from "../vault/paths.js";

/**
 * Seal-state resolution (the index truth table). S = settings `vaultId`, I = the index
 * entry for this vault's realpath, St(x) = the store link for x exists. Read-only.
 */

export type SealRow =
  | "never-sealed"
  | "synced-second-machine"
  | "store-without-index"
  | "vault-moved"
  | "sealed"
  | "index-without-store"
  | "vault-id-tampered"
  | "index-corrupt";

export interface SealState {
  readonly row: SealRow;
  readonly view: ContractView;
  /** S; null when absent or unreadable. Never printed. */
  readonly vaultId: string | null;
  /** True when another existing vault path maps to the same id. */
  readonly shared: boolean;
  readonly settingsInvalid: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function settingsId(vault: string): Promise<{ readonly id: string | null; readonly invalid: boolean }> {
  try {
    const settings = await readVaultSettings(vault);
    return { id: settings?.vaultId ?? null, invalid: false };
  } catch {
    return { id: null, invalid: true };
  }
}

async function load(vaultId: string, root: string): Promise<ContractView> {
  const read = await readStore(vaultId, root);
  return read.state === "ok" ? { state: "sealed", contract: read.contract } : { state: "unreadable" };
}

export async function resolveSealState(vault: string, root: string = storeRoot()): Promise<SealState> {
  const vaultRealPath = await realpath(vault);
  const settings = await settingsId(vault);
  const s = settings.id;
  const base = { vaultId: s, settingsInvalid: settings.invalid };
  const index = await readIndex(root);

  if (index.state === "corrupt") {
    const view: ContractView = s !== null && await storeExists(s, root) ? await load(s, root) : { state: "open" };
    return { ...base, row: "index-corrupt", view, shared: false };
  }
  const entries = index.state === "ok" ? index.entries : {};
  const others = Object.entries(entries).filter(([path, id]) => path !== vaultRealPath && id === s);
  let shared = false;
  for (const [path] of others) if (await exists(path)) shared = true;
  const i = Object.hasOwn(entries, vaultRealPath) ? entries[vaultRealPath]! : null;

  if (i !== null) {
    if (s !== i) return { ...base, row: "vault-id-tampered", view: { state: "unreadable" }, shared };
    if (!await storeExists(i, root)) return { ...base, row: "index-without-store", view: { state: "unreadable" }, shared };
    return { ...base, row: "sealed", view: await load(i, root), shared };
  }
  if (s === null) return { ...base, row: "never-sealed", view: { state: "open" }, shared: false };
  if (!await storeExists(s, root)) return { ...base, row: "synced-second-machine", view: { state: "open" }, shared };
  return { ...base, row: others.length > 0 ? "vault-moved" : "store-without-index", view: await load(s, root), shared };
}

/** Seal time only: replaces `.oms/settings.json` atomically after validating the new settings. */
export async function writeVaultSettings(vault: string, settings: VaultSettings): Promise<void> {
  const bytes = serializeVaultSettings(settings);
  const verified = await verifyControlPath(vault, SETTINGS_PATH, { expected: "either" });
  await atomicWrite(verified.absolutePath, bytes);
}

/** Seal time only: returns the settings `vaultId`, issuing one when settings are absent. */
export async function ensureVaultId(vault: string): Promise<string> {
  const existing = await readVaultSettings(vault);
  if (existing !== null) return existing.vaultId;
  const settings: VaultSettings = { version: 1, vaultId: randomUUID() };
  await writeVaultSettings(vault, settings);
  return settings.vaultId;
}
