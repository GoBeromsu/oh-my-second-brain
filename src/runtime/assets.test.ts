import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessRuntimeAssetRoot } from "../harness/surface-registry.js";
import { MissingBundledAssetRootError, resolveBundledAssetPaths } from "../core/runtime/assets.js";

/**
 * Package-root discovery from the calling module's URL.
 *
 * The point of these cases is that the resolver is not hardcoded to one nesting
 * depth. The module has already moved once (to `core/runtime/`) and moves again
 * into `kernel/` during the layer migration, so every position below - past,
 * present and planned - must resolve to the same package root.
 */
const PACKAGE_ROOT = path.join(path.sep, "tmp", "oms-package");

function moduleUrlAt(...segments: readonly string[]): string {
  return pathToFileURL(path.join(PACKAGE_ROOT, ...segments)).href;
}

const MODULE_POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["built runtime module", moduleUrlAt("dist", "runtime", "assets.js")],
  ["source runtime module", moduleUrlAt("src", "runtime", "assets.ts")],
  ["built core runtime module", moduleUrlAt("dist", "core", "runtime", "assets.js")],
  ["source core runtime module", moduleUrlAt("src", "core", "runtime", "assets.ts")],
  ["built kernel runtime module", moduleUrlAt("dist", "kernel", "runtime", "assets.js")],
  ["source kernel runtime module", moduleUrlAt("src", "kernel", "runtime", "assets.ts")],
];

describe("resolveBundledAssetPaths", () => {
  it.each(MODULE_POSITIONS)("resolves the same package assets from the %s", (_label, moduleUrl) => {
    expect(resolveBundledAssetPaths(moduleUrl)).toEqual({
      packageRoot: PACKAGE_ROOT,
      ontologyDir: path.join(PACKAGE_ROOT, "core", "ontology"),
    });
  });

  it("resolves package assets from registry runtime asset roots", () => {
    // Given a registry that relocates the ontology root
    const runtimeAssetRoots = [
      { id: "ontology", path: "custom/ontology", owner: "core" },
    ] satisfies readonly HarnessRuntimeAssetRoot[];

    // When
    const paths = resolveBundledAssetPaths(moduleUrlAt("dist", "runtime", "assets.js"), runtimeAssetRoots);

    // Then
    expect(paths).toEqual({
      packageRoot: PACKAGE_ROOT,
      ontologyDir: path.join(PACKAGE_ROOT, "custom", "ontology"),
    });
  });

  it("throws a typed error when the registry omits a required runtime asset root", () => {
    // Given a registry with no ontology root at all. `ontology` is the only
    // required root since the adapter roots were retired with the vendor
    // topology move, so an empty list is the omission case.
    const runtimeAssetRoots = [] satisfies readonly HarnessRuntimeAssetRoot[];
    const moduleUrl = moduleUrlAt("dist", "runtime", "assets.js");

    // When / Then
    expect(() => resolveBundledAssetPaths(moduleUrl, runtimeAssetRoots)).toThrow(
      MissingBundledAssetRootError,
    );

    try {
      resolveBundledAssetPaths(moduleUrl, runtimeAssetRoots);
      expect.unreachable("resolveBundledAssetPaths should have thrown");
    } catch (error) {
      if (!(error instanceof MissingBundledAssetRootError)) throw error;
      expect(error.assetRootId).toBe("ontology");
    }
  });

  it("rejects a registry entry whose id is not a known asset root", () => {
    const runtimeAssetRoots = [
      { id: "adapters", path: "adapters", owner: "runtime" },
    ] as unknown as readonly HarnessRuntimeAssetRoot[];

    expect(() =>
      resolveBundledAssetPaths(moduleUrlAt("dist", "runtime", "assets.js"), runtimeAssetRoots),
    ).toThrow(MissingBundledAssetRootError);
  });
});
