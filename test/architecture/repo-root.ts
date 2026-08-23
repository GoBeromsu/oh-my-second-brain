import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gates live at a stable top-level path and must keep working when
 * production directories move underneath them.
 *
 * A depth-relative root (`path.resolve(dirname, "../..")`) silently breaks on
 * relocation: the root points somewhere that exists but holds no source, the
 * ENOENT-tolerant collector returns an empty list, and every gate reports green
 * while scanning nothing. Anchor on the repository's own `package.json` instead,
 * and pair it with the non-vacuity assertions below so an empty scan fails loud.
 */
const REPO_PACKAGE_NAME = "oh-my-second-brain";

function isRepoRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return parsed.name === REPO_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `could not locate repository root: no package.json named "${REPO_PACKAGE_NAME}" above ${startDir}`,
      );
    }
    current = parent;
  }
}

export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

export function absolute(relativePath: string): string {
  return path.join(REPO_ROOT, relativePath);
}

export async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await stat(absolute(relativePath));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(absolute(relativePath), "utf8")) as T;
}

/**
 * Recursively collect files under `relativeDir` matching `predicate`.
 *
 * Missing directories yield an empty list so a gate can scan a set of candidate
 * roots where some legitimately do not exist yet (mid-migration). That
 * tolerance is exactly why every caller must pair the result with
 * `assertNonVacuous` for the roots it believes are populated.
 */
export async function collectFiles(
  relativeDir: string,
  predicate: (relativePath: string) => boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(absolute(relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(relativePath, predicate)));
    } else if (entry.isFile() && predicate(relativePath)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

/**
 * Fail closed when a collector that is supposed to scan production files found
 * none. Without this, path drift turns every gate into a no-op that still
 * reports success.
 */
export function assertNonVacuous(files: readonly string[], what: string): void {
  if (files.length === 0) {
    throw new Error(
      `architecture gate scanned zero files for "${what}". ` +
        `This means the gate is inspecting nothing and would pass vacuously. ` +
        `Repository root resolved to ${REPO_ROOT}.`,
    );
  }
}

export function isProductionTs(relativePath: string): boolean {
  return relativePath.endsWith(".ts") && !relativePath.endsWith(".test.ts");
}

export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const match of source.matchAll(dynamicPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Resolve a relative import to a repo-relative, extension-stripped path.
 * Returns null for bare package specifiers.
 *
 * NodeNext requires a `.js` suffix on relative imports even though the source is
 * `.ts`, so the suffix is stripped before comparison.
 */
export function resolveImportSource(fromRelativeFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(REPO_ROOT, path.dirname(fromRelativeFile), specifier);
  return path
    .relative(REPO_ROOT, resolved)
    .replaceAll(path.sep, "/")
    .replace(/\.(?:js|ts|mjs|cjs)$/, "");
}

export interface ImportViolation {
  readonly file: string;
  readonly specifier: string;
  readonly resolved: string;
}

export async function findImports(
  files: readonly string[],
  matches: (resolved: string, fromFile: string) => boolean,
): Promise<ImportViolation[]> {
  const found: ImportViolation[] = [];
  for (const file of files) {
    const source = await readFile(absolute(file), "utf8");
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveImportSource(file, specifier);
      if (resolved === null) continue;
      if (matches(resolved, file)) found.push({ file, specifier, resolved });
    }
  }
  return found;
}

export function underAny(resolved: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
}
