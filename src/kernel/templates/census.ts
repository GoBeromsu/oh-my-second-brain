import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { digestBytes } from "./canonical.js";
import {
  normalizeTemplateFolderPath,
  normalizeTemplateSourcePath,
  verifyTemplateFolderPath,
  verifyTemplateSourcePath,
} from "./paths.js";
import type { Digest, TemplateId, TemplateSourcePath } from "./types.js";

/**
 * Read-only inventory of raw template candidates.
 * Bytes are digested exactly and decoded as UTF-8 without stripping a BOM or
 * rewriting newlines. Templater, JavaScript, tokens, and frontmatter are not
 * parsed or executed. A new file name is not a template id.
 */

/** Historical source cap previously published by the removed renderer. */
export const MAX_TEMPLATE_SOURCE_BYTES = 262_144;
const MAX_TEMPLATE_SOURCE_DEPTH = 16;
const MAX_TEMPLATE_SOURCE_FILES = 10_000;
const MAX_TEMPLATE_SOURCE_DIRECTORIES = 2_048;

export interface CensusDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly templateId?: TemplateId;
}

export interface TemplateCensusSelection {
  readonly path: string;
  readonly kind: "file" | "folder";
}

export interface CensusSource {
  readonly path: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly rawDigest: Digest;
  /** UTF-8 with the BOM retained. Null when the bytes are not UTF-8. */
  readonly text: string | null;
  readonly diagnostics: readonly CensusDiagnostic[];
}

interface ReadySource {
  readonly path: TemplateSourcePath;
  readonly bytes: Uint8Array;
  readonly rawDigest: Digest;
  readonly text: string | null;
  readonly diagnostics: CensusDiagnostic[];
}

interface Budget {
  files: number;
  directories: number;
  exhausted: boolean;
}

function compareText(left: string, right: string): number {
  const leftCodes = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightCodes = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(leftCodes.length, rightCodes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftCodes[index]! - rightCodes[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodes.length - rightCodes.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prefixedCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error && error.code === "ELOOP") return "TEMPLATE_SOURCE_UNSAFE";
  const code = errorMessage(error).split(":", 1)[0] ?? "";
  return /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : fallback;
}

function diagnostic(code: string, message: string, path?: string, templateId?: TemplateId): CensusDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(templateId === undefined ? {} : { templateId }),
  };
}

function pushDiagnostic(diagnostics: CensusDiagnostic[], value: CensusDiagnostic): void {
  if (diagnostics.some(item => item.code === value.code && item.path === value.path && item.templateId === value.templateId && item.message === value.message)) return;
  diagnostics.push(value);
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function vaultRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

function decodeRaw(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function readBounded(root: string, absolutePath: string): Promise<{ readonly bytes?: Uint8Array; readonly oversized: boolean }> {
  const parent = dirname(absolutePath);
  const canonicalParent = await realpath(parent);
  if (!contained(root, canonicalParent)) throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} has a parent outside the vault`);
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} is not a regular file`);
    if (before.size > MAX_TEMPLATE_SOURCE_BYTES) return { oversized: true };
    const buffer = Buffer.alloc(MAX_TEMPLATE_SOURCE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
        throw new Error(`TEMPLATE_SOURCE_READ_FAILED: invalid byte count returned for ${absolutePath}`);
      }
      total += bytesRead;
    }
    const after = await handle.stat();
    if (!contained(root, await realpath(parent)) || !contained(root, await realpath(absolutePath))) {
      throw new Error(`TEMPLATE_SOURCE_UNSAFE: ${absolutePath} escaped the vault while reading`);
    }
    if (total > MAX_TEMPLATE_SOURCE_BYTES || after.size > MAX_TEMPLATE_SOURCE_BYTES) return { oversized: true };
    if (after.size !== before.size || total !== after.size) {
      throw new Error(`TEMPLATE_SOURCE_READ_FAILED: ${absolutePath} changed while reading`);
    }
    return { bytes: new Uint8Array(buffer.subarray(0, total)), oversized: false };
  } finally {
    await handle.close();
  }
}

