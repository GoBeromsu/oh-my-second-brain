import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBundledPackageVersion, resolveBundledAssetPaths } from "./assets.js";

describe("bundled package metadata", () => {
  it("given the runtime module, when assets resolve, then only the package root is returned", () => {
    expect(Object.keys(resolveBundledAssetPaths())).toEqual(["packageRoot"]);
  });

  it("given a valid manifest, when its version is read, then the declared version is returned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-package-version-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
      expect(readBundledPackageVersion(root)).toBe("9.8.7");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("given a missing or malformed manifest, when its version is read, then server boot degrades safely", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-package-version-"));
    try {
      expect(readBundledPackageVersion(root)).toBe("0.0.0");
      await writeFile(path.join(root, "package.json"), "not-json");
      expect(readBundledPackageVersion(root)).toBe("0.0.0");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
