import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isSemanticCliCommand } from "../cli/semantic.js";
import { omsMcpTools } from "../mcp/server.js";
import { resolveBundledAssetPaths } from "../core/runtime/assets.js";
import { harnessSurfaceRegistry } from "./surface-registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  it("declares semantic CLI commands accepted by the semantic router", () => {
    const semanticCommands = harnessSurfaceRegistry.cliCommands
      .filter((command) => command.owner === "semantic-engine")
      .map((command) => command.name);

    expect(semanticCommands).not.toHaveLength(0);
    for (const command of semanticCommands) {
      expect(isSemanticCliCommand(command), command).toBe(true);
    }
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

  it("matches shipped adapter skill directories", async () => {
    for (const host of harnessSurfaceRegistry.hosts) {
      await expect(skillDirs(path.join(host.adapterDir, "skills"))).resolves.toEqual(
        [...host.skillDirs].sort(),
      );
    }
  });

  it("matches shipped core skill directories", async () => {
    await expect(skillDirs("core/skills")).resolves.toEqual([...harnessSurfaceRegistry.coreSkillDirs].sort());
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

    expect(harnessSurfaceRegistry.packageAssets.runtimeAssetRoots).toEqual([
      { id: "ontology", path: path.relative(packageRoot, resolved.ontologyDir), owner: "core" },
      { id: "adapters", path: path.relative(packageRoot, resolved.adapterRoot), owner: "runtime" },
      {
        id: "claude-adapter",
        path: path.relative(packageRoot, resolved.claudeAdapterDir),
        owner: "runtime",
      },
    ]);
  });
});
