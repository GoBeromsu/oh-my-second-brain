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
  readonly runtimeAssetRoots: readonly HarnessRuntimeAssetRoot[];
  readonly releaseRequiredPaths: readonly string[];
}

export interface HarnessSurfaceRegistry {
  readonly cliCommands: readonly HarnessCliCommandSurface[];
  readonly coreSkillDirs: readonly string[];
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
  coreSkillDirs: [
    "capture",
    "compile",
    "define",
    "distill",
    "doctor",
    "retrieve",
    "setup",
    "uninstall",
    "vault-decision-record",
    "vault-lint",
    "vault-scaffold",
    "wiki",
  ],
  mcpTools: [
    {
      name: "oms_graph_status",
      owner: "mcp",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_graph_build",
      owner: "mcp",
      posture: "write",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_list_concepts",
      owner: "mcp",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_retrieve_by_axis",
      owner: "retrieval",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_retrieve_context",
      owner: "retrieval",
      posture: "write",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_sync_embeddings",
      owner: "semantic-engine",
      posture: "write",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_semantic_query",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_semantic_status",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_semantic_collections",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_semantic_contexts",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_semantic_cleanup",
      owner: "semantic-engine",
      posture: "write",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_get_document",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "query",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "compatibility",
    },
    {
      name: "status",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "compatibility",
    },
    {
      name: "get",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "compatibility",
    },
    {
      name: "multi_get",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "compatibility",
    },
    {
      name: "oms_multi_get_documents",
      owner: "semantic-engine",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: true,
      stability: "experimental",
    },
    {
      name: "oms_lazy_load_note",
      owner: "retrieval",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_validate_contract",
      owner: "core",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_vault_audit",
      owner: "core",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_capture_prepare",
      owner: "capture",
      posture: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      stability: "stable",
    },
    {
      name: "oms_capture_commit",
      owner: "capture",
      posture: "write",
      destructive: false,
      idempotent: false,
      openWorld: false,
      stability: "stable",
    },
  ],
  hosts: [
    {
      runtime: "claude",
      adapterDir: "adapters/claude-code",
      skillDirs: [
        "capture",
        "compile",
        "define",
        "distill",
        "doctor",
        "retrieve",
        "setup",
        "uninstall",
        "update",
        "vault-decision-record",
        "vault-lint",
        "vault-scaffold",
        "wiki",
      ],
      manifestFiles: [".claude-plugin/plugin.json"],
      guidanceFiles: ["CLAUDE.md"],
      hookFiles: ["hooks/oms-guard.mjs", "hooks/oms-post-guard.mjs"],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: true,
    },
    {
      runtime: "codex",
      adapterDir: "adapters/codex",
      skillDirs: [
        "oms-capture",
        "oms-compile",
        "oms-distill",
        "oms-doctor",
        "oms-install",
        "oms-retrieve",
        "oms-setup",
        "oms-uninstall",
        "oms-update",
        "oms-vault-lint",
        "oms-wiki",
      ],
      manifestFiles: [".codex-plugin/plugin.json"],
      guidanceFiles: ["AGENTS.md"],
      hookFiles: [],
      ruleFiles: ["rules/oms.md"],
      mcpConfigFiles: [".mcp.json"],
      hardHookGuarantee: false,
    },
    {
      runtime: "hermes",
      adapterDir: "adapters/hermes",
      skillDirs: [
        "capture",
        "compile",
        "distill",
        "doctor",
        "install",
        "retrieve",
        "setup",
        "uninstall",
        "update",
        "wiki",
      ],
      manifestFiles: ["manifest.json"],
      guidanceFiles: ["README.md", "SOUL.md"],
      hookFiles: [],
      ruleFiles: [],
      mcpConfigFiles: [],
      hardHookGuarantee: false,
    },
  ],
  hooks: [
    {
      bin: "oms-guard",
      path: "adapters/claude-code/hooks/oms-guard.mjs",
      owner: "hook",
      runtime: "claude",
      stability: "stable",
    },
    {
      bin: "oms-post-guard",
      path: "adapters/claude-code/hooks/oms-post-guard.mjs",
      owner: "hook",
      runtime: "claude",
      stability: "stable",
    },
  ],
  packageAssets: {
    npmFiles: [
      "dist",
      "core",
      "adapters",
      "docs/install.md",
      "docs/release.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
    ],
    runtimeAssetRoots: [
      { id: "ontology", path: "core/ontology", owner: "core" },
      { id: "adapters", path: "adapters", owner: "runtime" },
      { id: "claude-adapter", path: "adapters/claude-code", owner: "runtime" },
    ],
    releaseRequiredPaths: [
      "package.json",
      "dist/cli/oms.js",
      "dist/mcp/server.js",
      "dist/harness/surface-registry.js",
      "core/ontology/taxonomy.yaml",
      "core/ontology/concepts",
      "adapters/claude-code/.claude-plugin/plugin.json",
      "adapters/claude-code/skills/setup/SKILL.md",
      "adapters/claude-code/skills/doctor/SKILL.md",
      "adapters/claude-code/skills/define/SKILL.md",
      "adapters/claude-code/skills/capture/SKILL.md",
      "adapters/claude-code/skills/retrieve/SKILL.md",
      "adapters/claude-code/skills/uninstall/SKILL.md",
      "adapters/claude-code/skills/update/SKILL.md",
      "adapters/codex/.codex-plugin/plugin.json",
      "adapters/codex/.mcp.json",
      "adapters/codex/rules/oms.md",
      "adapters/codex/skills/oms-setup/SKILL.md",
      "adapters/codex/skills/oms-capture/SKILL.md",
      "adapters/codex/skills/oms-retrieve/SKILL.md",
      "adapters/codex/skills/oms-update/SKILL.md",
      "adapters/hermes/manifest.json",
      "adapters/hermes/skills/setup/SKILL.md",
      "adapters/hermes/skills/capture/SKILL.md",
      "adapters/hermes/skills/retrieve/SKILL.md",
      "adapters/hermes/skills/update/SKILL.md",
      "docs/install.md",
      "docs/release.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
    ],
  },
};