async function readCandidate(root: string, sourcePath: TemplateSourcePath): Promise<
  | { readonly state: "absent" }
  | { readonly state: "blocked"; readonly diagnostic: CensusDiagnostic }
  | { readonly state: "ready"; readonly source: ReadySource }
> {
  let absolutePath: string;
  try {
    const verified = await verifyTemplateSourcePath(root, sourcePath, { expected: "either" });
    if (verified.targetRealPath === null) return { state: "absent" };
    absolutePath = verified.absolutePath;
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_READ_FAILED"), `Template source cannot be verified: ${errorMessage(error)}`, sourcePath) };
  }
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template source cannot be read: ${errorMessage(error)}`, sourcePath) };
  }
  if (stat.isSymbolicLink()) return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink template entry is skipped", sourcePath) };
  if (!stat.isFile()) return { state: "blocked", diagnostic: diagnostic("TEMPLATE_SOURCE_INVALID", "Template source is not a regular file", sourcePath) };
  try {
    const bounded = await readBounded(root, absolutePath);
    if (bounded.oversized || bounded.bytes === undefined) {
      return {
        state: "blocked",
        diagnostic: diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source exceeds the ${MAX_TEMPLATE_SOURCE_BYTES}-byte source limit`, sourcePath),
      };
    }
    const bytes = bounded.bytes;
    const diagnostics: CensusDiagnostic[] = [];
    let text: string | null = null;
    try {
      text = decodeRaw(bytes);
    } catch {
      diagnostics.push(diagnostic("TEMPLATE_SOURCE_MALFORMED", "Template source is not valid UTF-8; bytes were not decoded or parsed", sourcePath));
    }
    return { state: "ready", source: { path: sourcePath, bytes, rawDigest: digestBytes(bytes), text, diagnostics } };
  } catch (error: unknown) {
    return { state: "blocked", diagnostic: diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_READ_FAILED"), `Template source cannot be read: ${errorMessage(error)}`, sourcePath) };
  }
}

function exhaust(budget: Budget, diagnostics: CensusDiagnostic[], path: string, kind: "files" | "directories"): boolean {
  if (budget.exhausted) return true;
  if (kind === "files" && budget.files >= MAX_TEMPLATE_SOURCE_FILES) {
    budget.exhausted = true;
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source scan exceeds ${MAX_TEMPLATE_SOURCE_FILES} files`, path));
    return true;
  }
  if (kind === "directories" && budget.directories >= MAX_TEMPLATE_SOURCE_DIRECTORIES) {
    budget.exhausted = true;
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source scan exceeds ${MAX_TEMPLATE_SOURCE_DIRECTORIES} directories`, path));
    return true;
  }
  return false;
}

