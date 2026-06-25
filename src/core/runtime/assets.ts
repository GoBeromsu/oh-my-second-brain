import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessSurfaceRegistry, type HarnessRuntimeAssetRoot } from "../../harness/surface-registry.js";

export interface BundledAssetPaths {
  readonly packageRoot: string;
  readonly ontologyDir: string;
  readonly adapterRoot: string;
  readonly claudeAdapterDir: string;
}

type BundledAssetRootId = "ontology" | "adapters" | "claude-adapter";

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

export function resolveBundledAssetPaths(
  moduleUrl: string = import.meta.url,
  runtimeAssetRoots: readonly HarnessRuntimeAssetRoot[] = harnessSurfaceRegistry.packageAssets.runtimeAssetRoots,
): BundledAssetPaths {
  const modulePath = fileURLToPath(moduleUrl);
  const packageRoot = packageRootFromModulePath(modulePath);

  return {
    packageRoot,
    ontologyDir: path.join(packageRoot, requiredRuntimeAssetPath(runtimeAssetRoots, "ontology")),
    adapterRoot: path.join(packageRoot, requiredRuntimeAssetPath(runtimeAssetRoots, "adapters")),
    claudeAdapterDir: path.join(packageRoot, requiredRuntimeAssetPath(runtimeAssetRoots, "claude-adapter")),
  };
}
