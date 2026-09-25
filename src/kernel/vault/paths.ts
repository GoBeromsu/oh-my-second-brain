import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const INTERNAL = new Set([".oms", ".gjc", ".git", ".obsidian"]);
/** The only vault-internal file OMS owns. Everything else OMS keeps lives outside the vault. */
const CONTROLS = new Set([".oms/settings.json"]);

export interface VerifiedVaultPath<T extends string> { readonly vaultRoot: string; readonly vaultRelativePath: T; readonly absolutePath: string; readonly targetRealPath: string | null; }
export interface VaultPathVerificationOptions { readonly expected: "existing-file" | "absent" | "either"; }

function unsafe(message: string): never { throw new TypeError(`TEMPLATE_SOURCE_UNSAFE: ${message}`); }
function invalid(message: string): never { throw new TypeError(`TEMPLATE_SOURCE_INVALID: ${message}`); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function segments(value: string): string[] {
  if (value.includes("\0")) unsafe("NUL is not allowed");
  const path = value.normalize("NFC").replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) unsafe("absolute, UNC, and drive paths are not allowed");
  const result: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") unsafe("parent segments are not allowed");
    if (raw.startsWith(".") || INTERNAL.has(raw.toLowerCase())) unsafe("hidden or internal segments are not allowed");
    result.push(raw);
  }
  if (!result.length) unsafe("path must not be empty");
  return result;
}

/** Canonical vault-relative folder: NFC, forward slashes, no hidden, internal or parent segments. */
export function normalizeFolderPath(value: string): string { return segments(value).join("/"); }
export function normalizeTemplateSourcePath<T extends string = string>(value: string): T {
  const parts = segments(value);
  const leaf = parts[parts.length - 1]!;
  if (!leaf.endsWith(".md") || leaf.length === 3) invalid("source path must end in a non-empty lowercase .md leaf");
  return parts.join("/") as T;
}

/** A vault-relative path naming an OMS control file, compared after separator and NFC normalization. */
export function isControlPath(vaultRelativePath: string): boolean {
  const path = vaultRelativePath.normalize("NFC").replaceAll("\\", "/").split("/").filter(part => part !== "" && part !== ".").join("/");
  return CONTROLS.has(path) || CONTROLS.has(path.toLowerCase());
}

export function contained(root: string, path: string): boolean { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); }

async function ancestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) unsafe("symlink ancestor is not allowed for a new target");
      return current;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      const parent = resolve(current, "..");
      if (parent === current) unsafe("path has no existing vault ancestor");
      current = parent;
    }
  }
}
async function caseCollision(path: string): Promise<boolean> {
  const parent = dirname(path);
  const leaf = basename(path);
  try { return (await readdir(parent)).some(entry => entry !== leaf && entry.normalize("NFC").toLocaleLowerCase("en-US") === leaf.normalize("NFC").toLocaleLowerCase("en-US")); }
  catch (error: unknown) { if (isMissing(error)) return false; throw error; }
}
async function rejectSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) unsafe("symlink ancestors and leaves are not allowed"); }
    catch (error: unknown) { if (isMissing(error)) return; throw error; }
  }
}

async function verify<T extends string>(vaultRoot: string, vaultRelativePath: T, options: VaultPathVerificationOptions, subject: string): Promise<VerifiedVaultPath<T>> {
  const root = await realpath(vaultRoot);
  const absolutePath = resolve(root, vaultRelativePath);
  if (!contained(root, absolutePath)) unsafe("path escapes vault root");
  await rejectSymlinkSegments(root, vaultRelativePath);
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) unsafe("symlink leaf is not allowed");
    if (options.expected === "absent") invalid(`${subject} must be absent`);
    if (options.expected === "existing-file" && !stat.isFile()) invalid(`${subject} must be a regular file`);
    const targetRealPath = await realpath(absolutePath);
    if (!contained(root, targetRealPath)) unsafe("resolved path escapes vault root");
    return { vaultRoot: root, vaultRelativePath, absolutePath, targetRealPath };
  } catch (error: unknown) { if (!isMissing(error)) throw error; }
  if (options.expected === "existing-file") invalid(`${subject} must exist`);
  const existing = await ancestor(absolutePath);
  if (!contained(root, await realpath(existing))) unsafe("nearest existing ancestor escapes vault root");
  if (await caseCollision(absolutePath)) invalid(`${subject} collides by case with an existing entry`);
  return { vaultRoot: root, vaultRelativePath, absolutePath, targetRealPath: null };
}

export async function verifyVaultPath<T extends string>(vaultRoot: string, vaultRelativePath: T, options: VaultPathVerificationOptions): Promise<VerifiedVaultPath<T>> {
  return verify(vaultRoot, vaultRelativePath, options, options.expected === "existing-file" ? "registered source path" : "path");
}

/** The settings control is the one internal path that may be read; its segments bypass the hidden-segment rule. */
export async function verifyControlPath(vaultRoot: string, controlPath: string, options: VaultPathVerificationOptions): Promise<VerifiedVaultPath<string>> {
  const path = controlPath.normalize("NFC").replaceAll("\\", "/");
  if (!CONTROLS.has(path)) unsafe("path is not an approved control path");
  return verify(vaultRoot, path, options, "control path");
}

/**
 * Absolute real location of a write target. Existing targets are realpathed; a missing target
 * realpaths its nearest existing ancestor and re-appends the missing segments.
 */
export async function resolveRealTarget(target: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, target);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error: unknown) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Vault-relative form of a real target, or null when it is outside the (realpathed) vault root. */
export function vaultRelative(vaultRealRoot: string, realTarget: string): string | null {
  const r = relative(vaultRealRoot, realTarget);
  if (r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return r.split(sep).join("/");
}
