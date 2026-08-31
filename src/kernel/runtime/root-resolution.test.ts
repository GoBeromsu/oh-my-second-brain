import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBundledAssetPaths } from "./assets.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleUrlAt = (...parts: string[]): string => pathToFileURL(path.join(packageRoot, ...parts)).href;

describe("resolveBundledAssetPaths", () => {
  it("given a built runtime module, when resolving, then the npm package root is returned", () => {
    expect(resolveBundledAssetPaths(moduleUrlAt("dist", "kernel", "runtime", "assets.js"))).toEqual({ packageRoot });
  });

  it("given a source runtime module, when resolving, then the same package root is returned", () => {
    expect(resolveBundledAssetPaths(moduleUrlAt("src", "kernel", "runtime", "assets.ts"))).toEqual({ packageRoot });
  });

});
