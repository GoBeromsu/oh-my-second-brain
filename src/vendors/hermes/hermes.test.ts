import * as fsPromises from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessSurfaceRegistry } from "../../kernel/harness/surface-registry.js";
import { computeTreeDigest, parseProvenance } from "../../kernel/install/provenance.js";
import { installHermes, uninstallHermes } from "./hermes.js";

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
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installHermes transaction", () => {
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

  it.each([
    ["skills copy", (api: typeof fsPromises) => vi.mocked(api.cp).mockRejectedValueOnce(new Error("skills copy failed"))],
    ["adapter copy", (api: typeof fsPromises) => vi.mocked(api.cp).mockImplementation(async (source, destination, options) => {
      if (String(source).endsWith("hermes-manifest.json")) throw new Error("adapter copy failed");
      return await originalCp(source, destination, options);
    })],
    ["config atomic write", (api: typeof fsPromises) => {
      const write = vi.mocked(api.writeFile);
      write.mockImplementationOnce(async () => { throw new Error("config write failed"); });
      return write;
    }],
    ["install verification", (api: typeof fsPromises) => vi.mocked(api.readdir).mockImplementation(async (directory, options) => {
      if (String(directory).includes(".hermes/skills/knowledge-management/oms")) throw new Error("verification failed");
      return await originalFs.readdir(directory, options);
    })],
  ])("restores config and converges after a %s failure", async (_name, inject) => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const config = path.join(hermes, "config.yaml");
    const original = "mcp_servers:\n  other: keep\n";
    await mkdir(hermes);
    await writeFile(config, original);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    const restore = inject(fsPromises);
    try {
      await expect(installHermes(options, host)).rejects.toThrow();
      expect(await readFile(config, "utf8")).toBe(original);
    } finally {
      restore.mockRestore();
    }
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: true });
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
        await originalWriteFile(path.join(skillTarget, "write", "SKILL.md"), "tampered\n");
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

  it("records provenance outside the seven-skill layout and makes an identical reinstall a no-op", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenanceFile = path.join(hermes, "adapters", "oms", ".oms-provenance.json");
    const provenance = parseProvenance(await readFile(provenanceFile, "utf8"));
    expect(await readdir(skills)).toHaveLength(7);
    expect(provenance).toMatchObject({ source: "npm", version: "0.10.1", treeDigest: await computeTreeDigest(skills) });
    const before = await readFile(provenanceFile, "utf8");
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: false, skipped: true });
    expect(await readFile(provenanceFile, "utf8")).toBe(before);
  });

  it("refuses foreign provenance without changing the pre-existing tree", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenance = path.join(hermes, "adapters", "oms", ".oms-provenance.json");
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(skills, "foreign.txt"), "foreign\n");
    await mkdir(path.dirname(provenance), { recursive: true });
    await writeFile(provenance, '{"source":"tap"}\n');
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    await expect(installHermes({
      action: "install", runtime: "hermes", vault: "/vault", homeDir: home, adapterRoot: path.resolve("."),
    }, host)).rejects.toThrow("not valid npm provenance");
    expect(await readFile(path.join(skills, "foreign.txt"), "utf8")).toBe("foreign\n");
  });

  it("adopts only the exact legacy seven-skill layout", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const hermes = path.join(home, ".hermes");
    const skills = path.join(hermes, "skills", "knowledge-management", "oms");
    const provenance = path.join(hermes, "adapters", "oms", ".oms-provenance.json");
    await rm(provenance);
    await writeFile(path.join(skills, "write", "SKILL.md"), "legacy\n");
    await expect(installHermes(options, host)).resolves.toMatchObject({ changed: true });
    expect(parseProvenance(await readFile(provenance, "utf8"))).not.toBeNull();
    await rm(provenance);
    await mkdir(path.join(skills, "unexpected"));
    await expect(installHermes(options, host)).rejects.toThrow("exact legacy OMS layout");
  });

  it("refuses uninstall of a tampered npm-owned tree", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oms-hermes-"));
    temporaryDirectories.push(home);
    const host = harnessSurfaceRegistry.hosts.find((candidate) => candidate.runtime === "hermes");
    if (!host) throw new Error("Hermes surface missing");
    const options = { action: "install" as const, runtime: "hermes" as const, vault: "/vault", homeDir: home, adapterRoot: path.resolve(".") };
    await installHermes(options, host);
    const skill = path.join(home, ".hermes", "skills", "knowledge-management", "oms", "write", "SKILL.md");
    await writeFile(skill, "tampered\n");
    await expect(uninstallHermes({ ...options, action: "uninstall" })).rejects.toThrow("not verified OMS npm ownership");
    expect(existsSync(skill)).toBe(true);
  });
});

const originalCp = originalFs.cp;
const originalWriteFile = originalFs.writeFile;
