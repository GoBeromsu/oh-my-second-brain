import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORE_DOMAIN_DIRS = [
  "src/core",
  "src/ontology",
  "src/conventions",
  "src/capture",
  "src/graph",
  "src/retrieve",
  "src/engine",
  "src/setup",
] as const;
const CONTROL_SURFACE_DIRS = ["src/cli", "src/install", "src/hook", "src/adapt"] as const;
const HARNESS_FORBIDDEN_DIRS = [
  "src/cli",
  "src/install",
  "src/hook",
  "src/adapt",
  "src/mcp",
  "src/runtime",
] as const;

async function collectFiles(relativeDir: string, predicate: (relativePath: string) => boolean): Promise<string[]> {
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(relativePath, predicate));
    } else if (entry.isFile() && predicate(relativePath)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function tsProductionFile(relativePath: string): boolean {
  return relativePath.endsWith(".ts") && !relativePath.endsWith(".test.ts");
}

function runtimeSourceFile(relativePath: string): boolean {
  return /\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath);
}

function importSpecifiers(source: string): string[] {
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

function resolveImportSource(fromRelativeFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const absolute = path.resolve(REPO_ROOT, path.dirname(fromRelativeFile), specifier);
  return path.relative(REPO_ROOT, absolute).replaceAll(path.sep, "/").replace(/\.(?:js|ts|mjs|cjs)$/, "");
}

async function illegalImports(
  files: readonly string[],
  forbiddenPrefixes: readonly string[],
): Promise<Array<{ readonly file: string; readonly specifier: string; readonly resolved: string }>> {
  const violations: Array<{ readonly file: string; readonly specifier: string; readonly resolved: string }> = [];
  for (const file of files) {
    const source = await readFile(path.join(REPO_ROOT, file), "utf8");
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveImportSource(file, specifier);
      if (resolved === null) continue;
      if (forbiddenPrefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`))) {
        violations.push({ file, specifier, resolved });
      }
    }
  }
  return violations;
}

describe("harness import boundaries", () => {
  it("collects static and dynamic relative import specifiers", () => {
    const source = [
      'import type { HarnessSurfaceRegistry } from "./surface-registry.js";',
      'const server = await import("../mcp/server.js");',
    ].join("\n");

    expect(importSpecifiers(source)).toEqual(["./surface-registry.js", "../mcp/server.js"]);
  });

  it("keeps package-root core as convention assets, not runtime source", async () => {
    const runtimeFiles = await collectFiles("core", runtimeSourceFile);
    expect(runtimeFiles).toEqual([]);
  });

  it("keeps production harness declarations free of host/runtime side-effect imports", async () => {
    const harnessFiles = await collectFiles("src/harness", tsProductionFile);
    expect(await illegalImports(harnessFiles, HARNESS_FORBIDDEN_DIRS)).toEqual([]);
  });

  it("keeps current core-domain modules from importing control-plane host surfaces", async () => {
    const coreDomainFiles = (
      await Promise.all(CORE_DOMAIN_DIRS.map((dir) => collectFiles(dir, tsProductionFile)))
    ).flat();
    expect(await illegalImports(coreDomainFiles, CONTROL_SURFACE_DIRS)).toEqual([]);
  });
});
