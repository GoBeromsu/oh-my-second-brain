import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNote } from "../../src/kernel/conventions/frontmatter.js";
import { harnessSurfaceRegistry } from "../../src/kernel/harness/surface-registry.js";

/**
 * Surface-set parity gate, Phase A.
 *
 * Phase A proves the *rules* reject concrete bad inputs, using fixtures. The
 * live target set (6 skills / 5 tools) is switched on in the canonical-skill
 * cutover PR; asserting it here would fail on `main` from the moment this gate
 * lands, because the registry still declares the pre-migration surface.
 *
 * The rule set is deliberately NOT "all three lists are equal". The three
 * surfaces are related but distinct:
 *
 *   skills      - the authored skill set
 *   mcpTools    - a strict SUBSET of skills, namely those declaring `mcp_tool`
 *   cliCommands - an INDEPENDENT allowlist; `mcp`, `setup`, `install`,
 *                 `update`, `update-reconcile`, `audit`, `lint` and `hook` are
 *                 real CLI commands that are not skills and must never be
 *                 deleted to force literal equality.
 *
 * Enforcing equality across all three would let a contributor satisfy the gate
 * by silently deleting CLI-only commands. That is the failure this shape exists
 * to prevent.
 */

interface SurfaceSets {
  readonly skills: readonly string[];
  /** Skill directories whose frontmatter declares an MCP tool. */
  readonly skillsWithTool: readonly string[];
  /** MCP tool names declared by skill frontmatter. */
  readonly declaredMcpTools: readonly string[];
  readonly mcpTools: readonly string[];
  readonly cliCommands: readonly string[];
  /** Commands accepted by the CLI dispatcher. */
  readonly dispatcherCliCommands: readonly string[];
}

export interface ParityViolation {
  readonly rule: string;
  readonly detail: string;
}

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

  if (sets.cliCommands.length === 0) {
    violations.push({ rule: "cli-allowlist-populated", detail: "CLI command allowlist is empty" });
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

const TARGET = { skills: 6, tools: 5 } as const;

const CLEAN: SurfaceSets = {
  skills: ["write", "search", "link", "distill", "status", "doctor"],
  skillsWithTool: ["write", "search", "link", "status", "doctor"],
  // Within Phase A, a tool is identified by its declaring skill; the `oms_`
  // naming convention is verified separately by the registry parity suite.
  mcpTools: ["write", "search", "link", "status", "doctor"],
  cliCommands: ["mcp", "setup", "install", "update", "audit", "lint", "hook"],
  declaredMcpTools: ["write", "search", "link", "status", "doctor"],
  dispatcherCliCommands: ["mcp", "setup", "install", "update", "audit", "lint", "hook"],
};

describe("surface-set parity gate (phase A rules)", () => {
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
    // This is the anti-regression case: deleting CLI-only commands to force
    // literal equality must not be a way to satisfy the gate.
    const violations = checkSurfaceSets(CLEAN, TARGET);
    expect(violations).toEqual([]);
    expect(CLEAN.cliCommands).toContain("mcp");
    expect(CLEAN.skills).not.toContain("mcp");
  });

  it("fails when the CLI allowlist is emptied", () => {
    const violations = checkSurfaceSets(
      { ...CLEAN, cliCommands: [] },
      TARGET,
    );
    expect(violations.map((v) => v.rule)).toContain("cli-allowlist-populated");
  });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowedSkillFrontmatterKeys = new Set(["name", "description", "aliases", "mcp_tool", "mcp_args"]);

function realDispatcherCommands(): string[] {
  const omsSource = readFileSync(path.join(repoRoot, "src/cli/oms.ts"), "utf-8");
  const semanticSource = readFileSync(path.join(repoRoot, "src/cli/semantic.ts"), "utf-8");
  const directCommands = [...omsSource.matchAll(/\bcommand === "([^"]+)"/g)].map((match) => match[1]!);
  const semanticCommands = semanticSource.match(/const TOP_LEVEL_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  expect(semanticCommands, "semantic dispatcher command set must be statically declared").not.toBeNull();
  const semantic = [...semanticCommands![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  return [...new Set([...directCommands, ...semantic])].sort();
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

  const cliCommands = harnessSurfaceRegistry.cliCommands.map((command) => command.name).sort();
  return {
    skills: skillDirs,
    skillsWithTool: skillsWithTool.map(({ skill }) => skill),
    declaredMcpTools,
    mcpTools,
    cliCommands,
    dispatcherCliCommands: realDispatcherCommands(),
  };
}

describe("surface-set parity gate (live surface)", () => {
  it("reads the six disk-authored skills, MCP registry, and CLI dispatcher", () => {
    expect(checkSurfaceSets(liveSurfaceSets(), TARGET)).toEqual([]);
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
