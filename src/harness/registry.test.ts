import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry, type HarnessSurfaceRegistry } from "./surface-registry.js";
import { validateHarnessRegistry } from "./validation.js";

function cloneRegistry(): HarnessSurfaceRegistry {
  return structuredClone(harnessSurfaceRegistry) as HarnessSurfaceRegistry;
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
});
