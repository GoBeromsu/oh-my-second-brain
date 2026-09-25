import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../templates/file-lock.js";
import { readVaultSettings } from "../templates/vault-settings.js";
import { UUID_PATTERN } from "./types.js";

/**
 * `.oms/vault-id` is the only link between a vault and its hidden store. It is
 * separate from `settings.json` `vaultId`; the first seal may seed from it.
 */

export const VAULT_ID_PATH = ".oms/vault-id";
const MAX_VAULT_ID_BYTES = 256;

export type VaultIdRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly reason: string }
  | { readonly state: "ok"; readonly id: string };

export type VaultIdEnsure =
  | { readonly state: "ok"; readonly id: string; readonly created: boolean }
  | { readonly state: "invalid"; readonly reason: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Read-only: never creates `.oms/` or the id file. */
export async function readVaultId(vault: string): Promise<VaultIdRead> {
  const directory = join(vault, ".oms");
  const target = join(vault, VAULT_ID_PATH);
  try {
    const parent = await lstat(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) return { state: "invalid", reason: ".oms is not a real directory" };
    const leaf = await lstat(target);
    if (leaf.isSymbolicLink() || !leaf.isFile()) return { state: "invalid", reason: "vault-id is not a regular file" };
    if (leaf.size > MAX_VAULT_ID_BYTES) return { state: "invalid", reason: "vault-id is too large" };
    const text = (await readFile(target, "utf8")).trim();
    if (!UUID_PATTERN.test(text)) return { state: "invalid", reason: "vault-id is not a lowercase UUID" };
    return { state: "ok", id: text };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { state: "absent" };
    return { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function seedId(vault: string): Promise<string> {
  try {
    const settings = await readVaultSettings(vault);
    if (settings !== null && UUID_PATTERN.test(settings.vaultId)) return settings.vaultId;
  } catch {
    // Unreadable settings only lose the seed; the id is then random.
  }
  return randomUUID();
}

/** Seal-time only. An invalid existing file is reported, never overwritten. */
export async function ensureVaultId(vault: string): Promise<VaultIdEnsure> {
  const current = await readVaultId(vault);
  if (current.state === "ok") return { state: "ok", id: current.id, created: false };
  if (current.state === "invalid") return current;
  const id = await seedId(vault);
  try {
    await atomicWrite(join(vault, VAULT_ID_PATH), `${id}\n`);
  } catch (error: unknown) {
    return { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  return { state: "ok", id, created: true };
}
