export type HarnessHostRuntime = "claude" | "codex" | "hermes";
// allow: SIZE_OK - typed registry data table; split only when entries gain behavior.
export type HarnessSurfaceOwner =
  | "core"
  | "cli"
  | "mcp"
  | "retrieval"
  | "capture"
  | "semantic-engine"
  | "install"
  | "hook"
  | "runtime"
  | "release";
export type HarnessStability = "stable" | "experimental" | "compatibility";
export type HarnessPosture = "read" | "write";

export interface HarnessCliCommandSurface {
  readonly name: string;
  readonly owner: HarnessSurfaceOwner;
  readonly stability: HarnessStability;
}

export interface HarnessMcpToolSurface {
  readonly name: string;
  readonly owner: HarnessSurfaceOwner;
  readonly posture: HarnessPosture;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly stability: HarnessStability;
}

export interface HarnessHostSurface {
  readonly runtime: HarnessHostRuntime;
  readonly adapterDir: string;
  readonly skillDirs: readonly string[];
  readonly manifestFiles: readonly string[];
  readonly guidanceFiles: readonly string[];
  readonly hookFiles: readonly string[];
  readonly ruleFiles: readonly string[];
  readonly mcpConfigFiles: readonly string[];
  readonly hardHookGuarantee: boolean;
}

export interface HarnessHookSurface {
  readonly bin: string;
  readonly path: string;
  readonly owner: HarnessSurfaceOwner;
  readonly runtime: HarnessHostRuntime;
  readonly stability: HarnessStability;
}

export interface HarnessRuntimeAssetRoot {
  readonly id: string;
  readonly path: string;
  readonly owner: HarnessSurfaceOwner;
}

export interface HarnessPackageAssetSurface {
  readonly npmFiles: readonly string[];
  readonly rootShippedFiles: readonly string[];
  readonly runtimeAssetRoots: readonly HarnessRuntimeAssetRoot[];
  readonly releaseRequiredPaths: readonly string[];
}

export interface HarnessSurfaceRegistry {
  readonly cliCommands: readonly HarnessCliCommandSurface[];
  readonly mcpTools: readonly HarnessMcpToolSurface[];
  readonly hosts: readonly HarnessHostSurface[];
  readonly hooks: readonly HarnessHookSurface[];
  readonly packageAssets: HarnessPackageAssetSurface;
}

