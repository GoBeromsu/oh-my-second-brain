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
/** Advisory write-path hook behavior. Not a save block or process-exit guarantee. */
export type HarnessWriteHook = "fail-open" | "none";

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
  readonly writeHook: HarnessWriteHook;
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

/** One authored skill set. MCP tools are a subset; CLI families stay a different list. */
export const HARNESS_SHARED_SKILLS: readonly string[] = [
  "distill",
  "doctor",
  "link",
  "search",
  "status",
  "write",
];

export const HARNESS_CLI_COMMANDS: readonly HarnessCliCommandSurface[] = [
  { name: "setup", owner: "cli", stability: "stable" },
  { name: "contract", owner: "cli", stability: "experimental" },
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
];

export const HARNESS_MCP_TOOLS: readonly HarnessMcpToolSurface[] = [
  { name: "write", owner: "capture", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
  { name: "search", owner: "retrieval", posture: "read", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
  { name: "link", owner: "capture", posture: "read", destructive: false, idempotent: true, openWorld: false, stability: "stable" },
  { name: "status", owner: "mcp", posture: "read", destructive: false, idempotent: true, openWorld: false, stability: "stable" },
  { name: "doctor", owner: "mcp", posture: "write", destructive: false, idempotent: false, openWorld: false, stability: "stable" },
];

export const HARNESS_WRITE_HOOK: { readonly [runtime in HarnessHostRuntime]: HarnessWriteHook } = {
  claude: "fail-open",
  codex: "none",
  hermes: "none",
};

export const harnessSurfaceRegistry: HarnessSurfaceRegistry = {
  cliCommands: HARNESS_CLI_COMMANDS,
  mcpTools: HARNESS_MCP_TOOLS,
  hosts: [
    {
      runtime: "claude",
      adapterDir: ".",
      skillDirs: HARNESS_SHARED_SKILLS,
      manifestFiles: [".claude-plugin/plugin.json"],
      guidanceFiles: ["assets/claude/CLAUDE.md"],
      hookFiles: ["assets/claude/hooks/oms-guard.mjs"],
      ruleFiles: [],
      mcpConfigFiles: [".mcp.json"],
      writeHook: HARNESS_WRITE_HOOK.claude,
    },
    {
      runtime: "codex",
      adapterDir: ".",
      skillDirs: HARNESS_SHARED_SKILLS,
      manifestFiles: [".codex-plugin/plugin.json"],
      guidanceFiles: ["assets/codex/AGENTS.md"],
      hookFiles: [],
      ruleFiles: ["assets/codex/rules/oms.md"],
      mcpConfigFiles: [".mcp.codex.json"],
      writeHook: HARNESS_WRITE_HOOK.codex,
    },
    {
      runtime: "hermes",
      adapterDir: "assets",
      skillDirs: HARNESS_SHARED_SKILLS,
      manifestFiles: ["hermes-manifest.json"],
      guidanceFiles: ["hermes/SOUL.md", "hermes/README.md"],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      writeHook: HARNESS_WRITE_HOOK.hermes,
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
      "assets/skills/write/SKILL.md",
      "skills/distill/SKILL.md",
      "skills/doctor/SKILL.md",
      "skills/link/SKILL.md",
      "skills/search/SKILL.md",
      "skills/status/SKILL.md",
      "skills/write/SKILL.md",
      "assets/claude/hooks/oms-guard.mjs",
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
