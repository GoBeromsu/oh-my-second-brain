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

  it("keeps fourteen CLI families distinct from eight shared skills and five MCP tools", () => {
    const commands = harnessSurfaceRegistry.cliCommands.map((command) => command.name);
    expect(commands).toEqual([
      "setup",
      "template",
      "note",
      "link",
      "bridge",
      "search",
      "index",
      "graph",
      "host",
      "package",
      "model",
      "serve",
      "hook",
      "status",
    ]);
    const skills = [...harnessSurfaceRegistry.hosts[0]!.skillDirs].sort();
    expect(skills).toEqual([
      "distill",
      "doctor",
      "interview",
      "link",
      "search",
      "status",
      "template",
      "write",
    ]);
    expect([...commands].sort()).not.toEqual(skills);
    expect(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name)).toEqual([
      "write",
      "search",
      "link",
      "status",
      "doctor",
    ]);
    expect(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["interview", "distill", "template"]),
    );
  });

  it("declares the live MCP tool names in order", () => {
    expect(harnessSurfaceRegistry.mcpTools.map((tool) => tool.name)).toEqual(
      omsMcpTools.map((tool) => tool.name),
    );
  });

  it("records link as read-only and write as mixed", () => {
    const link = harnessSurfaceRegistry.mcpTools.find((tool) => tool.name === "link");
    const write = harnessSurfaceRegistry.mcpTools.find((tool) => tool.name === "write");

    expect(link).toMatchObject({
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    // Approved control commit mutates, so write stays a write tool. guide/check/complete do not.
    expect(write).toMatchObject({
      posture: "write",
      destructive: false,
      idempotent: false,
      openWorld: false,
    });
    expect(write?.posture).not.toBe("read");
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
    await expect(fileExists("assets/skills/interview/SKILL.md"), "authored interview skill").resolves.toBe(true);
  });

  it("declares fail-open or no write hook and no reviewer mechanism", async () => {
    expect(harnessSurfaceRegistry.hosts.map((host) => [host.runtime, host.writeHook])).toEqual([
      ["claude", "fail-open"],
      ["codex", "none"],
      ["hermes", "none"],
    ]);
    expect(harnessSurfaceRegistry.hosts.every((host) => !("hardHookGuarantee" in host))).toBe(true);
    // The reviewer role served the deleted completion protocol, so no host may
    // declare a mechanism and no reviewer asset may ship.
    expect(harnessSurfaceRegistry.hosts.every((host) => !("reviewerMechanisms" in host))).toBe(true);
    expect(JSON.stringify(harnessSurfaceRegistry.hosts)).not.toMatch(/unsupported|unavailable|reviewer/iu);
    await expect(fileExists("agents/oms-reviewer.md"), "retired claude reviewer").resolves.toBe(false);
    await expect(fileExists("assets/codex/agents/oms-reviewer.toml"), "retired codex reviewer").resolves.toBe(false);
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

    const registryFiles = harnessSurfaceRegistry.packageAssets.npmFiles;
    const packageFiles = packageJson.files;
    expect([...packageFiles].sort()).toEqual(
      [...registryFiles].sort(),
    );
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
    expect(harnessSurfaceRegistry.packageAssets.releaseRequiredPaths).toEqual(expect.arrayContaining([
      "assets/skills/interview/SKILL.md",
      "skills/interview/SKILL.md",
    ]));
    expect(harnessSurfaceRegistry.packageAssets.releaseRequiredPaths).not.toEqual(expect.arrayContaining([
      "agents/oms-reviewer.md",
      "assets/codex/agents/oms-reviewer.toml",
    ]));
  });

  it("matches runtime asset root declarations", () => {
    const packageRoot = path.join(path.sep, "tmp", "oms-package");
    const distModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "runtime", "assets.js")).href;
    const resolved = resolveBundledAssetPaths(distModuleUrl);

    expect(resolved).toEqual({ packageRoot });
    expect(harnessSurfaceRegistry.packageAssets.runtimeAssetRoots).toEqual([]);
  });
});
