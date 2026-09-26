import * as fsPromises from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
import { computeTreeDigest, parseProvenance } from "../../kernel/install/provenance.js";
import { discoverHostInstallAssets } from "../../cli/host-probe.js";
import { installHermes, isHermesOmsRegistration, namespaceSkillMarkdown, uninstallHermes } from "./hermes.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: vi.fn(actual.cp),
    readdir: vi.fn(actual.readdir),
    writeFile: vi.fn(actual.writeFile),
  };
});

const originalFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const packageVersion = (JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string }).version;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installHermes transaction", () => {
  it("recognizes only the new managed serve mcp launch", () => {
    const registration = (args: string, command = "oms") =>
      `mcp_servers:\n  oms:\n    command: ${command}\n    args: ${args}\n    enabled: true\n`;
    expect(isHermesOmsRegistration(registration("[serve, mcp, --vault, /vault]"))).toBe(true);
    expect(isHermesOmsRegistration(registration("[mcp, --vault, /vault]"))).toBe(false);
    expect(isHermesOmsRegistration(registration("[serve, http, --vault, /vault]"))).toBe(false);
    expect(isHermesOmsRegistration(registration("[serve, mcp, --vault, /vault]", "custom"))).toBe(false);
  });

  it("preserves an unowned custom OMS registration during removal", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-custom-"));
    temporaryDirectories.push(home);
    const config = path.join(home, ".hermes", "config.yaml");
    const custom = "mcp_servers:\n  oms:\n    command: custom-runner\n    args: [keep]\n    enabled: true\n";
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, custom);

    await expect(uninstallHermes({
      action: "uninstall",
      runtime: "hermes",
      vault: "/vault",
      homeDir: home,
    })).resolves.toMatchObject({ changed: false, skipped: true });
    expect(await readFile(config, "utf8")).toBe(custom);
  });

  it("rejects an unsafe config before writing OMS-owned targets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    const original = "mcp_servers: &servers {}\n";
    await mkdir(hermes);
    await writeFile(config, original);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");

    await expect(installHermes({
      action: "install",
      runtime: "hermes",
      vault: "/vault",
      homeDir: home,
      adapterRoot: path.resolve("."),
    }, host)).rejects.toThrow("unsafe YAML edit");

    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"))).rejects.toThrow();
  });

  it.each(["default", "profiles/xia"].flatMap(root => [
    [root, "skills copy", (api: typeof fsPromises) => vi.mocked(api.cp).mockRejectedValueOnce(new Error("skills copy failed"))],
    [root, "adapter copy", (api: typeof fsPromises) => vi.mocked(api.cp).mockImplementation(async (source, destination, options) => {
      if (String(source).endsWith("hermes-manifest.json")) throw new Error("adapter copy failed");
      return await originalCp(source, destination, options);
    })],
    [root, "config atomic write", (api: typeof fsPromises) => {
      const write = vi.mocked(api.writeFile);
      write.mockImplementationOnce(async () => { throw new Error("config write failed"); });
      return write;
    }],
    [root, "install verification", (api: typeof fsPromises) => vi.mocked(api.readdir).mockImplementation(async (directory, options) => {
      if (String(directory).includes("skills/knowledge-management/oms")) throw new Error("verification failed");
      return await originalFs.readdir(directory, options);
    })],
  ]))("%s root restores config and converges after a %s failure", async (root, _name, inject) => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes", ...(root === "default" ? [] : root.split("/")));
    const config = path.join(hermes, "config.yaml");
    const original = "mcp_servers:\n  other: keep\n";
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    const originalOverride = process.env.OMS_HERMES_HOME;
    if (root !== "default") process.env.OMS_HERMES_HOME = hermes;
    try {
      await mkdir(hermes, { recursive: true });
      await writeFile(config, original);
      const restore = inject(fsPromises);
      try {
        await expect(installHermes(options, host)).rejects.toThrow();
        expect(await readFile(config, "utf8")).toBe(original);
      } finally {
        restore.mockRestore();
      }
      await expect(installHermes(options, host)).resolves.toMatchObject({ changed: true });
    } finally {
      if (originalOverride === undefined) delete process.env.OMS_HERMES_HOME;
      else process.env.OMS_HERMES_HOME = originalOverride;
    }
  });

  it("preserves both errors when config rollback fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    await mkdir(hermes);
    await writeFile(config, "mcp_servers:\n  other: keep\n");
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const readdir = vi.mocked(fsPromises.readdir).mockImplementation(async (directory, options) => {
      if (String(directory).includes(".hermes/skills/knowledge-management/oms")) throw new Error("verification failed");
      return await originalFs.readdir(directory, options);
    });
    const write = vi.mocked(fsPromises.writeFile);
    let temporaryWrites = 0;
    write.mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)).startsWith(".config.yaml.oms-") && ++temporaryWrites === 2) {
        throw new Error("rollback write failed");
      }
      return await originalWriteFile(file, data, options);
    });
    try {
      await expect(installHermes({
        action: "install", runtime: "hermes", vault: "/vault", homeDir: home, adapterRoot: path.resolve("."),
      }, host)).rejects.toSatisfy((error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(item => item instanceof Error && item.message === "verification failed") &&
        error.errors.some(item => item instanceof Error && item.message === "rollback write failed"),
      );
    } finally {
      readdir.mockRestore();
      write.mockRestore();
    }
  });

  it("rejects the same disabled registration through installer verification and host probing", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    let mutatedRegistration: string | undefined;
    const write = vi.mocked(fsPromises.writeFile).mockImplementation(async (file, data, options) => {
      await originalWriteFile(file, data, options);
      if (path.basename(String(file)).startsWith(".config.yaml.oms-")) {
        mutatedRegistration = Buffer.from(data).toString("utf8").replace("enabled: true", "enabled: false");
        await originalWriteFile(file, mutatedRegistration);
      }
    });
    const previousHermesHome = process.env.OMS_HERMES_HOME;
    process.env.OMS_HERMES_HOME = hermes;
    try {
      const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
      await expect(installHermes(options, host)).rejects.toThrow("Hermes config verification failed");
      if (mutatedRegistration === undefined) throw new Error("Hermes installer did not render a registration");
      await mkdir(path.join(hermes, "skills", "knowledge-management", "oms"), { recursive: true });
      await originalWriteFile(config, mutatedRegistration);
      const discovered = await discoverHostInstallAssets();
      expect(discovered.assets).toContainEqual(expect.objectContaining({
        id: "registration:hermes",
        evidence: { state: "missing", cause: null },
      }));
    } finally {
      if (previousHermesHome === undefined) delete process.env.OMS_HERMES_HOME;
      else process.env.OMS_HERMES_HOME = previousHermesHome;
      write.mockRestore();
    }
  });

  it("rejects a tampered installed skill tree at Verify and restores the config", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    const original = "mcp_servers:\n  other: keep\n";
    await mkdir(hermes);
    await writeFile(config, original);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const skillTarget = path.join(hermes, "skills", "knowledge-management", "oms");
    const cpMock = vi.mocked(fsPromises.cp).mockImplementation(async (source, destination, options) => {
      await originalCp(source, destination, options);
      if (String(destination) === skillTarget) {
        await originalWriteFile(path.join(skillTarget, "oms-write", "SKILL.md"), "tampered\n");
      }
    });
    try {
      await expect(installHermes({
        action: "install", runtime: "hermes", vault: "/vault", homeDir: home, adapterRoot: path.resolve("."),
      }, host)).rejects.toThrow("installed skill tree does not match");
      expect(await readFile(config, "utf8")).toBe(original);
    } finally {
      cpMock.mockRestore();
    }
  });

  it("verifies uninstall removes the config entry and all owned paths", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    await expect(uninstallHermes({ ...options, action: "uninstall" })).resolves.toMatchObject({ changed: true });
    await expect(readFile(path.join(home, ".hermes", "config.yaml"), "utf8")).resolves.not.toContain("oms:");
    expect(existsSync(path.join(home, ".hermes", "adapters", "oms"))).toBe(false);
    expect(existsSync(path.join(home, ".hermes", "skills", "knowledge-management", "oms"))).toBe(false);
  });

  it("records provenance outside the six-skill layout and makes an identical reinstall a no-op", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenanceFile = path.join(hermes, "adapters", "oms", "oms-provenance.json");
    const provenance = parseProvenance(await readFile(provenanceFile, "utf8"));
    const config = await readFile(path.join(hermes, "config.yaml"), "utf8");
    expect(config).toContain("- serve");
    expect(isHermesOmsRegistration(config)).toBe(true);
    const previousHermesHome = process.env.OMS_HERMES_HOME;
    process.env.OMS_HERMES_HOME = hermes;
    try {
      expect((await discoverHostInstallAssets()).assets).toContainEqual(expect.objectContaining({
        id: "registration:hermes",
        evidence: { state: "ok", cause: null },
      }));
    } finally {
      if (previousHermesHome === undefined) delete process.env.OMS_HERMES_HOME;
      else process.env.OMS_HERMES_HOME = previousHermesHome;
    }
    expect((await readdir(skills)).sort()).toEqual([
      "SKILL_CAPABILITY_GUIDE.md",
      "oms-distill", "oms-doctor", "oms-link", "oms-search", "oms-setup", "oms-status", "oms-write",
    ]);
    const writeSource = await readFile("assets/skills/write/SKILL.md", "utf8");
    expect(writeSource).toMatch(/^---\nname: write\n/);
    expect(await readFile(path.join(skills, "oms-write", "SKILL.md"), "utf8"))
      .toBe(namespaceSkillMarkdown("write", writeSource).markdown);
    for (const skill of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      const staged = await readFile(path.join(skills, `oms-${skill}`, "SKILL.md"), "utf8");
      expect(staged).toMatch(new RegExp(`^---\\r?\\nname: oms-${skill}\\r?\\n`));
      expect(staged).not.toMatch(/`(distill|doctor|link|search|setup|status|write)` skill/);
      expect(staged).not.toMatch(/(^|[\s`(])\/(distill|doctor|link|search|setup|status|write)\b/m);
      expect(staged).not.toMatch(/^# (distill|doctor|link|search|setup|status|write)\b/m);
    }
    const guide = await readFile(path.join(skills, "SKILL_CAPABILITY_GUIDE.md"), "utf8");
    expect(guide).toContain("| `oms-write` | MCP tool `write` on the `oms` server");
    expect(guide).toContain("| `oms-setup` | Agent recipe. Asks the owner every question, then runs the `oms setup` CLI");
    expect(guide).toContain("| `oms-distill` | Agent recipe; no MCP tool or CLI command.");
    expect(provenance).toMatchObject({ source: "npm", version: packageVersion, skillTreeDigest: await computeTreeDigest(skills) });
    const before = await readFile(provenanceFile, "utf8");
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: false, skipped: true });
    expect(await readFile(provenanceFile, "utf8")).toBe(before);
  });

  it("refuses foreign provenance without changing the pre-existing tree", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenance = path.join(hermes, "adapters", "oms", "oms-provenance.json");
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(skills, "foreign.txt"), "foreign\n");
    await mkdir(path.dirname(provenance), { recursive: true });
    await writeFile(provenance, '{"source":"tap"}\n');
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    await expect(installHermes({
      action: "install", runtime: "hermes", vault: "/vault", homeDir: home, adapterRoot: path.resolve("."),
    }, host)).rejects.toThrow("provenance record is not valid npm provenance");
    expect(await readFile(path.join(skills, "foreign.txt"), "utf8")).toBe("foreign\n");
  });

  it("adopts a prior semver legacy layout and replaces its adapter directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenance = path.join(hermes, "adapters", "oms", "oms-provenance.json");
    await rm(provenance);
    await writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), '{"version":"0.10.1"}\n');
    await writeFile(path.join(hermes, "adapters", "oms", ".oms-provenance.json"), "stale metadata\n");
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: true });
    expect(parseProvenance(await readFile(provenance, "utf8"))).not.toBeNull();
    expect(await readdir(path.join(hermes, "adapters", "oms"))).toEqual(["README.md", "SOUL.md", "hermes-manifest.json", "oms-provenance.json"]);
    await rm(provenance);
    await mkdir(path.join(skills, "unexpected"));
    await expect(installHermes(options, host)).rejects.toThrow("exact legacy OMS layout");
  });

  it("adopts the pre-namespace bare-name layout and replaces it with oms- prefixed skills", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    for (const skill of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      await mkdir(path.join(skills, skill), { recursive: true });
      await writeFile(path.join(skills, skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
    }
    await mkdir(path.join(hermes, "adapters", "oms"), { recursive: true });
    await writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), '{"version":"0.10.1"}\n');
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: true });
    expect((await readdir(skills)).filter(entry => !entry.startsWith("oms-"))).toEqual(["SKILL_CAPABILITY_GUIDE.md"]);
  });

  it.each([
    ["a file in place of a bare skill directory", async (skills: string) => {
      await rm(path.join(skills, "write"), { recursive: true });
      await writeFile(path.join(skills, "write"), "not a directory\n");
    }],
    ["a missing bare SKILL.md", async (skills: string) => rm(path.join(skills, "doctor", "SKILL.md"))],
    ["a capability guide beside the bare layout", async (skills: string) => writeFile(path.join(skills, "SKILL_CAPABILITY_GUIDE.md"), "guide\n")],
    ["a mixed bare and prefixed layout", async (skills: string) => {
      await mkdir(path.join(skills, "oms-write"));
      await writeFile(path.join(skills, "oms-write", "SKILL.md"), "---\nname: oms-write\n---\n");
    }],
  ])("rejects bare-layout legacy adoption with %s", async (_name, damage) => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-legacy-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    for (const skill of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      await mkdir(path.join(skills, skill), { recursive: true });
      await writeFile(path.join(skills, skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
    }
    await mkdir(path.join(hermes, "adapters", "oms"), { recursive: true });
    await writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), '{"version":"0.10.1"}\n');
    await damage(skills);
    await expect(installHermes(options, host)).rejects.toThrow("Refusing to replace Hermes OMS assets");
  });

  it("namespaces CRLF and quoted frontmatter and slash and heading references", () => {
    const { markdown, frontmatter } = namespaceSkillMarkdown("setup", '---\r\nname: "setup"\r\ndescription: Seal it\r\n---\r\n# setup\r\n\r\n```\r\n/setup [--reask]\r\n```\r\nFollow `/write`, then run `oms setup` and read 90. Settings/02 Templates.\r\n');
    expect(markdown).toBe('---\r\nname: oms-setup\r\ndescription: Seal it\r\n---\r\n# oms-setup\r\n\r\n```\r\n/oms-setup [--reask]\r\n```\r\nFollow `/oms-write`, then run `oms setup` and read 90. Settings/02 Templates.\r\n');
    expect(frontmatter).toMatchObject({ name: "oms-setup", description: "Seal it" });
    expect(() => namespaceSkillMarkdown("setup", "---\nname: status\n---\n")).toThrow("frontmatter name is not setup");
  });

  it.each([
    ["the current manifest version", async (hermes: string) => writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), `{"version":"${packageVersion}"}\n`)],
    ["a higher manifest version", async (hermes: string) => writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), '{"version":"99.0.0"}\n')],
    ["an invalid semver manifest", async (hermes: string) => writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), '{"version":"legacy"}\n')],
    ["a malformed manifest", async (hermes: string) => writeFile(path.join(hermes, "adapters", "oms", "hermes-manifest.json"), "{not json\n")],
    ["a file in place of a canonical skill directory", async (hermes: string) => {
      const skill = path.join(hermes, "skills", "knowledge-management", "oms", "oms-write");
      await rm(skill, { recursive: true });
      await writeFile(skill, "not a directory\n");
    }],
    ["a missing canonical SKILL.md", async (hermes: string) => rm(path.join(hermes, "skills", "knowledge-management", "oms", "oms-doctor", "SKILL.md"))],
    ["a directory in place of the capability guide", async (hermes: string) => {
      const guide = path.join(hermes, "skills", "knowledge-management", "oms", "SKILL_CAPABILITY_GUIDE.md");
      await rm(guide);
      await mkdir(guide);
    }],
    ["a missing capability guide", async (hermes: string) => rm(path.join(hermes, "skills", "knowledge-management", "oms", "SKILL_CAPABILITY_GUIDE.md"))],
  ])("rejects legacy adoption with %s", async (_name, damage) => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-legacy-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    await rm(path.join(hermes, "adapters", "oms", "oms-provenance.json"));
    await damage(hermes);
    await expect(installHermes(options, host)).rejects.toThrow("Refusing to replace Hermes OMS assets");
  });

  it("refuses uninstall of a tampered npm-owned tree", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const skill = path.join(home, ".hermes", "skills", "knowledge-management", "oms", "oms-write", "SKILL.md");
    await writeFile(skill, "tampered\n");
    await expect(uninstallHermes({ ...options, action: "uninstall" })).rejects.toThrow("not verified OMS npm ownership");
    expect(existsSync(skill)).toBe(true);
  });

  it("rejects a newer valid provenance without changing assets, but permits uninstall", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-newer-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    const provenance = path.join(hermes, "adapters", "oms", "oms-provenance.json");
    const recorded = JSON.parse(await readFile(provenance, "utf8")) as Record<string, unknown>;
    recorded.version = "99.0.0";
    await writeFile(provenance, `${JSON.stringify(recorded)}\n`);
    const configBefore = await readFile(path.join(hermes, "config.yaml"));
    const skillBefore = await readFile(path.join(hermes, "skills", "knowledge-management", "oms", "oms-write", "SKILL.md"));

    await expect(installHermes(options, host)).rejects.toThrow("newer than this package");
    expect(await readFile(path.join(hermes, "config.yaml"))).toEqual(configBefore);
    expect(await readFile(path.join(hermes, "skills", "knowledge-management", "oms", "oms-write", "SKILL.md"))).toEqual(skillBefore);
    await expect(uninstallHermes({ ...options, action: "uninstall" })).resolves.toMatchObject({ changed: true });
  });
});

const originalCp = originalFs.cp;
const originalWriteFile = originalFs.writeFile;
