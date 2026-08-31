import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledAssetPaths {
  readonly packageRoot: string;
}

function packageRootFromModulePath(modulePath: string): string {
  const segments = modulePath.split(path.sep);
  const sourceRootIndex = Math.max(segments.lastIndexOf("dist"), segments.lastIndexOf("src"));
  if (sourceRootIndex > 0) {
    const root = segments.slice(0, sourceRootIndex);
    if (root.length === 1 && root[0] === "") return path.sep;
    return root.join(path.sep);
  }
  return path.resolve(path.dirname(modulePath), "../..");
}

const UNKNOWN_PACKAGE_VERSION = "0.0.0";

/** Read the package version without making server construction depend on a valid manifest. */
export function readBundledPackageVersion(packageRoot: string = resolveBundledAssetPaths().packageRoot): string {
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")); }
  catch (error) {
    if (error instanceof Error) return UNKNOWN_PACKAGE_VERSION;
    throw error;
  }
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest
    ? (manifest as { readonly version: unknown }).version
    : undefined;
  return typeof version === "string" ? version : UNKNOWN_PACKAGE_VERSION;
}

/** Resolve the npm package root from either the source or built module URL. */
export function resolveBundledAssetPaths(moduleUrl: string = import.meta.url): BundledAssetPaths {
  return { packageRoot: packageRootFromModulePath(fileURLToPath(moduleUrl)) };
}
