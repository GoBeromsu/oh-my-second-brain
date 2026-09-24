import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { normalizeTemplateControlPath, normalizeTemplateFolderPath, verifyTemplateControlPath } from "./paths.js";
import { parseLegacyJson } from "./legacy-json.js";

export interface VaultSettings {
  readonly version: 1;
  readonly vaultId: string;
  readonly templateRoots: readonly string[];
  readonly defaultRoot?: string | null;
  readonly agentRepair?: {
    readonly enabled: boolean;
    readonly contexts?: readonly ("post-write" | "maintenance")[];
  };
}
export class VaultSettingsError extends Error {
  constructor(readonly code: "VAULT_SETTINGS_INVALID" | "VAULT_SETTINGS_VERSION_UNSUPPORTED", message: string) {
    super(`${code}: ${message}`);
    this.name = "VaultSettingsError";
  }
}
const SETTINGS_PATH = ".oms/settings.json";
const MAX_SETTINGS_BYTES = 262_144;
function invalid(message: string): never { throw new VaultSettingsError("VAULT_SETTINGS_INVALID", message); }
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

/** User-owned portable settings; unknown JSON survives without becoming executable configuration. */
export function parseVaultSettings(bytes: string): VaultSettings {
  if (Buffer.byteLength(bytes) > MAX_SETTINGS_BYTES) invalid("settings exceed the 256 KiB limit");
  let parsed: ReturnType<typeof parseLegacyJson>;
  try { parsed = parseLegacyJson(bytes); }
  catch { invalid("settings must be valid JSON"); }
  // JSON.parse last-wins is not a portable identity. Only exhaustively unique members may authorize one.
  if (parsed.members !== "unique") invalid("settings JSON contains ambiguous or duplicate members and cannot authorize a vault identity");
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("settings must be a JSON object");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new VaultSettingsError("VAULT_SETTINGS_VERSION_UNSUPPORTED", "only settings version 1 is supported");
  if (typeof input.vaultId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.vaultId)) invalid("vaultId must be a lowercase UUID");
  if (!Array.isArray(input.templateRoots) || !input.templateRoots.every(root => typeof root === "string")) invalid("templateRoots must be an explicit array of vault-relative folders");
  const seen = new Set<string>();
  for (const root of input.templateRoots as string[]) {
    try {
      if (normalizeTemplateFolderPath(root) !== root) invalid("template roots must be canonical vault-relative folders");
    } catch (error) { invalid(error instanceof Error ? error.message : "unsafe template root"); }
    if (seen.has(root)) invalid("templateRoots contains duplicate folders");
    seen.add(root);
  }
  if (Object.hasOwn(input, "defaultRoot") && input.defaultRoot !== null && (typeof input.defaultRoot !== "string" || !seen.has(input.defaultRoot))) invalid("defaultRoot must be null or one of the configured templateRoots");
  if (Object.hasOwn(input, "agentRepair")) {
    if (input.agentRepair === null || typeof input.agentRepair !== "object" || Array.isArray(input.agentRepair)) invalid("agentRepair must be an object");
    const repair = input.agentRepair as Record<string, unknown>;
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
  const verified = await verifyTemplateControlPath(vault, normalizeTemplateControlPath(SETTINGS_PATH), { expected: "either" });
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
    const revalidated = await verifyTemplateControlPath(verified.vaultRoot, normalizeTemplateControlPath(SETTINGS_PATH), { expected: "either" });
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
