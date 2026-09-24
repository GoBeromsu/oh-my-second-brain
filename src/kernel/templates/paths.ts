import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DestinationClass, ManagedTemplatePath, TemplateFolderPath, TemplateFolderRegistration, TemplateId, TemplateSourcePath } from "./types.js";
const ID = /^[\p{L}\p{N}]+(?:-{1,2}[\p{L}\p{N}]+)*$/u;
const INTERNAL = new Set([".oms", ".gjc", ".git", ".obsidian", ".template-transactions"]);
const CONTROLS = new Set([".oms/template-policy.json", ".oms/settings.json", ".oms/types.json", ".oms/taxonomy.json", ".oms/template-transaction.json", ".oms/template-interview.json"]);
const CONTROL_NAMESPACE = /^\.oms\/(?:\.template-transactions|migrations)\/[a-z0-9-]+(?:\/[a-z0-9._-]+)*$/;
const HISTORY_RECORD = /^\.oms\/history\/contracts\/(?:0|[1-9][0-9]{0,15})\.json$/;
export type TemplateControlPath = string & { readonly __kind: "TemplateControlPath" };
export interface VerifiedVaultPath<T extends TemplateFolderPath | TemplateSourcePath | TemplateControlPath | ManagedTemplatePath> { readonly vaultRoot: string; readonly vaultRelativePath: T; readonly absolutePath: string; readonly targetRealPath: string | null; }
export interface VaultPathVerificationOptions { readonly expected: "existing-file" | "absent" | "either"; }
function unsafe(message: string): never { throw new TypeError(`TEMPLATE_SOURCE_UNSAFE: ${message}`); }
function invalid(message: string): never { throw new TypeError(`TEMPLATE_SOURCE_INVALID: ${message}`); }
function segments(value: string): string[] { if (value.includes("\0")) unsafe("NUL is not allowed"); const path = value.normalize("NFC").replaceAll("\\", "/"); if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) unsafe("absolute, UNC, and drive paths are not allowed"); const result: string[] = []; for (const raw of path.split("/")) { if (raw === "" || raw === ".") continue; if (raw === "..") unsafe("parent segments are not allowed"); const segment = raw.normalize("NFC"); if (segment.startsWith(".") || INTERNAL.has(segment.toLowerCase())) unsafe("hidden or internal segments are not allowed"); result.push(segment); } if (!result.length) unsafe("path must not be empty"); return result; }
export function validateTemplateId(value: string): TemplateId { const canonical = value.normalize("NFC"); if (!ID.test(canonical)) invalid("templateId must contain Unicode letters or digits with internal hyphens"); return canonical as TemplateId; }
export function normalizeTemplateFolderPath(value: string): TemplateFolderPath { return segments(value).join("/") as TemplateFolderPath; }
export function normalizeTemplateSourcePath(value: string): TemplateSourcePath { const parts = segments(value); const leaf = parts[parts.length - 1]!; if (!leaf.endsWith(".md") || leaf.length === 3) invalid("source path must end in a non-empty lowercase .md leaf"); return parts.join("/") as TemplateSourcePath; }
/** Only convention controls, approved history records, and per-transaction staging are internal paths. */
export function normalizeTemplateControlPath(value: string): TemplateControlPath {
  const path = value.normalize("NFC").replaceAll("\\", "/");
  if (CONTROLS.has(path) || HISTORY_RECORD.test(path)) return path as TemplateControlPath;
  if (CONTROL_NAMESPACE.test(path) && !path.split("/").some(segment => segment === "." || segment === "..")) return path as TemplateControlPath;
  unsafe("path is not an approved template control or staging path");
}
/** Only the approved default/individual draft namespace, never an ordinary source or arbitrary control. */
export function normalizeManagedTemplatePath(value: string): ManagedTemplatePath {
  const path = value.normalize("NFC").replaceAll("\\", "/");
  const match = /^\.oms\/templates\/([^/]+)\.md$/.exec(path);
  if (match === null) unsafe("managed draft must be .oms/templates/<templateId>.md");
  validateTemplateId(match[1]!);
  return path as ManagedTemplatePath;
}
export async function verifyManagedTemplatePath(
  vaultRoot: string,
  managedPath: string,
  options: VaultPathVerificationOptions = { expected: "existing-file" },
): Promise<VerifiedVaultPath<ManagedTemplatePath>> {
  const normalized = normalizeManagedTemplatePath(managedPath);
  const root = await realpath(vaultRoot);
  const absolutePath = resolve(root, normalized);
  await rejectSymlinkSegments(root, normalized);
  try {
    const entry = await lstat(absolutePath);
    if (!entry.isFile()) invalid("managed draft must be a regular file");
    if (options.expected === "absent") invalid("managed draft must be absent");
    const targetRealPath = await realpath(absolutePath);
    if (!contained(root, targetRealPath)) unsafe("managed draft escapes vault root");
    return { vaultRoot: root, vaultRelativePath: normalized, absolutePath, targetRealPath };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (options.expected === "existing-file") invalid("managed draft must exist");
  if (!contained(root, await realpath(await ancestor(absolutePath)))) unsafe("managed draft ancestor escapes vault root");
  if (await caseCollision(absolutePath)) invalid("managed draft collides by case with an existing entry");
  return { vaultRoot: root, vaultRelativePath: normalized, absolutePath, targetRealPath: null };
}
export function canonicalPathKey(path: TemplateFolderPath | TemplateSourcePath): string { return path.normalize("NFC"); }
export function deriveManagedSourcePath(folder: TemplateFolderPath, id: TemplateId): TemplateSourcePath { return normalizeTemplateSourcePath(`${folder}/${id}.md`); }
export function isTemplateSourceInFolder(sourcePath: TemplateSourcePath, folder: TemplateFolderPath): boolean { return sourcePath.startsWith(`${folder}/`); }
export function selectTemplateFolder(folders: readonly TemplateFolderRegistration[], selected?: TemplateFolderPath): TemplateFolderRegistration {
  if (selected !== undefined) {
    const match = folders.find(folder => folder.path === selected);
    if (match === undefined) invalid(`${selected} is not a registered template folder`);
    return match;
  }
  const fallback = folders.find(folder => folder.default === true);
  if (fallback === undefined) throw new TypeError("TEMPLATE_FOLDER_DEFAULT_UNDECLARED: no default template folder is registered");
  return fallback;
}
export function deriveTemplateSourcePath(binding: { readonly destinationClass: DestinationClass; readonly templateId: TemplateId; readonly sourceFolder: TemplateFolderPath; readonly sourcePath: TemplateSourcePath }): TemplateSourcePath {
  return binding.destinationClass === "managed-default" ? deriveManagedSourcePath(binding.sourceFolder, binding.templateId) : binding.sourcePath;
}
function contained(root: string, path: string): boolean { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); }
async function ancestor(path: string): Promise<string> { let current = path; while (true) { try { if ((await lstat(current)).isSymbolicLink()) unsafe("symlink ancestor is not allowed for a new target"); return current; } catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; const parent = resolve(current, ".."); if (parent === current) unsafe("path has no existing vault ancestor"); current = parent; } } }
async function caseCollision(path: string): Promise<boolean> { const parent = resolve(path, ".."); const leaf = path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)); try { return (await readdir(parent)).some(entry => entry !== leaf && entry.normalize("NFC").toLocaleLowerCase("en-US") === leaf.normalize("NFC").toLocaleLowerCase("en-US")); } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; } }
async function rejectSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) unsafe("symlink ancestors and leaves are not allowed");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
export async function verifyVaultPath<T extends TemplateFolderPath | TemplateSourcePath>(vaultRoot: string, vaultRelativePath: T, options: VaultPathVerificationOptions): Promise<VerifiedVaultPath<T>> { const root = await realpath(vaultRoot); const absolutePath = resolve(root, vaultRelativePath); if (!contained(root, absolutePath)) unsafe("path escapes vault root"); await rejectSymlinkSegments(root, vaultRelativePath); try { const stat = await lstat(absolutePath); if (stat.isSymbolicLink()) unsafe("symlink leaf is not allowed"); if (options.expected === "absent") invalid("path must be absent"); if (options.expected === "existing-file" && !stat.isFile()) invalid("source path must be a regular file"); const targetRealPath = await realpath(absolutePath); if (!contained(root, targetRealPath)) unsafe("resolved path escapes vault root"); return { vaultRoot: root, vaultRelativePath, absolutePath, targetRealPath }; } catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; } if (options.expected === "existing-file") invalid("registered source path must exist"); const existing = await ancestor(absolutePath); if (!contained(root, await realpath(existing))) unsafe("nearest existing ancestor escapes vault root"); if (await caseCollision(absolutePath)) invalid("path collides by case with an existing entry"); return { vaultRoot: root, vaultRelativePath, absolutePath, targetRealPath: null }; }
export async function verifyTemplateSourcePath(vaultRoot: string, sourcePath: TemplateSourcePath, options: VaultPathVerificationOptions = { expected: "existing-file" }): Promise<VerifiedVaultPath<TemplateSourcePath>> { return verifyVaultPath(vaultRoot, sourcePath, options); }
export async function verifyTemplateFolderPath(vaultRoot: string, folder: TemplateFolderPath): Promise<VerifiedVaultPath<TemplateFolderPath>> { return verifyVaultPath(vaultRoot, folder, { expected: "either" }); }
export async function verifyTemplateControlPath(vaultRoot: string, controlPath: TemplateControlPath, options: VaultPathVerificationOptions): Promise<VerifiedVaultPath<TemplateControlPath>> {
  controlPath = normalizeTemplateControlPath(controlPath);
  const root = await realpath(vaultRoot);
  const absolutePath = resolve(root, controlPath);
  if (!contained(root, absolutePath)) unsafe("path escapes vault root");
  await rejectSymlinkSegments(root, controlPath);
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) unsafe("symlink control is not allowed");
    if (options.expected === "absent") invalid("control path must be absent");
    if (options.expected === "existing-file" && !stat.isFile()) invalid("control path must be a regular file");
    const targetRealPath = await realpath(absolutePath);
    if (!contained(root, targetRealPath)) unsafe("resolved control path escapes vault root");
    return { vaultRoot: root, vaultRelativePath: controlPath, absolutePath, targetRealPath };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (options.expected === "existing-file") invalid("control path must exist");
  const existing = await ancestor(absolutePath);
  if (!contained(root, await realpath(existing))) unsafe("nearest existing ancestor escapes vault root");
  if (await caseCollision(absolutePath)) invalid("control path collides by case with an existing entry");
  return { vaultRoot: root, vaultRelativePath: controlPath, absolutePath, targetRealPath: null };
}