async function scanFolder(root: string, folder: string, budget: Budget, files: Set<string>, diagnostics: CensusDiagnostic[]): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyTemplateFolderPath>>;
  try {
    verified = await verifyTemplateFolderPath(root, normalizeTemplateFolderPath(folder));
  } catch (error: unknown) {
    pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_FOLDER_INVALID"), `Selected template folder cannot be verified: ${errorMessage(error)}`, folder));
    return;
  }
  if (verified.targetRealPath === null) {
    pushDiagnostic(diagnostics, diagnostic("TEMPLATE_FOLDER_INVALID", "Selected template folder is absent", folder));
    return;
  }
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (exhaust(budget, diagnostics, vaultRelative(root, directory), "directories")) return;
    budget.directories += 1;
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, vaultRelative(root, directory)));
      return;
    }
    if (directoryStat.isSymbolicLink()) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink directory is not a trusted template scope", vaultRelative(root, directory)));
      return;
    }
    if (!directoryStat.isDirectory()) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_FOLDER_INVALID", "Selected template folder is not a directory", vaultRelative(root, directory)));
      return;
    }
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_READ_FAILED", `Template directory cannot be read: ${errorMessage(error)}`, vaultRelative(root, directory)));
      return;
    }
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (budget.exhausted) return;
      const absolutePath = join(directory, child.name);
      const rawPath = vaultRelative(root, absolutePath);
      if (child.isSymbolicLink()) {
        pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Symlink template entry is skipped", rawPath));
        continue;
      }
      if (child.name.startsWith(".")) {
        if (child.isDirectory() || child.name.endsWith(".md")) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_UNSAFE", "Hidden template subtree or Markdown leaf is excluded from discovery", rawPath));
        }
        continue;
      }
      if (child.isDirectory()) {
        if (child.name.endsWith(".md")) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_SOURCE_INVALID", "Template directory leaf is not a markdown file", rawPath));
          continue;
        }
        if (depth >= MAX_TEMPLATE_SOURCE_DEPTH) {
          pushDiagnostic(diagnostics, diagnostic("TEMPLATE_PROPOSAL_OVERSIZE", `Template source depth exceeds the limit of ${MAX_TEMPLATE_SOURCE_DEPTH}`, rawPath));
          continue;
        }
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith(".md")) continue;
      let sourcePath: TemplateSourcePath;
      try {
        sourcePath = normalizeTemplateSourcePath(rawPath);
      } catch (error: unknown) {
        pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_INVALID"), `Template source is invalid: ${errorMessage(error)}`, rawPath));
        continue;
      }
      if (files.has(sourcePath) || exhaust(budget, diagnostics, sourcePath, "files")) continue;
      budget.files += 1;
      files.add(sourcePath);
    }
  };
  await visit(verified.absolutePath, 0);
}

/**
 * Lists raw candidates from explicit selections, configured file or folder
 * settings, and approved source refs. Invalid policy stays unverifiable.
 * Exact-byte identity pairing is the only automatic match.
 */
async function collectSources(
  root: string,
  requested: readonly TemplateCensusSelection[],
  initialPaths: readonly string[] = [],
): Promise<{ sources: ReadySource[]; blocked: Set<string>; missing: string[]; diagnostics: CensusDiagnostic[] }> {
  const diagnostics: CensusDiagnostic[] = [];
  const files = new Set<string>(initialPaths);
  const budget: Budget = { files: files.size, directories: 0, exhausted: false };
  for (const selection of requested) {
    if (selection.kind === "folder") {
      await scanFolder(root, selection.path, budget, files, diagnostics);
      continue;
    }
    try {
      const sourcePath = normalizeTemplateSourcePath(selection.path);
      if (!files.has(sourcePath) && !exhaust(budget, diagnostics, sourcePath, "files")) {
        budget.files += 1;
        files.add(sourcePath);
      }
    } catch (error: unknown) {
      pushDiagnostic(diagnostics, diagnostic(prefixedCode(error, "TEMPLATE_SOURCE_INVALID"), `Selected template file is invalid: ${errorMessage(error)}`, selection.path));
    }
  }
  const sources: ReadySource[] = [];
  const blocked = new Set<string>();
  const missing: string[] = [];
  for (const path of [...files].sort(compareText)) {
    const read = await readCandidate(root, path as TemplateSourcePath);
    if (read.state === "absent") {
      missing.push(path);
      continue;
    }
    if (read.state === "blocked") {
      blocked.add(path);
      pushDiagnostic(diagnostics, read.diagnostic);
      continue;
    }
    sources.push(read.source);
    for (const item of read.source.diagnostics) pushDiagnostic(diagnostics, item);
  }
  return { sources, blocked, missing, diagnostics };
}

export interface TemplateSourceInventory {
  readonly sources: readonly CensusSource[];
  readonly complete: boolean;
  readonly diagnostics: readonly CensusDiagnostic[];
}

/** Explicit raw discovery only: no policy, approval, configured hints or registration side effects. */
export async function scanTemplateSources(vault: string, selections: readonly TemplateCensusSelection[]): Promise<TemplateSourceInventory> {
  const root = await realpath(vault);
  const { sources, diagnostics, missing } = await collectSources(root, selections);
  for (const path of missing) diagnostics.push(diagnostic("TEMPLATE_SOURCE_MISSING", "Selected source is absent or disappeared during discovery", path));
  return { sources, complete: diagnostics.length === 0, diagnostics };
}
