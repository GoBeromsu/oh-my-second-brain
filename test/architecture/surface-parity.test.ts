import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNote } from "../../src/kernel/conventions/frontmatter.js";
import { harnessSurfaceRegistry } from "../../src/kernel/harness/surface-registry.js";
import { omsMcpTools } from "../../src/mcp/server.js";
import { SHARED_SKILLS_SOURCE } from "../../src/assets/shared-skills.js";

/**
 * Surface-set parity gate.
 *
 * The live target set (7 skills / 5 tools) is asserted directly. The fixture
 * cases below prove that the rules also fail closed when a surface drifts.
 *
 * The rule set is deliberately NOT "all three lists are equal". The three
 * surfaces are related but distinct:
 *
 *   skills      - the authored skill set
 *   mcpTools    - a strict SUBSET of skills, namely those declaring `mcp_tool`
 *   cliCommands - an INDEPENDENT allowlist of every real CLI command,
 *                 including the five public search commands and the guarded
 *                 template command family. It is
 *                 intentionally distinct from the skill and MCP-tool surfaces.
 *
 * Enforcing equality across all three would let a contributor satisfy the gate
 * by silently deleting a surface. That is the failure this shape exists to
 * prevent.
 */

interface SurfaceSets {
  readonly skills: readonly string[];
  /** Skill directories whose frontmatter declares an MCP tool. */
  readonly skillsWithTool: readonly string[];
  /** MCP tool names declared by skill frontmatter. */
  readonly declaredMcpTools: readonly string[];
  readonly mcpTools: readonly string[];
  /** Posture metadata declared by the harness registry. */
  readonly registryMcpTools: readonly McpToolPosture[];
  /** Tool definitions the MCP server actually returns from tools/list. */
  readonly registeredMcpTools: readonly McpToolPosture[];
  readonly cliCommands: readonly string[];
  /** Commands accepted by the CLI dispatcher. */
  readonly dispatcherCliCommands: readonly string[];
}

interface McpToolPosture {
  readonly name: string;
  readonly posture: "read" | "write";
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
}

export interface ParityViolation {
  readonly rule: string;
  readonly detail: string;
}

const TARGET_CLI_COMMANDS = [
  "setup", "template", "note", "link", "bridge", "search", "index",
  "graph", "host", "package", "model", "serve", "hook", "status",
] as const;

