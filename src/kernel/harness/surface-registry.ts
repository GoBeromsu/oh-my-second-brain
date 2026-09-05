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
    { name: "template", owner: "cli", stability: "experimental" },
    { name: "note", owner: "capture", stability: "stable" },
    { name: "link", owner: "capture", stability: "stable" },
    { name: "bridge", owner: "install", stability: "stable" },
    { name: "search", owner: "semantic-engine", stability: "experimental" },
    { name: "index", owner: "semantic-engine", stability: "experimental" },
    { name: "graph", owner: "semantic-engine", stability: "experimental" },
    { name: "host", owner: "install", stability: "stable" },
    { name: "package", owner: "release", stability: "stable" },
    { name: "model", owner: "semantic-engine", stability: "stable" },
    { name: "serve", owner: "semantic-engine", stability: "experimental" },
    { name: "hook", owner: "hook", stability: "stable" },
    { name: "status", owner: "cli", stability: "stable" },
  ],
  mcpTools: [
    { name: "write", owner: "capture", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
    { name: "search", owner: "retrieval", posture: "read", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
    { name: "link", owner: "capture", posture: "write", destructive: true, idempotent: false, openWorld: false, stability: "stable" },
    { name: "status", owner: "mcp", posture: "read", destructive: false, idempotent: true, openWorld: false, stability: "stable" },
    { name: "doctor", owner: "mcp", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
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
        "template",
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
        "template",
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
        "template",
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
      ".claude-plugin",
      ".codex-plugin",
      ".mcp.json",
      ".mcp.codex.json",
      "assets",
      "skills",
      "docs/adapters.md",
      "docs/install.md",
      "docs/architecture.md",
      "docs/conventions.md",
      "docs/cli-map.md",
      "docs/verified-target.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
      "ACKNOWLEDGMENTS.md",
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
    runtimeAssetRoots: [],
    releaseRequiredPaths: [
      "package.json",
      "dist/cli/oms.js",
      "dist/mcp/server.js",
      "dist/kernel/harness/surface-registry.js",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".mcp.json",
      ".mcp.codex.json",
      "assets/skills/distill/SKILL.md",
      "assets/skills/doctor/SKILL.md",
      "assets/skills/link/SKILL.md",
      "assets/skills/search/SKILL.md",
      "assets/skills/status/SKILL.md",
      "assets/skills/template/SKILL.md",
      "assets/skills/write/SKILL.md",
      "skills/distill/SKILL.md",
      "skills/doctor/SKILL.md",
      "skills/link/SKILL.md",
      "skills/search/SKILL.md",
      "skills/status/SKILL.md",
      "skills/template/SKILL.md",
      "skills/write/SKILL.md",
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
      "scripts/install.sh",
      "scripts/uninstall.sh",
    ],
  },
};
