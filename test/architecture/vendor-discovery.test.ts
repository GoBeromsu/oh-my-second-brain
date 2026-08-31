import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { absolute, pathExists, readJson } from "./repo-root.js";

/**
 * Packaged vendor discovery.
 *
 * This is the plan's least-verified mechanism and the gate that must pass
 * BEFORE any adapter skill copy is deleted. ouroboros proves the in-root
 * `"skills": "./skills/"` arrangement, but it does so from its own repo root;
 * ours must resolve `./assets/skills/` the same way from the same position.
 *
 * Every case resolves a manifest's declared skill path relative to the manifest
 * root and checks the real filesystem. A manifest that merely contains the right
 * string is not evidence: the string has to point at a directory that exists and
 * holds the seven skills.
 */

const CANONICAL_SKILLS = ["distill", "doctor", "link", "search", "status", "template", "write"] as const;

interface ClaudeManifest {
  readonly name: string;
  readonly skills: readonly string[];
  readonly mcpServers: string;
}

interface CodexManifest {
  readonly name: string;
  readonly skills: string;
  readonly mcpServers: string;
}

const temporaries: string[] = [];
const SKILL_FRONTMATTER_KEYS = ["name", "description", "aliases", "mcp_tool", "mcp_args"] as const;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oms-discovery-"));
  temporaries.push(dir);
  return dir;
}

/**
 * Resolve a manifest-declared skill reference against its manifest root, the
 * way a host loader does, and report whether it lands on a real directory.
 */
