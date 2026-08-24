import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readBundledPackageVersion, resolveBundledAssetPaths } from "./assets.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

async function manifestVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8"));
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? (manifest as { version: unknown }).version
      : undefined;
  expect(typeof version).toBe("string");
  return String(version);
}

describe("readBundledPackageVersion", () => {
  it("resolves only the ontology runtime asset root", () => {
    const assets = resolveBundledAssetPaths();

    expect(Object.keys(assets).sort()).toEqual(["ontologyDir", "packageRoot"]);
    expect(assets.ontologyDir).toBe(path.join(assets.packageRoot, "core", "ontology"));
  });

  it("reports the version declared by the bundled package.json", async () => {
    // Given: the package root resolved from this module's own location
    const { packageRoot } = resolveBundledAssetPaths();
    const expected = await manifestVersion();

    // When: the bundled manifest version is read
    const version = readBundledPackageVersion(packageRoot);

    // Then: it matches package.json, and is NOT the placeholder fallback
    expect(version).toBe(expected);
    expect(version).not.toBe("0.0.0");
  });

  it("falls back to 0.0.0 without throwing when the manifest is unreadable", async () => {
    // Given: a package root that holds no package.json at all
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "oms-assets-nomanifest-"));

    try {
      // When: the manifest version is read from that root
      // Then: the fallback is returned instead of an exception
      expect(() => readBundledPackageVersion(emptyRoot)).not.toThrow();
      expect(readBundledPackageVersion(emptyRoot)).toBe("0.0.0");
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("falls back to 0.0.0 when the manifest declares no string version", async () => {
    // Given: a package root whose package.json carries no usable version field
    const brokenRoot = await mkdtemp(path.join(tmpdir(), "oms-assets-badmanifest-"));
    await writeFile(path.join(brokenRoot, "package.json"), JSON.stringify({ version: 42 }), "utf-8");

    try {
      // When: the manifest version is read
      // Then: the non-string version is rejected in favor of the fallback
      expect(readBundledPackageVersion(brokenRoot)).toBe("0.0.0");
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });
});