/** Pure rule evaluation so every rule can be proven against fixtures. */
export function checkSurfaceSets(sets: SurfaceSets, expected: { skills: number; tools: number }): ParityViolation[] {
  const violations: ParityViolation[] = [];
  const skills = new Set(sets.skills);
  const withTool = new Set(sets.skillsWithTool);

  for (const name of withTool) {
    if (!skills.has(name)) {
      violations.push({ rule: "tool-declaring-skill-exists", detail: `${name} declares mcp_tool but is not a skill` });
    }
  }

  const declaredTools = new Set(sets.declaredMcpTools);
  for (const tool of sets.mcpTools) {
    if (!declaredTools.has(tool)) {
      violations.push({
        rule: "tools-subset-of-skills",
        detail: `MCP tool ${tool} has no skill declaring it via mcp_tool`,
      });
    }
  }

  if (sets.mcpTools.length !== declaredTools.size) {
    violations.push({
      rule: "tool-count-matches-declarations",
      detail: `${sets.mcpTools.length} MCP tools registered but ${declaredTools.size} tools are declared by skills`,
    });
  }

  const registryTools = new Map(sets.registryMcpTools.map((tool) => [tool.name, tool]));
  const registeredTools = new Map(sets.registeredMcpTools.map((tool) => [tool.name, tool]));
  for (const [name, registryTool] of registryTools) {
    const registeredTool = registeredTools.get(name);
    if (registeredTool === undefined) {
      violations.push({ rule: "server-tools-match-registry", detail: `Registry tool ${name} is not registered by the MCP server` });
    } else if (
      registeredTool.posture !== registryTool.posture
      || registeredTool.destructive !== registryTool.destructive
      || registeredTool.idempotent !== registryTool.idempotent
      || registeredTool.openWorld !== registryTool.openWorld
    ) {
      violations.push({ rule: "server-tools-match-registry", detail: `MCP server tool ${name} annotations differ from the registry` });
    }
  }
  for (const name of registeredTools.keys()) {
    if (!registryTools.has(name)) {
      violations.push({ rule: "server-tools-match-registry", detail: `MCP server registers ${name} without a registry entry` });
    }
  }

  if (sets.skills.length !== expected.skills) {
    violations.push({
      rule: "skill-count",
      detail: `expected ${expected.skills} skills, found ${sets.skills.length}`,
    });
  }

  if (sets.mcpTools.length !== expected.tools) {
    violations.push({
      rule: "tool-count",
      detail: `expected ${expected.tools} MCP tools, found ${sets.mcpTools.length}`,
    });
  }

  if (sets.skills.length === 0) {
    violations.push({ rule: "skills-populated", detail: "Skill directory scan is empty" });
  }

  if (sets.mcpTools.length === 0) {
    violations.push({ rule: "mcp-tools-populated", detail: "MCP tool registry is empty" });
  }

  for (const tool of sets.mcpTools) {
    if (tool.startsWith("oms_")) {
      violations.push({ rule: "mcp-tool-local-name", detail: `MCP tool ${tool} must not repeat the oms server namespace` });
    }
    if (`oms_${tool}`.startsWith("oms_oms_")) {
      violations.push({ rule: "mcp-tool-qualified-name", detail: `Qualified MCP tool oms_${tool} has a doubled oms namespace` });
    }
  }

  if (sets.cliCommands.length === 0) {
    violations.push({ rule: "cli-allowlist-populated", detail: "CLI command allowlist is empty" });
  }
  if (
    [...sets.cliCommands].sort().join("\0")
    !== [...TARGET_CLI_COMMANDS].sort().join("\0")
  ) {
    violations.push({
      rule: "cli-allowlist-exact",
      detail: `CLI allowlist must be exactly ${TARGET_CLI_COMMANDS.join(", ")}`,
    });
  }

  const dispatcherCommands = new Set(sets.dispatcherCliCommands);
  for (const command of sets.cliCommands) {
    if (!dispatcherCommands.has(command)) {
      violations.push({
        rule: "cli-allowlist-matches-dispatcher",
        detail: `Registry command ${command} is not accepted by the CLI dispatcher`,
      });
    }
  }
  for (const command of dispatcherCommands) {
    if (!sets.cliCommands.includes(command)) {
      violations.push({
        rule: "cli-allowlist-matches-dispatcher",
        detail: `CLI dispatcher command ${command} is absent from the registry`,
      });
    }
  }

  return violations;
}

const TARGET = { skills: 7, tools: 5 } as const;
const MCP_SERVER_ID = "oms";

const CLEAN: SurfaceSets = {
  skills: ["write", "search", "link", "distill", "status", "doctor", "template"],
  skillsWithTool: ["write", "search", "link", "status", "doctor"],
  // In this fixture, a tool is identified by its declaring skill; the `oms_`
  // naming convention is verified separately by the registry parity suite.
  mcpTools: ["write", "search", "link", "status", "doctor"],
  registryMcpTools: [
    { name: "write", posture: "write", destructive: false, idempotent: false, openWorld: false },
    { name: "search", posture: "read", destructive: false, idempotent: false, openWorld: false },
    { name: "link", posture: "write", destructive: true, idempotent: false, openWorld: false },
    { name: "status", posture: "read", destructive: false, idempotent: true, openWorld: false },
    { name: "doctor", posture: "write", destructive: false, idempotent: false, openWorld: false },
  ],
  registeredMcpTools: [
    { name: "write", posture: "write", destructive: false, idempotent: false, openWorld: false },
    { name: "search", posture: "read", destructive: false, idempotent: false, openWorld: false },
    { name: "link", posture: "write", destructive: true, idempotent: false, openWorld: false },
    { name: "status", posture: "read", destructive: false, idempotent: true, openWorld: false },
    { name: "doctor", posture: "write", destructive: false, idempotent: false, openWorld: false },
  ],
  cliCommands: [
    ...TARGET_CLI_COMMANDS,
  ],
  declaredMcpTools: ["write", "search", "link", "status", "doctor"],
  dispatcherCliCommands: [
    ...TARGET_CLI_COMMANDS,
  ],
};

