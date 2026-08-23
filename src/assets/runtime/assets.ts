import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessSurfaceRegistry, type HarnessRuntimeAssetRoot } from "../../kernel/harness/surface-registry.js";

export interface BundledAssetPaths {
  readonly packageRoot: string;
  readonly ontologyDir: string;
}

type BundledAssetRootId = "ontology";

export class MissingBundledAssetRootError extends Error {
  constructor(readonly assetRootId: BundledAssetRootId) {
    super(`Harness registry is missing runtime asset root: ${assetRootId}`);
    this.name = "MissingBundledAssetRootError";
  }
}

function requiredRuntimeAssetPath(
  runtimeAssetRoots: readonly HarnessRuntimeAssetRoot[],
  id: BundledAssetRootId,
): string {
  const assetRoot = runtimeAssetRoots.find((candidate) => candidate.id === id);
  if (assetRoot === undefined) throw new MissingBundledAssetRootError(id);
  return assetRoot.path;
}

function packageRootFromModulePath(modulePath: string): string {
  const modulePathSegments = modulePath.split(path.sep);
  const sourceRootIndex = Math.max(
    modulePathSegments.lastIndexOf("dist"),
    modulePathSegments.lastIndexOf("src"),
  );

  if (sourceRootIndex > 0) {
    const rootSegments = modulePathSegments.slice(0, sourceRootIndex);
    if (rootSegments.length === 1 && rootSegments[0] === "") return path.sep;
    return rootSegments.join(path.sep);
  }

  return path.resolve(path.dirname(modulePath), "../..");
}

/**
 * Version reported when the bundled manifest cannot be read or declares no
 * string `version`. Callers embed this in server handshakes at construction
 * time, so a missing/corrupt manifest must degrade rather than abort boot.
 */
const UNKNOWN_PACKAGE_VERSION = "0.0.0";

/**
 * Reads `version` from the bundled package.json. Synchronous by contract: the
 * MCP server info is built during (sync) server construction, and this reads a
 * single small file that ships inside the package.
 */
export function readBundledPackageVersion(
  packageRoot: string = resolveBundledAssetPaths().packageRoot,
): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
  } catch (error) {
    if (error instanceof Error) return UNKNOWN_PACKAGE_VERSION;
    throw error;
  }

  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? (manifest as { version: unknown }).version
      : undefined;
  return typeof version === "string" ? version : UNKNOWN_PACKAGE_VERSION;
}

export function resolveBundledAssetPaths(
  moduleUrl: string = import.meta.url,
  runtimeAssetRoots: readonly HarnessRuntimeAssetRoot[] = harnessSurfaceRegistry.packageAssets.runtimeAssetRoots,
): BundledAssetPaths {
  const modulePath = fileURLToPath(moduleUrl);
  const packageRoot = packageRootFromModulePath(modulePath);

  return {
    packageRoot,
    ontologyDir: path.join(packageRoot, requiredRuntimeAssetPath(runtimeAssetRoots, "ontology")),
  };
}