export const harnessSurfaceRegistry: HarnessSurfaceRegistry = {
  cliCommands: [
    { name: "setup", owner: "cli", stability: "stable" },
    { name: "doctor", owner: "cli", stability: "stable" },
    { name: "audit", owner: "cli", stability: "stable" },
    { name: "lint", owner: "cli", stability: "stable" },
    { name: "link", owner: "cli", stability: "experimental" },
    { name: "linkify", owner: "cli", stability: "experimental" },
    { name: "install", owner: "install", stability: "stable" },
    { name: "uninstall", owner: "install", stability: "stable" },
    { name: "update", owner: "install", stability: "stable" },
    { name: "update-reconcile", owner: "install", stability: "experimental" },
    { name: "mcp", owner: "mcp", stability: "stable" },
    { name: "hook", owner: "hook", stability: "stable" },
    { name: "semantic", owner: "semantic-engine", stability: "experimental" },
    { name: "query", owner: "semantic-engine", stability: "compatibility" },
    { name: "search", owner: "semantic-engine", stability: "experimental" },
    { name: "vsearch", owner: "semantic-engine", stability: "experimental" },
    { name: "get", owner: "semantic-engine", stability: "compatibility" },
    { name: "multi-get", owner: "semantic-engine", stability: "compatibility" },
    { name: "status", owner: "semantic-engine", stability: "compatibility" },
    { name: "embed", owner: "semantic-engine", stability: "experimental" },
    { name: "collection", owner: "semantic-engine", stability: "experimental" },
    { name: "context", owner: "semantic-engine", stability: "experimental" },
    { name: "cleanup", owner: "semantic-engine", stability: "experimental" },
    { name: "serve", owner: "semantic-engine", stability: "experimental" },
    { name: "http", owner: "semantic-engine", stability: "experimental" },
  ],
  mcpTools: [
    { name: "oms_write", owner: "capture", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
    { name: "oms_search", owner: "retrieval", posture: "read", destructive: false, idempotent: true, openWorld: false, stability: "stable" },
    { name: "oms_link", owner: "capture", posture: "write", destructive: true, idempotent: false, openWorld: false, stability: "stable" },
    { name: "oms_status", owner: "mcp", posture: "read", destructive: false, idempotent: true, openWorld: false, stability: "stable" },
    { name: "oms_doctor", owner: "mcp", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
  ],
  hosts: [
    {
      runtime: "claude",
      adapterDir: ".",
      skillDirs: [
        "distill",
        "doctor",
        "link",
        "search",
        "status",
        "write",
      ],
      manifestFiles: [".claude-plugin/plugin.json"],
      guidanceFiles: ["assets/claude/CLAUDE.md"],
      hookFiles: ["assets/claude/hooks/oms-guard.mjs", "assets/claude/hooks/oms-post-guard.mjs"],
      ruleFiles: [],
      mcpConfigFiles: [".mcp.json"],
      hardHookGuarantee: true,
    },
    {
      runtime: "codex",
      adapterDir: ".",
      skillDirs: [
        "distill",
        "doctor",
        "link",
        "search",
        "status",
        "write",
      ],
      manifestFiles: [".codex-plugin/plugin.json"],
      guidanceFiles: ["assets/codex/AGENTS.md"],
      hookFiles: [],
      ruleFiles: ["assets/codex/rules/oms.md"],
      mcpConfigFiles: [".mcp.codex.json"],
      hardHookGuarantee: false,
    },
    {
      runtime: "hermes",
      adapterDir: "assets",
      skillDirs: [
        "distill",
        "doctor",
        "link",
        "search",
        "status",
        "write",
      ],
      manifestFiles: ["hermes-manifest.json"],
      guidanceFiles: ["hermes/SOUL.md", "hermes/README.md"],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: false,
    },
  ],
  hooks: [
    {
      bin: "oms-guard",
      path: "assets/claude/hooks/oms-guard.mjs",
      owner: "hook",
      runtime: "claude",
      stability: "stable",
    },
    {
      bin: "oms-post-guard",
      path: "assets/claude/hooks/oms-post-guard.mjs",
      owner: "hook",
      runtime: "claude",
      stability: "stable",
    },
  ],
  packageAssets: {
    npmFiles: [
      "dist",
      "core/AGENTS.md",
      "core/ontology",
      ".claude-plugin",
      ".codex-plugin",
      ".mcp.json",
      ".mcp.codex.json",
      "assets",
      "docs/adapters.md",
      "docs/install.md",
      "docs/release.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
      "CHANGELOG.md",
      "CHANGELOG-kernel.md",
      "CHANGELOG-cli.md",
      "CHANGELOG-mcp.md",
      "CHANGELOG-vendors.md",
      "CHANGELOG-assets.md",
    ],
    rootShippedFiles: [
      ".mcp.json",
      ".mcp.codex.json",
      "CHANGELOG.md",
      "CHANGELOG-kernel.md",
      "CHANGELOG-cli.md",
      "CHANGELOG-mcp.md",
      "CHANGELOG-vendors.md",
      "CHANGELOG-assets.md",
    ],
    runtimeAssetRoots: [
      { id: "ontology", path: "core/ontology", owner: "core" },
    ],
    releaseRequiredPaths: [
      "package.json",
      "dist/cli/oms.js",
      "dist/mcp/server.js",
      "dist/kernel/harness/surface-registry.js",
      "core/ontology/taxonomy.yaml",
      "core/ontology/concepts",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".mcp.json",
      ".mcp.codex.json",
      "assets/skills/distill/SKILL.md",
      "assets/skills/doctor/SKILL.md",
      "assets/skills/link/SKILL.md",
      "assets/skills/search/SKILL.md",
      "assets/skills/status/SKILL.md",
      "assets/skills/write/SKILL.md",
      "assets/claude/hooks/oms-guard.mjs",
      "assets/claude/hooks/oms-post-guard.mjs",
      "assets/claude/CLAUDE.md",
      "assets/codex/AGENTS.md",
      "assets/codex/rules/oms.md",
      "assets/hermes-manifest.json",
      "assets/hermes/SOUL.md",
      "assets/hermes/README.md",
      "docs/adapters.md",
      "docs/install.md",
      "docs/release.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
    ],
  },
};
