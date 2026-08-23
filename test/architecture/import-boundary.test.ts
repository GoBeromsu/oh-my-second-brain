import { describe, expect, it } from "vitest";
import {
  assertNonVacuous,
  collectFiles,
  findImports,
  importSpecifiers,
  isProductionTs,
  pathExists,
  readJson,
  underAny,
} from "./repo-root.js";

/**
 * Import-direction gate for the five-layer target.
 *
 * Rules (spec Acceptance Criterion 8):
 *   1. cli/  may import kernel/ (and kernel-transitional/ while it exists)
 *   2. mcp/  may import kernel/ (and kernel-transitional/ while it exists)
 *   3. kernel/ may NOT import cli/, mcp/, or vendors/
 *   4. vendors/<a>/ may NOT import vendors/<b>/
 *
 * The layers do not all exist yet: this gate lands before any file moves, so
 * every rule tolerates a missing directory but the *populated* roots are
 * asserted non-vacuous. Legacy pre-migration boundaries are kept alongside so
 * the gate has real teeth from day one rather than only after PR 7c.
 */

const KERNEL = "src/kernel";
const KERNEL_TRANSITIONAL = "src/kernel-transitional";
const CLI = "src/cli";
const MCP = "src/mcp";
const VENDORS = "src/vendors";

/** Legacy roots that behave as domain/kernel code until the migration moves them. */
const LEGACY_DOMAIN_DIRS = [
  "src/core",
  "src/ontology",
  "src/conventions",
  "src/capture",
  "src/graph",
  "src/retrieve",
  "src/engine",
  "src/setup",
] as const;

/** Legacy roots that behave as control-plane/host surfaces. */
const LEGACY_CONTROL_DIRS = ["src/cli", "src/install", "src/hook"] as const;

const HARNESS_FORBIDDEN_DIRS = ["src/cli", "src/install", "src/hook", "src/mcp", "src/runtime"] as const;

interface FacadeInventory {
  readonly facade: string;
  readonly outwardImports: readonly string[];
}

async function vendorDirs(): Promise<string[]> {
  const files = await collectFiles(VENDORS, isProductionTs);
  const dirs = new Set<string>();
  for (const file of files) {
    const rest = file.slice(`${VENDORS}/`.length);
    const first = rest.split("/")[0];
    if (first !== undefined) dirs.add(`${VENDORS}/${first}`);
  }
  return [...dirs].sort();
}

describe("import-direction gate", () => {
  it("extracts static and dynamic relative import specifiers", () => {
    const source = [
      'import type { Thing } from "./thing.js";',
      'const mod = await import("../kernel/x.js");',
      'export { y } from "./y.js";',
    ].join("\n");

    // Static specifiers are collected first, then dynamic ones - not source order.
    expect(importSpecifiers(source)).toEqual(["./thing.js", "./y.js", "../kernel/x.js"]);
  });

  it("classifies a kernel import of a surface layer as forbidden", () => {
    const forbiddenFromKernel = [CLI, MCP, VENDORS];
    expect(underAny("src/cli/oms", forbiddenFromKernel)).toBe(true);
    expect(underAny("src/mcp/server", forbiddenFromKernel)).toBe(true);
    expect(underAny("src/vendors/codex/install", forbiddenFromKernel)).toBe(true);
    expect(underAny("src/kernel/engine/search", forbiddenFromKernel)).toBe(false);
    // Prefix matching must not treat a sibling with a shared prefix as a match.
    expect(underAny("src/climate/x", forbiddenFromKernel)).toBe(false);
  });

  it("rejects a cross-vendor import while allowing same-vendor imports", () => {
    const isCrossVendor = (resolved: string, fromFile: string): boolean => {
      if (!underAny(resolved, [VENDORS])) return false;
      const own = fromFile.slice(`${VENDORS}/`.length).split("/")[0];
      const target = resolved.slice(`${VENDORS}/`.length).split("/")[0];
      return own !== undefined && target !== undefined && own !== target;
    };

    expect(isCrossVendor("src/vendors/codex/x", "src/vendors/claude-code/y.ts")).toBe(true);
    expect(isCrossVendor("src/vendors/codex/x", "src/vendors/codex/y.ts")).toBe(false);
    expect(isCrossVendor("src/kernel/x", "src/vendors/codex/y.ts")).toBe(false);
  });

  it("keeps kernel free of cli, mcp, and vendors imports", async () => {
    const files = await collectFiles(KERNEL, isProductionTs);
    if (files.length === 0) return; // kernel/ does not exist until PR 7a
    assertNonVacuous(files, KERNEL);
    expect(await findImports(files, (resolved) => underAny(resolved, [CLI, MCP, VENDORS]))).toEqual([]);
  });

  it("keeps vendor modules from importing each other", async () => {
    const dirs = await vendorDirs();
    if (dirs.length === 0) return; // vendors/ does not exist until PR 5a
    for (const dir of dirs) {
      const files = await collectFiles(dir, isProductionTs);
      assertNonVacuous(files, dir);
      const others = dirs.filter((other) => other !== dir);
      expect(await findImports(files, (resolved) => underAny(resolved, others)), dir).toEqual([]);
    }
  });

  it("bounds the transitional facade's outward imports to the declared inventory", async () => {
    if (!(await pathExists(KERNEL_TRANSITIONAL))) return; // not created until PR 2 lands its facade

    const inventory = await readJson<FacadeInventory>("test/architecture/facade-outward-imports.json");
    const files = await collectFiles(KERNEL_TRANSITIONAL, isProductionTs);
    assertNonVacuous(files, KERNEL_TRANSITIONAL);

    const declared = new Set(inventory.outwardImports);
    const actual = await findImports(files, (resolved) => !underAny(resolved, [KERNEL, KERNEL_TRANSITIONAL]));
    const undeclared = actual.filter((violation) => !declared.has(violation.resolved));

    expect(undeclared, "facade imports a legacy module not present in facade-outward-imports.json").toEqual([]);
  });

  it("keeps package-root core as convention assets, not runtime source", async () => {
    const runtimeFiles = await collectFiles("core", (relativePath) =>
      /\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath),
    );
    expect(runtimeFiles).toEqual([]);
  });

  it("keeps production harness declarations free of host/runtime side-effect imports", async () => {
    const files = await collectFiles("src/harness", isProductionTs);
    if (files.length === 0) return; // harness/ moves into kernel/ in PR 7a
    assertNonVacuous(files, "src/harness");
    expect(await findImports(files, (resolved) => underAny(resolved, HARNESS_FORBIDDEN_DIRS))).toEqual([]);
  });

  it("keeps legacy core-domain modules from importing control-plane host surfaces", async () => {
    const files = (
      await Promise.all(LEGACY_DOMAIN_DIRS.map((dir) => collectFiles(dir, isProductionTs)))
    ).flat();
    if (files.length === 0) return; // all legacy domain dirs migrated
    assertNonVacuous(files, "legacy core-domain dirs");
    expect(await findImports(files, (resolved) => underAny(resolved, LEGACY_CONTROL_DIRS))).toEqual([]);
  });
});
