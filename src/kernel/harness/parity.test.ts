import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { omsMcpTools } from "../../mcp/server.js";
import { resolveBundledAssetPaths } from "../runtime/assets.js";
import { SHARED_SKILLS_SOURCE } from "../../assets/shared-skills.js";
import { harnessSurfaceRegistry } from "./surface-registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relativePath), "utf8")) as T;
}

async function skillDirs(relativeRoot: string): Promise<string[]> {
  const entries = await readdir(path.join(REPO_ROOT, relativeRoot), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(REPO_ROOT, relativePath));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("harness registry parity", () => {
  it("declares exactly the final semantic-engine command families", () => {
    const commands = harnessSurfaceRegistry.cliCommands
      .filter((command) => command.owner === "semantic-engine")
      .map((command) => command.name);

    expect(commands).toEqual(["search", "index", "graph", "model", "serve"]);
    expect(commands).not.toEqual(expect.arrayContaining(["doc", "embed", "semantic"]));
    expect(harnessSurfaceRegistry.cliCommands.map((command) => command.name)).toContain("status");
  });

  it("declares the live MCP tool names in order", () => {
    expect(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name)).toEqual(
      omsMcpTools.map((tool) => tool.name),
    );
  });

  it("matches MCP posture metadata to live tool annotations", () => {
    for (const registryTool of harnessSurfaceRegistry.mcpTools) {
      const liveTool = omsMcpTools.find((tool) => tool.name === registryTool.name);
      expect(liveTool, registryTool.name).toBeDefined();
      expect(liveTool?.annotations?.readOnlyHint).toBe(registryTool.posture === "read");
      expect(liveTool?.annotations?.destructiveHint).toBe(registryTool.destructive);
      expect(liveTool?.annotations?.idempotentHint).toBe(registryTool.idempotent);
      expect(liveTool?.annotations?.openWorldHint).toBe(registryTool.openWorld);
    }
  });

  it("resolves every host's declared skills to the one shared source", async () => {
    // Zero copies is the point: no host has its own skills directory any more,
    // so every host's declaration must match the single authored tree. A
    // per-host directory reappearing here means a copy came back.
    const shared = await skillDirs(SHARED_SKILLS_SOURCE);
    expect(shared).not.toHaveLength(0);

    for (const host of harnessSurfaceRegistry.hosts) {
      expect([...host.skillDirs].sort(), host.runtime).toEqual(shared);
    }

    // Every host resolves to the identical set, which is what makes the copies
    // removable. Their absence on disk is asserted by the vendor-discovery gate
    // once the deletion lands.
    const declared = new Set(harnessSurfaceRegistry.hosts.map((host) => [...host.skillDirs].sort().join(",")));
    expect(declared.size, "hosts declare divergent skill sets").toBe(1);
  });


  it("declares host manifest, guidance, hook, rule, and MCP config files that exist", async () => {
    for (const host of harnessSurfaceRegistry.hosts) {
      const files = [
        ...host.manifestFiles,
        ...host.guidanceFiles,
        ...host.hookFiles,
        ...host.ruleFiles,
        ...host.mcpConfigFiles,
      ];
      for (const file of files) {
        await expect(fileExists(path.join(host.adapterDir, file)), `${host.runtime}:${file}`).resolves.toBe(true);
      }
    }
  });

  it("matches package files and hook bins", async () => {
    const packageJson = await readJson<{
      files: string[];
      bin: Record<string, string>;
    }>("package.json");

    expect(packageJson.files).toEqual(harnessSurfaceRegistry.packageAssets.npmFiles);
    for (const hook of harnessSurfaceRegistry.hooks) {
      expect(packageJson.bin[hook.bin]).toBe(hook.path);
      await expect(fileExists(hook.path), hook.bin).resolves.toBe(true);
    }
  });

  it("keeps declared release assets inside package file roots", () => {
    const packageRoots = new Set(["package.json", ...harnessSurfaceRegistry.packageAssets.npmFiles]);
    for (const requiredPath of harnessSurfaceRegistry.packageAssets.releaseRequiredPaths) {
      expect(
        [...packageRoots].some((root) => requiredPath === root || requiredPath.startsWith(`${root}/`)),
        requiredPath,
      ).toBe(true);
    }
  });

  it("matches runtime asset root declarations", () => {
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const distModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "runtime", "assets.js")).href;
    const resolved = resolveBundledAssetPaths(distModuleUrl);

    expect(resolved).toEqual({ packageRoot });
    expect(harnessSurfaceRegistry.packageAssets.runtimeAssetRoots).toEqual([]);
  });
});
