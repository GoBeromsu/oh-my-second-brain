import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SOURCE_EXTENSIONS } from "../../scripts/check-module-size.mjs";

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
  return SOURCE_EXTENSIONS.some(
    (extension) => relativePath.endsWith(extension) && !relativePath.endsWith(`.test${extension}`),
  );
}

interface ImportAnalysis {
  readonly specifiers: string[];
  readonly unanalysableImports: string[];
  readonly nonLiteralDynamicImports: string[];
}

function isStaticSpecifier(node: ts.Expression): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function importTypeSpecifier(node: ts.ImportTypeNode): ts.StringLiteralLike | undefined {
  if (!ts.isLiteralTypeNode(node.argument) || !isStaticSpecifier(node.argument.literal)) return undefined;
  return node.argument.literal;
}

function analyzeImports(source: string): ImportAnalysis {
  const sourceFile = ts.createSourceFile("boundary-check.ts", source, ts.ScriptTarget.Latest, false);
  const staticSpecifiers: string[] = [];
  const dynamicSpecifiers: string[] = [];
  const unanalysableImports: string[] = [];
  const nonLiteralDynamicImports: string[] = [];

  const recordStaticSpecifier = (specifier: ts.Expression, node: ts.Node): void => {
    if (isStaticSpecifier(specifier)) {
      staticSpecifiers.push(specifier.text);
    } else {
      unanalysableImports.push(node.getText(sourceFile));
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) recordStaticSpecifier(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression === undefined) {
        unanalysableImports.push(node.getText(sourceFile));
      } else {
        recordStaticSpecifier(expression, node);
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);
      if (specifier === undefined) {
        unanalysableImports.push(node.getText(sourceFile));
      } else {
        staticSpecifiers.push(specifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier !== undefined && isStaticSpecifier(specifier)) {
        dynamicSpecifiers.push(specifier.text);
      } else {
        const importExpression = node.getText(sourceFile);
        unanalysableImports.push(importExpression);
        nonLiteralDynamicImports.push(importExpression);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return {
    specifiers: [...staticSpecifiers, ...dynamicSpecifiers],
    unanalysableImports,
    nonLiteralDynamicImports,
  };
}

export function importSpecifiers(source: string): string[] {
  return analyzeImports(source).specifiers;
}

/**
 * Dynamic imports must have a string-literal specifier so boundary checks can
 * resolve them. Computed imports are deliberately rejected rather than skipped:
 * an import boundary that cannot inspect an edge is not a boundary.
 */
export function nonLiteralDynamicImports(source: string): string[] {
  return analyzeImports(source).nonLiteralDynamicImports;
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
    const imports = analyzeImports(source);
    if (imports.unanalysableImports.length > 0) {
      throw new Error(
        `${file} contains import(s) with non-literal specifier(s): ${imports.unanalysableImports.join(", ")}`,
      );
    }
    for (const specifier of imports.specifiers) {
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
