import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessRuntimeAssetRoot } from "../../kernel/harness/surface-registry.js";
import { MissingBundledAssetRootError, resolveBundledAssetPaths } from "./assets.js";

/**
 * Package-root discovery from the calling module's URL.
 *
 * The point of these cases is that the resolver is not hardcoded to one nesting
 * depth, including its current assets-layer location.
 */
const PACKAGE_ROOT = path.join(path.sep, "tmp", "oms-package");

function moduleUrlAt(...segments: readonly string[]): string {
  return pathToFileURL(path.join(PACKAGE_ROOT, ...segments)).href;
}

const MODULE_POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["built assets runtime module", moduleUrlAt("dist", "assets", "runtime", "assets.js")],
  ["source assets runtime module", moduleUrlAt("src", "assets", "runtime", "assets.ts")],
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
