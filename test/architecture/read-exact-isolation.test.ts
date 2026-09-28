import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, importSpecifiers, pathExists, resolveImportSource, underAny } from "./repo-root.js";

/**
 * Engine-free read gate.
 *
 * `readExact` backs `oms search --path` and the MCP `search` `path` parameter. Its
 * whole point is that a single-note read pays for process startup and one file read,
 * not for opening the engine store, loading SQLite, or loading a model. That holds
 * only while nothing it imports, directly or transitively, reaches the engine or a
 * native backend, so the static import graph is walked here and must stay clean.
 */

const ENTRY = "src/kernel/search/read-exact";
const FORBIDDEN_LOCAL = ["src/kernel/engine"] as const;
const FORBIDDEN_PACKAGES = ["better-sqlite3", "node-llama-cpp", "sqlite-vec"] as const;

function isForbiddenPackage(specifier: string): boolean {
  return FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

interface ImportGraph {
  readonly files: string[];
  readonly violations: string[];
}

/** Walks every static and literal dynamic import reachable from `entry` (extensionless, repo-relative). */
async function walk(entry: string): Promise<ImportGraph> {
  const seen = new Set<string>();
  const violations: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const module = queue.shift()!;
    if (seen.has(module)) continue;
    const file = `${module}.ts`;
    if (!(await pathExists(file))) throw new Error(`import graph reached ${module}, which has no ${file}`);
    seen.add(module);
    for (const specifier of importSpecifiers(await readFile(absolute(file), "utf8"))) {
      const resolved = resolveImportSource(file, specifier);
      if (resolved === null) {
        if (isForbiddenPackage(specifier)) violations.push(`${file} imports ${specifier}`);
        continue;
      }
      if (underAny(resolved, FORBIDDEN_LOCAL)) violations.push(`${file} imports ${specifier} (${resolved})`);
      else queue.push(resolved);
    }
  }
  return { files: [...seen].sort(), violations };
}

describe("readExact stays engine-free", () => {
  it("reaches no engine module or native backend through its import graph", async () => {
    const graph = await walk(ENTRY);
    assertNonVacuous(graph.files, "readExact transitive import graph");
    expect(graph.files).toContain(ENTRY);
    expect(graph.files).toContain("src/kernel/text/nfc");
    expect(graph.violations).toEqual([]);
  });

  it("would catch an engine import, so the walk is not vacuous", async () => {
    const graph = await walk("src/kernel/engine/assemble");
    expect(graph.violations.length).toBeGreaterThan(0);
    expect(FORBIDDEN_PACKAGES.every(isForbiddenPackage)).toBe(true);
    expect(isForbiddenPackage("sqlite-vec/sub")).toBe(true);
    expect(isForbiddenPackage("node:fs")).toBe(false);
  });
});
