import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseStrictJson } from "../conventions/strict-json.js";
import { normalizeFolderPath, verifyControlPath } from "./paths.js";

export type AgentRepairContext = "post-write" | "maintenance";
/** The one vault-internal OMS file: template folder, embedding model and vault identity. */
export interface VaultSettings {
  readonly version: 1;
  readonly vaultId: string;
  readonly templateFolder?: string;
  readonly embedding?: { readonly model: string };
  readonly agentRepair?: {
    readonly enabled: boolean;
    readonly contexts?: readonly AgentRepairContext[];
  };
}
export class VaultSettingsError extends Error {
  constructor(readonly code: "VAULT_SETTINGS_INVALID" | "VAULT_SETTINGS_VERSION_UNSUPPORTED", message: string) {
    super(`${code}: ${message}`);
    this.name = "VaultSettingsError";
  }
}
export const SETTINGS_PATH = ".oms/settings.json";
export const VAULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SETTINGS_BYTES = 262_144;
const KEYS = new Set(["version", "vaultId", "templateFolder", "embedding", "agentRepair"]);
function invalid(message: string): never { throw new VaultSettingsError("VAULT_SETTINGS_INVALID", message); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(`${name} contains an unknown key`);
}
function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function stableLeaf(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.isFile() && right.isFile() && !right.isSymbolicLink() && left.nlink === 1 && right.nlink === 1 && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function identityAncestors(root: string, absolute: string): Promise<readonly { readonly path: string; readonly stat: Stats }[]> {
  const relative = absolute.slice(root.length).split(sep).filter(part => part.length > 0);
  const observed: { path: string; stat: Stats }[] = [];
  let current = root;
  for (const segment of ["", ...relative.slice(0, -1)]) {
    current = segment.length === 0 ? root : resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) invalid("settings ancestor is not a real private directory");
    observed.push({ path: current, stat });
  }
  return observed;
}

/** Strict: unknown keys, duplicate members and non-canonical folders are refused rather than ignored. */
export function parseVaultSettings(bytes: string): VaultSettings {
  let value: unknown;
  try { value = parseStrictJson(bytes, MAX_SETTINGS_BYTES); }
  catch { invalid("settings must be unique-member JSON within the 256 KiB limit"); }
  const input = object(value, "settings");
  if (input.version !== 1) throw new VaultSettingsError("VAULT_SETTINGS_VERSION_UNSUPPORTED", "only settings version 1 is supported");
  onlyKeys(input, KEYS, "settings");
  if (typeof input.vaultId !== "string" || !VAULT_ID_PATTERN.test(input.vaultId)) invalid("vaultId must be a lowercase UUID");
  if (Object.hasOwn(input, "templateFolder")) {
    if (typeof input.templateFolder !== "string") invalid("templateFolder must be a vault-relative folder");
    let canonical: string;
    try { canonical = normalizeFolderPath(input.templateFolder); }
    catch (error) { invalid(error instanceof Error ? error.message : "unsafe templateFolder"); }
    if (canonical !== input.templateFolder) invalid("templateFolder must be a canonical vault-relative folder");
  }
  if (Object.hasOwn(input, "embedding")) {
    const embedding = object(input.embedding, "embedding");
    onlyKeys(embedding, new Set(["model"]), "embedding");
    if (typeof embedding.model !== "string" || embedding.model.trim() === "") invalid("embedding.model must be a non-empty string");
  }
  if (Object.hasOwn(input, "agentRepair")) {
    const repair = object(input.agentRepair, "agentRepair");
    onlyKeys(repair, new Set(["enabled", "contexts"]), "agentRepair");
    if (typeof repair.enabled !== "boolean") invalid("agentRepair.enabled must be boolean");
    if (Object.hasOwn(repair, "contexts")) {
      if (!Array.isArray(repair.contexts) || !repair.contexts.every(context => context === "post-write" || context === "maintenance")) invalid("agentRepair.contexts must contain only post-write or maintenance");
      if (new Set(repair.contexts).size !== repair.contexts.length) invalid("agentRepair.contexts must not repeat");
    }
  }
  return value as VaultSettings;
}
export function serializeVaultSettings(settings: VaultSettings): string {
  const bytes = `${JSON.stringify(settings, null, 2)}\n`;
  parseVaultSettings(bytes);
  return bytes;
}

/** Missing settings are not invented or published during status, search, boot or discovery. */
export async function readVaultSettings(vault: string): Promise<VaultSettings | null> {
  const verified = await verifyControlPath(vault, SETTINGS_PATH, { expected: "either" });
  if (verified.targetRealPath === null) return null;
  const ancestors = await identityAncestors(verified.vaultRoot, verified.absolutePath);
  const initial = await lstat(verified.absolutePath);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1) invalid("settings must be a regular non-hardlinked control file");
  if (!Number.isSafeInteger(initial.size) || initial.size > MAX_SETTINGS_BYTES) invalid("settings exceed the 256 KiB limit");
  const handle = await open(verified.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!stableLeaf(initial, before)) invalid("settings identity changed before reading");
    const buffer = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) invalid("settings returned an invalid byte count");
      total += bytesRead;
    }
    const after = await handle.stat();
    if (!stableLeaf(before, after) || total !== before.size) invalid("settings changed or exceeded its bound while reading");
    const revalidated = await verifyControlPath(verified.vaultRoot, SETTINGS_PATH, { expected: "either" });
    if (revalidated.targetRealPath === null || revalidated.absolutePath !== verified.absolutePath) invalid("settings disappeared or moved during observation");
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, ancestor.stat)) invalid("settings ancestor changed during observation");
    }
    const leaf = await lstat(verified.absolutePath);
    if (!stableLeaf(after, leaf)) invalid("settings path no longer names the observed identity");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)); }
    catch { invalid("settings must contain valid UTF-8"); }
    return parseVaultSettings(text);
  } finally { await handle.close(); }
}
