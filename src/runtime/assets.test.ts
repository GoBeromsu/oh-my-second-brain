import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessRuntimeAssetRoot } from "../harness/surface-registry.js";
import {
  MissingBundledAssetRootError,
  resolveBundledAssetPaths,
} from "../core/runtime/assets.js";

describe("resolveBundledAssetPaths", () => {
  it("resolves package assets when called from the built runtime module", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "runtime", "assets.js"),
    ).href;

    // When
    const paths = resolveBundledAssetPaths(moduleUrl);

    // Then
    expect(paths).toEqual({
      packageRoot,
      ontologyDir: path.join(packageRoot, "core", "ontology"),
      adapterRoot: path.join(packageRoot, "adapters"),
      claudeAdapterDir: path.join(packageRoot, "adapters", "claude-code"),
    });
  });

  it("resolves the same package assets when called from the source runtime module", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "src", "runtime", "assets.ts"),
    ).href;

    // When
    const paths = resolveBundledAssetPaths(moduleUrl);

    // Then
    expect(paths).toEqual({
      packageRoot,
      ontologyDir: path.join(packageRoot, "core", "ontology"),
      adapterRoot: path.join(packageRoot, "adapters"),
      claudeAdapterDir: path.join(packageRoot, "adapters", "claude-code"),
    });
  });

  it("resolves package assets when called from the built core runtime module", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "core", "runtime", "assets.js"),
    ).href;

    // When
    const paths = resolveBundledAssetPaths(moduleUrl);

    // Then
    expect(paths).toEqual({
      packageRoot,
      ontologyDir: path.join(packageRoot, "core", "ontology"),
      adapterRoot: path.join(packageRoot, "adapters"),
      claudeAdapterDir: path.join(packageRoot, "adapters", "claude-code"),
    });
  });

  it("resolves package assets when called from the source core runtime module", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "src", "core", "runtime", "assets.ts"),
    ).href;

    // When
    const paths = resolveBundledAssetPaths(moduleUrl);

    // Then
    expect(paths).toEqual({
      packageRoot,
      ontologyDir: path.join(packageRoot, "core", "ontology"),
      adapterRoot: path.join(packageRoot, "adapters"),
      claudeAdapterDir: path.join(packageRoot, "adapters", "claude-code"),
    });
  });

  it("resolves package assets from registry runtime asset roots", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "runtime", "assets.js"),
    ).href;
    const runtimeAssetRoots = [
      { id: "ontology", path: "custom/ontology", owner: "core" },
      { id: "adapters", path: "custom/adapters", owner: "runtime" },
      { id: "claude-adapter", path: "custom/adapters/claude", owner: "runtime" },
    ] satisfies readonly HarnessRuntimeAssetRoot[];

    // When
    const paths = resolveBundledAssetPaths(moduleUrl, runtimeAssetRoots);

    // Then
    expect(paths).toEqual({
      packageRoot,
      ontologyDir: path.join(packageRoot, "custom", "ontology"),
      adapterRoot: path.join(packageRoot, "custom", "adapters"),
      claudeAdapterDir: path.join(packageRoot, "custom", "adapters", "claude"),
    });
  });

  it("throws a typed error when the registry omits a required runtime asset root", () => {
    // Given
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "runtime", "assets.js"),
    ).href;
    const runtimeAssetRoots = [
      { id: "ontology", path: "core/ontology", owner: "core" },
      { id: "adapters", path: "adapters", owner: "runtime" },
    ] satisfies readonly HarnessRuntimeAssetRoot[];

    // When / Then
    expect(() => resolveBundledAssetPaths(moduleUrl, runtimeAssetRoots)).toThrow(MissingBundledAssetRootError);
    try {
      resolveBundledAssetPaths(moduleUrl, runtimeAssetRoots);
    } catch (error) {
      if (!(error instanceof MissingBundledAssetRootError)) throw error;
      expect(error.assetRootId).toBe("claude-adapter");
    }
  });
});
