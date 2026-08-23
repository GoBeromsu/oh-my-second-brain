import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
 * holds the six skills.
 */

const CANONICAL_SKILLS = ["distill", "doctor", "link", "search", "status", "write"] as const;

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
    const entries = await readFile(path.join(target, "SKILL.md"), "utf8").then(() => true);
    return entries;
  } catch {
    return false;
  }
}

describe("packaged vendor discovery", () => {
  it("keeps exactly the six canonical skills in one authored location", async () => {
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
});