async function resolvesToDirectory(manifestRoot: string, declared: string): Promise<boolean> {
  const target = path.resolve(manifestRoot, declared);
  // A host will not follow a reference that climbs out of its own plugin root.
  const relative = path.relative(manifestRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    return hasValidSkillFrontmatter(await readFile(path.join(target, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

function hasValidSkillFrontmatter(document: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (match === null) return false;
  try {
    const frontmatter = parse(match[1]);
    return typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter);
  } catch {
    return false;
  }
}

async function hermesHasInstallableSkills(root: string): Promise<boolean> {
  if (!await pathExists(path.join(root, "assets", "hermes-manifest.json"))) return false;
  try {
    const entries = await readdir(path.join(root, "assets", "skills"), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

interface NpmPackReport {
  readonly files: readonly { readonly path: string }[];
}

async function packedFiles(root: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout) as readonly NpmPackReport[];
  const files = report[0]?.files.map((file) => file.path).sort();
  expect(files, "npm pack --dry-run must report packed files").toBeDefined();
  expect(files).not.toEqual([]);
  return files!;
}

describe("packaged vendor discovery", () => {
  it("keeps exactly the seven canonical skills in one authored location", async () => {
    for (const skill of CANONICAL_SKILLS) {
      await expect(pathExists(`assets/skills/${skill}/SKILL.md`), skill).resolves.toBe(true);
    }
  });

  it("resolves every Claude manifest skill entry to a real skill inside the plugin root", async () => {
    const manifest = await readJson<ClaudeManifest>(".claude-plugin/plugin.json");
    const root = absolute(".");

    expect(manifest.skills.length).toBe(CANONICAL_SKILLS.length);
    for (const declared of manifest.skills) {
      await expect(resolvesToDirectory(root, declared), declared).resolves.toBe(true);
    }
  });

  it("resolves the Codex manifest skill directory to the shared tree", async () => {
    const manifest = await readJson<CodexManifest>(".codex-plugin/plugin.json");
    const root = absolute(".");
    const target = path.resolve(root, manifest.skills);

    expect(path.relative(root, target).startsWith("..")).toBe(false);
    for (const skill of CANONICAL_SKILLS) {
      await expect(
        readFile(path.join(target, skill, "SKILL.md"), "utf8").then(() => true),
        skill,
      ).resolves.toBe(true);
    }
  });

  it("points both host MCP configs at a file that exists", async () => {
    const claude = await readJson<ClaudeManifest>(".claude-plugin/plugin.json");
    const codex = await readJson<CodexManifest>(".codex-plugin/plugin.json");

    for (const [host, pointer] of [
      ["claude", claude.mcpServers],
      ["codex", codex.mcpServers],
    ] as const) {
      const resolved = path.relative(absolute("."), path.resolve(absolute("."), pointer));
      await expect(pathExists(resolved), `${host} -> ${pointer}`).resolves.toBe(true);
    }
  });

  it("gives Claude and Codex distinct MCP configs so the root move cannot collide them", async () => {
    const claude = await readJson<ClaudeManifest>(".claude-plugin/plugin.json");
    const codex = await readJson<CodexManifest>(".codex-plugin/plugin.json");
    expect(claude.mcpServers).not.toBe(codex.mcpServers);
  });

  it("keeps the Hermes manifest free of a skills pointer, since Hermes installs from the shared source", async () => {
    const manifest = await readJson<Record<string, unknown>>("assets/hermes-manifest.json");
    expect(manifest.skills).toBeUndefined();
    expect(typeof manifest.name).toBe("string");
  });

  it("parses every live skill frontmatter with its allowed surface", async () => {
    let mcpSkillCount = 0;
    for (const skill of CANONICAL_SKILLS) {
      const document = await readFile(absolute(`assets/skills/${skill}/SKILL.md`), "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
      expect(match, skill).not.toBeNull();
      const frontmatter = parse(match![1]) as Record<string, unknown>;

      expect(frontmatter.name, `${skill}.name`).toBe(skill);
      expect(typeof frontmatter.description, `${skill}.description`).toBe("string");
      expect(frontmatter.description, `${skill}.description`).not.toHaveLength(0);
      expect(Object.keys(frontmatter).every((key) => (SKILL_FRONTMATTER_KEYS as readonly string[]).includes(key)), skill).toBe(true);
      if (skill === "distill" || skill === "template") {
        expect(frontmatter.mcp_tool).toBeUndefined();
        expect(frontmatter.mcp_args).toBeUndefined();
      } else {
        mcpSkillCount += 1;
        expect(typeof frontmatter.mcp_tool, `${skill}.mcp_tool`).toBe("string");
        expect(frontmatter.mcp_args, `${skill}.mcp_args`).toBeDefined();
      }
    }
    expect(mcpSkillCount).toBe(5);
  });

  // Manifest completeness. A host silently drops a plugin whose metadata is
  // blank, so emptiness has to be rejected explicitly rather than assumed.
  it.each([".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "assets/hermes-manifest.json"])(
    "%s declares non-empty name, version and description",
    async (manifestPath) => {
      const manifest = await readJson<Record<string, unknown>>(manifestPath);
      for (const field of ["name", "version", "description"] as const) {
        expect(typeof manifest[field], `${manifestPath}.${field}`).toBe("string");
        expect((manifest[field] as string).length, `${manifestPath}.${field}`).toBeGreaterThan(0);
      }
    },
  );

  it("ships the Codex native rule and both host MCP descriptors", async () => {
    await expect(pathExists("assets/codex/rules/oms.md")).resolves.toBe(true);
    await expect(pathExists(".mcp.json")).resolves.toBe(true);
    await expect(pathExists(".mcp.codex.json")).resolves.toBe(true);
  });

  it("ships both Claude hook binaries that package.json bin points at", async () => {
    const pkg = await readJson<{ bin: Record<string, string> }>("package.json");
    for (const [name, target] of Object.entries(pkg.bin)) {
      await expect(pathExists(target), `${name} -> ${target}`).resolves.toBe(true);
    }
  });

  it("includes every canonical skill in the npm package, not only the working tree", async () => {
    const files = await packedFiles(absolute("."));
    for (const skill of CANONICAL_SKILLS) {
      expect(files).toContain(`assets/skills/${skill}/SKILL.md`);
    }
  });

  // Negative cases. Each names a concrete bad input the gate must reject, so a
  // green result cannot mean "the check did nothing".

  it("rejects a Claude manifest entry that dangles", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "assets", "skills", "write"), { recursive: true });
    await writeFile(path.join(root, "assets", "skills", "write", "SKILL.md"), "---\nname: write\n---\n");

    await expect(resolvesToDirectory(root, "./assets/skills/write/")).resolves.toBe(true);
    await expect(resolvesToDirectory(root, "./assets/skills/ghost/")).resolves.toBe(false);
  });

  it("rejects a skill directory with no SKILL.md", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "assets", "skills", "hollow"), { recursive: true });
    await expect(resolvesToDirectory(root, "./assets/skills/hollow/")).resolves.toBe(false);
  });

  it("rejects a Codex skill whose SKILL.md has no YAML frontmatter", async () => {
    const root = await scratch();
    const skill = path.join(root, "assets", "skills", "write");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# write\n");

    await expect(resolvesToDirectory(root, "./assets/skills/write/")).resolves.toBe(false);
  });

  it("rejects a manifest reference that escapes the plugin root", async () => {
    const root = await scratch();
    const outside = path.join(root, "outside", "skills", "write");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "---\nname: write\n---\n");
    const pluginRoot = path.join(root, "plugin");
    await mkdir(pluginRoot, { recursive: true });

    // This is exactly the arrangement the repo-root move exists to avoid: a
    // vendor-directory plugin root reaching back out to a shared tree.
    await expect(resolvesToDirectory(pluginRoot, "../outside/skills/write/")).resolves.toBe(false);
  });

  it("rejects a Hermes manifest with an empty shared assets/skills source", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "assets", "skills"), { recursive: true });
    await writeFile(path.join(root, "assets", "hermes-manifest.json"), '{"name":"oms"}\n');

    await expect(hermesHasInstallableSkills(root)).resolves.toBe(false);
  });

  it("rejects package.json files that omit assets even when skills exist in the working tree", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "assets", "skills", "write"), { recursive: true });
    await writeFile(path.join(root, "assets", "skills", "write", "SKILL.md"), "---\nname: write\n---\n");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "index.js"), "export {};\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "oms-pack-evasion", version: "1.0.0", files: ["dist"] }),
    );

    await expect(readFile(path.join(root, "assets", "skills", "write", "SKILL.md"), "utf8")).resolves.toContain("name: write");
    expect(await packedFiles(root)).not.toContain("assets/skills/write/SKILL.md");
  });
});
