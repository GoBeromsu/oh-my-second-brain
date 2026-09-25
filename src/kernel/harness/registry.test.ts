import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry, type HarnessSurfaceRegistry } from "./surface-registry.js";
import { validateHarnessRegistry } from "./validation.js";

function cloneRegistry(): HarnessSurfaceRegistry {
  return structuredClone(harnessSurfaceRegistry) as HarnessSurfaceRegistry;
}

function withHost(
  runtime: HarnessSurfaceRegistry["hosts"][number]["runtime"],
  patch: Partial<HarnessSurfaceRegistry["hosts"][number]>,
): HarnessSurfaceRegistry {
  const base = cloneRegistry();
  return {
    ...base,
    hosts: base.hosts.map((host) => host.runtime === runtime ? { ...host, ...patch } : host),
  };
}

describe("validateHarnessRegistry", () => {
  it("accepts the canonical validation-only harness registry", () => {
    expect(validateHarnessRegistry(harnessSurfaceRegistry)).toEqual([]);
  });

  it("reports duplicate names within a registry surface", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      mcpTools: [...base.mcpTools, { ...base.mcpTools[0]! }],
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_name",
          surface: "mcpTools",
          value: registry.mcpTools[0]!.name,
        }),
      ]),
    );
  });

  it("reports missing owner metadata", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      mcpTools: [
        {
          ...base.mcpTools[0]!,
          owner: undefined as unknown as HarnessSurfaceRegistry["mcpTools"][number]["owner"],
        },
        ...base.mcpTools.slice(1),
      ],
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_owner",
          surface: `mcpTools.${registry.mcpTools[0]!.name}`,
        }),
      ]),
    );
  });

  it("reports invalid MCP posture values", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      mcpTools: [
        {
          ...base.mcpTools[0]!,
          posture: "aggressive-write" as unknown as HarnessSurfaceRegistry["mcpTools"][number]["posture"],
        },
        ...base.mcpTools.slice(1),
      ],
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_posture",
          surface: `mcpTools.${registry.mcpTools[0]!.name}`,
          value: "aggressive-write",
        }),
      ]),
    );
  });

  it("reports a missing shared skill and an unregistered skill directory", () => {
    const missingDistill = withHost("claude", {
      skillDirs: harnessSurfaceRegistry.hosts[0]!.skillDirs.filter((skill) => skill !== "distill"),
    });
    const unregistered = withHost("hermes", {
      skillDirs: [...harnessSurfaceRegistry.hosts[0]!.skillDirs, "backfill"],
    });

    expect(validateHarnessRegistry(missingDistill)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "hosts.claude.skillDirs",
          value: "distill",
        }),
      ]),
    );
    expect(validateHarnessRegistry(unregistered)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unregistered_surface",
          surface: "hosts.hermes.skillDirs",
          value: "backfill",
        }),
      ]),
    );
  });

  it("reports a missing MCP tool and an unregistered MCP tool", () => {
    const base = cloneRegistry();
    const missingLink: HarnessSurfaceRegistry = {
      ...base,
      mcpTools: base.mcpTools.filter((tool) => tool.name !== "link"),
    };
    const unregistered: HarnessSurfaceRegistry = {
      ...base,
      mcpTools: [
        ...base.mcpTools,
        {
          ...base.mcpTools[1]!,
          name: "interview",
        },
      ],
    };

    expect(validateHarnessRegistry(missingLink)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "mcpTools",
          value: "link",
        }),
      ]),
    );
    expect(validateHarnessRegistry(unregistered)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unregistered_surface",
          surface: "mcpTools",
          value: "interview",
        }),
      ]),
    );
  });

  it("reports a missing CLI family and an unregistered CLI family", () => {
    const base = cloneRegistry();
    const missingNote: HarnessSurfaceRegistry = {
      ...base,
      cliCommands: base.cliCommands.filter((command) => command.name !== "note"),
    };
    const unregistered: HarnessSurfaceRegistry = {
      ...base,
      cliCommands: [
        ...base.cliCommands,
        { name: "doc", owner: "cli", stability: "stable" },
      ],
    };

    expect(validateHarnessRegistry(missingNote)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "cliCommands",
          value: "note",
        }),
      ]),
    );
    expect(validateHarnessRegistry(unregistered)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unregistered_surface",
          surface: "cliCommands",
          value: "doc",
        }),
      ]),
    );
  });

  it("rejects a boolean hook guarantee and a write hook that claims to block saves", () => {
    const base = cloneRegistry();
    const blocked = withHost("claude", {
      writeHook: "block" as unknown as HarnessSurfaceRegistry["hosts"][number]["writeHook"],
    });
    const aliased = {
      ...base,
      hosts: base.hosts.map((host) => {
        if (host.runtime !== "claude") return host;
        const declared = {
          ...host,
          writeHook: undefined,
          hardHookGuarantee: true,
        };
        return declared as typeof host;
      }),
    };

    expect(validateHarnessRegistry(blocked)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_write_hook",
          surface: "hosts.claude.writeHook",
          value: "block",
        }),
      ]),
    );
    expect(validateHarnessRegistry(aliased)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "hosts.claude.writeHook",
        }),
      ]),
    );
    expect(validateHarnessRegistry(aliased).some((violation) => violation.value === "true")).toBe(false);
  });

  // The reviewer role served the deleted completion protocol. Nothing in the
  // registry may declare a mechanism, ship an asset for one, or require one in
  // the release list; the validator has no reviewer surface left to check.
  it("declares no reviewer mechanism, asset, or release requirement", () => {
    expect(harnessSurfaceRegistry.hosts.every((host) => !("reviewerMechanisms" in host))).toBe(true);
    expect(JSON.stringify(harnessSurfaceRegistry)).not.toMatch(/reviewer/iu);
    expect(harnessSurfaceRegistry.packageAssets.npmFiles).not.toContain("agents");
    expect(validateHarnessRegistry(cloneRegistry())).toEqual([]);
  });

  it("reports a shipped skill dropped from the release list", () => {
    const base = cloneRegistry();
    const droppedSkill: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        releaseRequiredPaths: base.packageAssets.releaseRequiredPaths.filter(
          (requiredPath) => requiredPath !== "assets/skills/write/SKILL.md",
        ),
      },
    };
    const droppedRoot: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        npmFiles: base.packageAssets.npmFiles.filter((npmFile) => npmFile !== "skills"),
      },
    };

    expect(validateHarnessRegistry(droppedSkill)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "packageAssets.releaseRequiredPaths",
          value: "assets/skills/write/SKILL.md",
        }),
      ]),
    );
    expect(validateHarnessRegistry(droppedRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_surface",
          surface: "packageAssets.npmFiles",
          value: "skills/write/SKILL.md",
        }),
      ]),
    );
  });

  it("reports registry paths that point at protected or source surfaces", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        runtimeAssetRoots: [
          ...base.packageAssets.runtimeAssetRoots,
          { id: "forbidden", path: "src/cli/oms.ts", owner: "runtime" },
        ],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.runtimeAssetRoots.forbidden",
          value: "src/cli/oms.ts",
        }),
      ]),
    );
  });

  it("rejects the shipped skills mirror as a runtime asset root", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        runtimeAssetRoots: [
          ...base.packageAssets.runtimeAssetRoots,
          { id: "skills-mirror", path: "skills/write", owner: "runtime" },
        ],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.runtimeAssetRoots.skills-mirror",
          value: "skills/write",
        }),
      ]),
    );
  });

  it("reports registry paths that traverse into protected or source surfaces", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        runtimeAssetRoots: [
          ...base.packageAssets.runtimeAssetRoots,
          { id: "traverses-source", path: "adapters/../src/cli/oms.ts", owner: "runtime" },
          { id: "traverses-core-agents", path: "docs/../core/AGENTS.md", owner: "runtime" },
        ],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.runtimeAssetRoots.traverses-source",
          value: "adapters/../src/cli/oms.ts",
        }),
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.runtimeAssetRoots.traverses-core-agents",
          value: "docs/../core/AGENTS.md",
        }),
      ]),
    );
  });

  it("reports rootShippedFiles entries with path separators", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        rootShippedFiles: [...base.packageAssets.rootShippedFiles, "docs/x.md"],
        npmFiles: [...base.packageAssets.npmFiles, "docs/x.md"],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.rootShippedFiles.docs/x.md",
          value: "docs/x.md",
        }),
      ]),
    );
  });

  it("reports rootShippedFiles entries with parent directory traversal", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        rootShippedFiles: [...base.packageAssets.rootShippedFiles, ".."],
        npmFiles: [...base.packageAssets.npmFiles, ".."],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_path",
          surface: "packageAssets.rootShippedFiles...",
          value: "..",
        }),
      ]),
    );
  });

  it("reports rootShippedFiles entries not present in npmFiles", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        rootShippedFiles: [...base.packageAssets.rootShippedFiles, "MISSING_FILE.txt"],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_path",
          surface: "packageAssets.rootShippedFiles.MISSING_FILE.txt",
        }),
      ]),
    );
  });

  it("reports duplicate rootShippedFiles entries", () => {
    const base = cloneRegistry();
    const registry: HarnessSurfaceRegistry = {
      ...base,
      packageAssets: {
        ...base.packageAssets,
        rootShippedFiles: [...base.packageAssets.rootShippedFiles, "package.json", "package.json"],
      },
    };

    expect(validateHarnessRegistry(registry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_path",
          surface: "packageAssets.rootShippedFiles",
          value: "package.json",
        }),
      ]),
    );
  });
});
