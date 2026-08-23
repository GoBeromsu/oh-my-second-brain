import { describe, expect, it } from "vitest";
import { harnessSurfaceRegistry } from "../../src/harness/surface-registry.js";

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
  /** Skills that declare an `mcp_tool` in their frontmatter. */
  readonly skillsWithTool: readonly string[];
  readonly mcpTools: readonly string[];
  readonly cliCommands: readonly string[];
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

  for (const tool of sets.mcpTools) {
    if (!withTool.has(tool)) {
      violations.push({
        rule: "tools-subset-of-skills",
        detail: `MCP tool ${tool} has no skill declaring it via mcp_tool`,
      });
    }
  }

  if (sets.mcpTools.length !== withTool.size) {
    violations.push({
      rule: "tool-count-matches-declarations",
      detail: `${sets.mcpTools.length} MCP tools registered but ${withTool.size} skills declare mcp_tool`,
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

  if (sets.cliCommands.length === 0) {
    violations.push({ rule: "cli-allowlist-populated", detail: "CLI command allowlist is empty" });
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
      { ...CLEAN, skillsWithTool: [...CLEAN.skillsWithTool, "distill"] },
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

describe("surface-set parity gate (live registry, pre-cutover)", () => {
  it("reads a populated CLI allowlist from the registry", () => {
    expect(harnessSurfaceRegistry.cliCommands.length).toBeGreaterThan(0);
  });

  it("declares CLI commands that are not skills, proving the sets are independent", () => {
    const cliNames = harnessSurfaceRegistry.cliCommands.map((command) => command.name);
    const coreSkills = new Set(harnessSurfaceRegistry.coreSkillDirs);
    const cliOnly = cliNames.filter((name) => !coreSkills.has(name));
    expect(cliOnly.length).toBeGreaterThan(0);
  });

  it("declares a non-empty MCP tool surface", () => {
    expect(harnessSurfaceRegistry.mcpTools.length).toBeGreaterThan(0);
  });
});
