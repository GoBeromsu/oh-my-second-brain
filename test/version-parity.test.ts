import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { harnessSurfaceRegistry } from "../src/kernel/harness/surface-registry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(repoRoot, relativePath), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readVersion(relativePath: string): Promise<unknown> {
  return (await readJson(relativePath))["version"];
}

// The plugin entry is the second version carrier release-lib.mjs and the
// release workflow both guard, so it is read structurally rather than by a
// second `version` lookup.
async function marketplacePluginVersion(): Promise<unknown> {
  const plugins = (await readJson(marketplaceManifestPath))["plugins"];
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error("marketplace.json has no plugins[0] entry");
  }
  const first: unknown = plugins[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("marketplace.json plugins[0] is not an object");
  }
  return (first as Record<string, unknown>)["version"];
}

// A shared `undefined` on both sides would make a plain equality check pass on a
// manifest that lost its version field, so the expected value is pinned to a
// concrete semver string before any comparison.
async function packageVersion(): Promise<string> {
  const version = await readVersion("package.json");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`package.json version is not a semver string: ${JSON.stringify(version)}`);
  }
  return version;
}

// Adapter manifest paths are derived from the registry so a new host or a moved
// manifest is covered without editing this test.
const adapterManifestPaths = harnessSurfaceRegistry.hosts.flatMap((host) =>
  host.manifestFiles.map((manifestFile) => path.posix.join(host.adapterDir, manifestFile)),
);

// The root marketplace manifest is not a harness host surface, so the registry
// does not expose it; it is listed here explicitly. It is committed, so a
// missing file must fail this suite rather than silently skip it.
const marketplaceManifestPath = ".claude-plugin/marketplace.json";

describe("on-disk manifest version parity", () => {
  it.each(adapterManifestPaths)("%s version equals package.json version", async (manifestPath) => {
    // Given: the released package version on disk
    const expected = await packageVersion();
    // When: the adapter manifest shipped alongside it is read
    const manifestVersion = await readVersion(manifestPath);
    // Then: the two versions are identical
    expect(manifestVersion).toBe(expected);
  });

  it(`${marketplaceManifestPath} version equals package.json version`, async () => {
    // Given: the released package version on disk
    const expected = await packageVersion();
    // When: the marketplace manifest's top-level carrier is read
    const manifestVersion = await readVersion(marketplaceManifestPath);
    // Then: the two versions are identical
    expect(manifestVersion).toBe(expected);
  });

  it(`${marketplaceManifestPath} plugins[0].version equals package.json version`, async () => {
    // Given: the released package version on disk
    const expected = await packageVersion();
    // When: the marketplace manifest's plugin-entry carrier is read
    const pluginVersion = await marketplacePluginVersion();
    // Then: the second carrier the release guards check is in lockstep too
    expect(pluginVersion).toBe(expected);
  });
});