describe("surface-set parity gate (rules)", () => {
  it("passes on the target surface", () => {
    expect(checkSurfaceSets(CLEAN, TARGET)).toEqual([]);
  });

  it("fails when the skill list changes without the tool list", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, skills: [...CLEAN.skills, "extra"] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("skill-count");
  });

  it("fails when the tool list changes without the skill list", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, mcpTools: [...CLEAN.mcpTools, "orphan"] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("tools-subset-of-skills");
    expect(violations.map((v) => v.rule)).toContain("tool-count");
  });

  it("fails when a registered tool has no declaring skill", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, mcpTools: ["write", "search", "link", "status", "ghost"] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("tools-subset-of-skills");
  });

  it("fails when a local tool repeats the server namespace", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, mcpTools: ["oms_write", "search", "link", "status", "doctor"] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("mcp-tool-local-name");
    expect(violations.map((v) => v.rule)).toContain("mcp-tool-qualified-name");
  });

  it("fails when the MCP server registers an extra tool absent from the registry", () => {
    const violations = checkSurfaceSets(
      {
        ...CLEAN,
        registeredMcpTools: [
          ...CLEAN.registeredMcpTools,
          { name: "oms_extra", posture: "read", destructive: false, idempotent: true, openWorld: false },
        ],
      },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("server-tools-match-registry");
  });

  it("fails when a registered tool annotation differs from the registry", () => {
    const violations = checkSurfaceSets(
      {
        ...CLEAN,
        registeredMcpTools: CLEAN.registeredMcpTools.map((tool) =>
          tool.name === "status" ? { ...tool, posture: "write" as const } : tool,
        ),
      },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("server-tools-match-registry");
  });

  it("fails when a skill declares a tool that is never registered", () => {
    const violations = checkSurfaceSets(
      {
        ...CLEAN,
        skillsWithTool: [...CLEAN.skillsWithTool, "distill"],
        declaredMcpTools: [...CLEAN.declaredMcpTools, "distill"],
      },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("tool-count-matches-declarations");
  });

  it("does NOT require CLI commands to equal the skill set", () => {
    const violations = checkSurfaceSets(CLEAN, TARGET);
    expect(violations).toEqual([]);
    expect(CLEAN.cliCommands).toContain("index");
    expect(CLEAN.cliCommands).toContain("template");
    expect(CLEAN.skills).not.toContain("index");
  });

  it("fails when the CLI allowlist is emptied", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, cliCommands: [] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("cli-allowlist-populated");
    expect(violations.map((v) => v.rule)).toContain("cli-allowlist-exact");
  });

  it("fails when the registry and dispatcher add the same unapproved CLI command", () => {
    const violations = checkSurfaceSets(
      {
        ...CLEAN,
        cliCommands: [...CLEAN.cliCommands, "extra"],
        dispatcherCliCommands: [...CLEAN.dispatcherCliCommands, "extra"],
      },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("cli-allowlist-exact");
  });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowedSkillFrontmatterKeys = new Set(["name", "description", "aliases", "mcp_tool", "mcp_args"]);

function realDispatcherCommands(): string[] {
  const omsSource = readFileSync(path.join(repoRoot, "src/cli/oms.ts"), "utf-8");
  const directCommands = [...omsSource.matchAll(/\bcommand === "([^"]+)"/g)]
    .map((match) => match[1]!);
  return [...new Set(directCommands)].sort();
}

function liveSurfaceSets(skillRoot = path.join(repoRoot, "assets/skills")): SurfaceSets {
  const skillDirs = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(skillDirs, "assets/skills scan must not be empty").not.toEqual([]);

  const parsedSkills = skillDirs.map((skill) => {
    const parsed = parseNote(readFileSync(path.join(skillRoot, skill, "SKILL.md"), "utf-8"));
    expect(parsed.hasFrontmatter, `${skill}/SKILL.md must have frontmatter`).toBe(true);
    expect(parsed.diagnostics, `${skill}/SKILL.md frontmatter must parse`).toEqual([]);
    expect(Object.keys(parsed.frontmatter).every((key) => allowedSkillFrontmatterKeys.has(key))).toBe(true);
    return { skill, frontmatter: parsed.frontmatter };
  });
  // Inspect authored files, not merely directory names, so an empty or
  // stubbed skill tree cannot satisfy the parity gate.
  expect(parsedSkills.length, "authored skill file scan must be nonzero").toBeGreaterThan(0);

  expect(parsedSkills).toHaveLength(TARGET.skills);
  const skillsWithTool = parsedSkills.filter(({ frontmatter }) => frontmatter["mcp_tool"] !== undefined);
  expect(skillsWithTool).toHaveLength(TARGET.tools);
  for (const { frontmatter } of skillsWithTool) {
    expect(typeof frontmatter["mcp_tool"]).toBe("string");
    expect(frontmatter["mcp_args"]).toBeDefined();
  }
  const distill = parsedSkills.find(({ skill }) => skill === "distill");
  expect(distill, "distill skill must exist").toBeDefined();
  expect(distill!.frontmatter["mcp_tool"]).toBeUndefined();
  expect(distill!.frontmatter["mcp_args"]).toBeUndefined();

  const declaredMcpTools = skillsWithTool.map(({ frontmatter }) => frontmatter["mcp_tool"] as string).sort();
  const mcpTools = harnessSurfaceRegistry.mcpTools.map((tool) => tool.name).sort();
  expect(mcpTools, "MCP tool registry must not be empty").not.toEqual([]);
  expect(mcpTools).toEqual(declaredMcpTools);
  const searchTool = omsMcpTools.find((tool) => tool.name === "search");
  const searchOperations = (
    (searchTool?.inputSchema as {
      readonly oneOf?: readonly {
        readonly properties?: Record<string, { readonly const?: string }>;
      }[];
    }).oneOf ?? []
  )
    .map((branch) => branch.properties?.["op"]?.const)
    .filter((op): op is string => typeof op === "string");
  expect(searchOperations.sort()).toEqual([
    "context",
    "get-document",
    "get-document",
    "get-document",
    "index-status",
    "query",
    "query",
    "query",
    "template-scan",
    "templates",
    "templates",
  ]);
  const queryBranch = (
    (searchTool?.inputSchema as {
      readonly oneOf?: readonly {
        readonly properties?: Record<string, unknown>;
      }[];
    }).oneOf ?? []
  ).find((branch) => (
    (branch.properties?.["op"] as { readonly const?: string } | undefined)?.const === "query"
  ));
  const queryProperties = queryBranch?.properties;
  expect(queryProperties).toMatchObject({
    axes: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder: expect.any(Object),
        field: expect.any(Object),
        link: expect.any(Object),
      },
    },
    limit: { type: "integer", minimum: 0, default: 10 },
    candidateLimit: { type: "integer", minimum: 1 },
    rerank: { type: "boolean", default: false },
    minScore: { type: "number", default: 0 },
    cursor: { type: "string" },
  });
  const doctorTool = omsMcpTools.find((tool) => tool.name === "doctor");
  const doctorOperations = [...new Set((
    (doctorTool?.inputSchema as {
      readonly oneOf?: readonly {
        readonly properties?: Record<string, { readonly const?: string }>;
      }[];
    }).oneOf ?? []
  )
    .map((branch) => branch.properties?.["op"]?.const)
    .filter((op): op is string => typeof op === "string"))];
  expect(doctorOperations.sort()).toEqual([
    "audit",
    "backfill-defaults",
    "build-graph",
    "cleanup",
    "regenerate-types",
    "sync-embeddings",
    "validate",
  ]);
  const registeredMcpTools = omsMcpTools.map((tool) => ({
    name: tool.name,
    posture: tool.annotations?.readOnlyHint === true ? "read" : "write" as const,
    destructive: tool.annotations?.destructiveHint === true,
    idempotent: tool.annotations?.idempotentHint === true,
    openWorld: tool.annotations?.openWorldHint === true,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const registryPostures = harnessSurfaceRegistry.mcpTools.map((tool) => ({
    name: tool.name,
    posture: tool.posture,
    destructive: tool.destructive,
    idempotent: tool.idempotent,
    openWorld: tool.openWorld,
  })).sort((left, right) => left.name.localeCompare(right.name));

  const cliCommands = harnessSurfaceRegistry.cliCommands.map((command) => command.name).sort();
  return {
    skills: skillDirs,
    skillsWithTool: skillsWithTool.map(({ skill }) => skill),
    declaredMcpTools,
    mcpTools,
    registryMcpTools: registryPostures,
    registeredMcpTools,
    cliCommands,
    dispatcherCliCommands: realDispatcherCommands(),
  };
}

const CURRENT_GUIDANCE_SCANNER_CATEGORIES = [
  "registry-guidance",
  "registry-rules",
  "shared-skills",
  "readmes",
  "top-level-docs",
] as const;

type CurrentGuidanceScannerCategory = typeof CURRENT_GUIDANCE_SCANNER_CATEGORIES[number];

interface CurrentGuidanceFile {
  readonly category: CurrentGuidanceScannerCategory;
  readonly path: string;
  readonly content: string;
}

interface CurrentGuidanceViolation {
  readonly category: CurrentGuidanceScannerCategory;
  readonly path: string;
  readonly retiredSpelling: string;
}

const RETIRED_GUIDANCE_SPELLINGS: readonly {
  readonly retiredSpelling: string;
  readonly pattern: RegExp;
}[] = [
  { retiredSpelling: "oms semantic", pattern: /\boms\s+semantic\b/g },
  { retiredSpelling: "top-level collection/context/cleanup/http", pattern: /\boms\s+(?:collection|context|cleanup|http)\b/g },
  { retiredSpelling: "top-level query/vsearch/get/multi-get", pattern: /\boms\s+(?:query|vsearch|get|multi-get)\b/g },
  { retiredSpelling: "old implicit search syntax", pattern: /\boms\s+search\s+(?!(?:query|context)\b)/g },
  { retiredSpelling: "old index leaf", pattern: /\boms\s+index\s+(?:cleanup|collections|contexts)\b/g },
  {
    retiredSpelling: "retired top-level command",
    pattern: /\boms\s+(?:doctor|audit|reconcile|linkify|embed|doc|mcp|lint|install|uninstall|update)\b/g,
  },
  { retiredSpelling: "old repository-link syntax", pattern: /\boms\s+link\s+(?:--vault|--folder)\b/g },
  { retiredSpelling: "old hook leaf", pattern: /\boms\s+hook\s+(?:pre-tool-use|post-tool-use)\b/g },
  { retiredSpelling: "--embedding-*", pattern: /--embedding-[A-Za-z0-9_-]+\b/g },
];

function currentGuidanceViolations(files: readonly CurrentGuidanceFile[]): CurrentGuidanceViolation[] {
  return files.flatMap((file) => RETIRED_GUIDANCE_SPELLINGS.flatMap(({ retiredSpelling, pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(file.content)
      ? [{ category: file.category, path: file.path, retiredSpelling }]
      : [];
  }));
}

function currentGuidanceFiles(): CurrentGuidanceFile[] {
  const hostFiles = harnessSurfaceRegistry.hosts.flatMap((host) => [
    ...host.guidanceFiles.map((file) => ({
      category: "registry-guidance" as const,
      path: path.join(host.adapterDir, file),
    })),
    ...host.ruleFiles.map((file) => ({
      category: "registry-rules" as const,
      path: path.join(host.adapterDir, file),
    })),
  ]);
  const sharedSkillDirs = [...new Set(
    harnessSurfaceRegistry.hosts.flatMap((host) => host.skillDirs),
  )].sort();
  const sharedSkills = sharedSkillDirs
    .map((skillDir) => ({
      category: "shared-skills" as const,
      path: path.join(SHARED_SKILLS_SOURCE, skillDir, "SKILL.md"),
    }));
  // Only top-level current docs are guidance. Decision, research, measurement,
  // and preregistration records are historical evidence and must not be rewritten.
  const topLevelDocs = readdirSync(path.join(repoRoot, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("CHANGELOG"))
    .map((entry) => ({
      category: "top-level-docs" as const,
      path: path.join("docs", entry.name),
    }));
  const files = [
    ...hostFiles,
    ...sharedSkills,
    { category: "readmes" as const, path: "README.md" },
    { category: "readmes" as const, path: "README.ko.md" },
    ...topLevelDocs,
  ];

  return files.map((file) => ({
    ...file,
    content: readFileSync(path.join(repoRoot, file.path), "utf-8"),
  }));
}

describe("current guidance CLI spellings", () => {
  it("accepts canonical command fixtures", () => {
    const fixtures: CurrentGuidanceFile[] = [
      { category: "shared-skills", path: "accepted-search", content: "`oms search query topic`" },
      { category: "shared-skills", path: "accepted-note-get", content: "`oms note get note-id`" },
      { category: "shared-skills", path: "accepted-status", content: "`oms status`" },
      { category: "shared-skills", path: "accepted-embed", content: "`oms index embed`" },
      { category: "shared-skills", path: "accepted-index-status", content: "`oms index status`" },
      { category: "shared-skills", path: "accepted-index-clean", content: "`oms index clean`" },
    ];

    expect(currentGuidanceViolations(fixtures)).toEqual([]);
  });

  it("rejects retired command and flag fixtures", () => {
    const fixtures: CurrentGuidanceFile[] = [
      { category: "shared-skills", path: "semantic", content: "`oms semantic query topic`" },
      { category: "shared-skills", path: "collection", content: "`oms collection list`" },
      { category: "shared-skills", path: "context", content: "`oms context list`" },
      { category: "shared-skills", path: "cleanup", content: "`oms cleanup`" },
      { category: "shared-skills", path: "http", content: "`oms http`" },
      { category: "shared-skills", path: "query", content: "`oms query topic`" },
      { category: "shared-skills", path: "vsearch", content: "`oms vsearch topic`" },
      { category: "shared-skills", path: "get", content: "`oms get note.md`" },
      { category: "shared-skills", path: "multi-get", content: "`oms multi-get a.md b.md`" },
      { category: "shared-skills", path: "implicit-search", content: "`oms search topic`" },
      { category: "shared-skills", path: "index-cleanup", content: "`oms index cleanup`" },
      { category: "shared-skills", path: "index-collections", content: "`oms index collections`" },
      { category: "shared-skills", path: "index-contexts", content: "`oms index contexts`" },
      { category: "shared-skills", path: "doctor", content: "`oms doctor`" },
      { category: "shared-skills", path: "audit", content: "`oms audit`" },
      { category: "shared-skills", path: "reconcile", content: "`oms reconcile`" },
      { category: "shared-skills", path: "linkify", content: "`oms linkify`" },
      { category: "shared-skills", path: "embed", content: "`oms embed`" },
      { category: "shared-skills", path: "doc", content: "`oms doc get note.md`" },
      { category: "shared-skills", path: "mcp", content: "`oms mcp`" },
      { category: "shared-skills", path: "lint", content: "`oms lint`" },
      { category: "shared-skills", path: "install", content: "`oms install`" },
      { category: "shared-skills", path: "uninstall", content: "`oms uninstall`" },
      { category: "shared-skills", path: "update", content: "`oms update`" },
      { category: "shared-skills", path: "old-link", content: "`oms link --vault ~/notes --folder project`" },
      { category: "shared-skills", path: "old-hook", content: "`oms hook pre-tool-use`" },
      { category: "shared-skills", path: "embedding-default", content: "`oms setup --embedding-default`" },
      { category: "shared-skills", path: "embedding-descriptor", content: "`oms setup --embedding-descriptor model.json`" },
      { category: "shared-skills", path: "embedding-no-default", content: "`oms setup --embedding-no-default`" },
    ];

    expect(currentGuidanceViolations(fixtures).map((violation) => violation.path)).toEqual([
      "semantic",
      "collection",
      "context",
      "cleanup",
      "http",
      "query",
      "vsearch",
      "get",
      "multi-get",
      "implicit-search",
      "index-cleanup",
      "index-collections",
      "index-contexts",
      "doctor",
      "audit",
      "reconcile",
      "linkify",
      "embed",
      "doc",
      "mcp",
      "lint",
      "install",
      "uninstall",
      "update",
      "old-link",
      "old-hook",
      "embedding-default",
      "embedding-descriptor",
      "embedding-no-default",
    ]);
  });

  it("keeps shipped guidance on canonical CLI spellings while preserving history", () => {
    const files = currentGuidanceFiles();
    for (const category of CURRENT_GUIDANCE_SCANNER_CATEGORIES) {
      expect(files.filter((file) => file.category === category), `${category} guidance scan must not be empty`).not.toEqual([]);
    }

    expect(currentGuidanceViolations(files)).toEqual([]);
  });
});

describe("surface-set parity gate (live surface)", () => {
  it("reads the seven disk-authored skills, MCP registry, and CLI dispatcher", () => {
    expect(checkSurfaceSets(liveSurfaceSets(), TARGET)).toEqual([]);
    expect(harnessSurfaceRegistry.hosts, "supported host registry must not be empty").not.toEqual([]);
    for (const host of harnessSurfaceRegistry.hosts) {
      const qualifiedNames = omsMcpTools.map((tool) => `${MCP_SERVER_ID}_${tool.name}`);
      expect(qualifiedNames, `${host.runtime} must not render a doubled OMS namespace`).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^oms_oms_/)]),
      );
    }
  });

  it("fails when a registry CLI command is renamed without updating the dispatcher", () => {
    const live = liveSurfaceSets();
    const original = live.cliCommands[0];
    expect(original).toBeDefined();
    const violations = checkSurfaceSets(
      { ...live, cliCommands: [`${original}-renamed`, ...live.cliCommands.slice(1)] },
      TARGET,
    );
    expect(violations.map((violation) => violation.rule)).toContain("cli-allowlist-matches-dispatcher");
  });

  it("fails closed when the skill directory scan is empty", () => {
    const emptySkillRoot = mkdtempSync(path.join(tmpdir(), "oms-empty-skills-"));
    try {
      expect(() => liveSurfaceSets(emptySkillRoot)).toThrow("assets/skills scan must not be empty");
    } finally {
      rmSync(emptySkillRoot, { recursive: true, force: true });
    }
  });
});
