import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const baseEnv = {
  ...process.env,
  OMS_UPDATE_NOTICE: "0",
  OMS_NO_UPDATE_NOTICE: "1",
};

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-cli-dispatch-"));
  tempRoots.push(vault);
  return vault;
}

function runCli(
  args: readonly string[],
  input?: string,
  env?: Readonly<Record<string, string | undefined>>,
  cwd = repoRoot,
) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before CLI dispatch tests.");
  }
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    input,
    encoding: "utf-8",
  });
}

function jsonObject(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object stdout.");
  }
  return parsed;
}

describe("oms CLI dispatch", () => {
  it("prints usage and exits 0 when no command is provided", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Compatibility alias: oms <command>");
    for (const command of ["setup", "install", "uninstall", "update", "doctor", "lint", "link", "semantic", "mcp", "hook"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("reports unknown hook subcommand with exit code 1", () => {
    const result = runCli(["hook"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[oms] Unknown hook subcommand: (none)");
    expect(result.stderr).toContain("Usage: oms hook <pre-tool-use|post-tool-use> [--vault <path>]");
  });

  it("routes pre-tool-use hook and preserves bypass output", async () => {
    const vault = await makeVault();
    const result = runCli(["hook", "pre-tool-use", "--vault", vault], "{}\n", { OMS_GUARD: "off" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("{\"continue\":true,\"suppressOutput\":true}\n");
  });

  it("rejects unsupported runtime before host operations", () => {
    const result = runCli(["install", "--runtime", "banana", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[oms] Unsupported runtime: banana");
  });

  it("rejects unsupported update option before update runner", () => {
    const result = runCli(["update", "--bogus", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[oms] Unsupported update option: --bogus");
  });

  it("emits doctor and lint JSON for an empty temp vault", async () => {
    const vault = await makeVault();
    const doctor = runCli(["doctor", "--vault", vault, "--json"]);
    const lint = runCli(["lint", "--vault", vault, "--json"]);

    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(jsonObject(doctor.stdout)).toEqual(
      expect.objectContaining({
        totalNotes: 0,
        notesWithViolations: 0,
        totalViolations: 0,
      }),
    );

    expect(lint.status).toBe(0);
    expect(lint.stderr).toBe("");
    expect(jsonObject(lint.stdout)).toEqual(
      expect.objectContaining({
        totalNotes: 0,
        brokenLinks: [],
        orphanPaths: [],
      }),
    );
  });

  it("supports semantic status as both nested command and top-level alias", async () => {
    const vault = await makeVault();
    const nested = runCli(["semantic", "status", "--vault", vault]);
    const alias = runCli(["status", "--vault", vault]);

    expect(nested.status).toBe(0);
    expect(alias.status).toBe(0);
    expect(jsonObject(nested.stdout)).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));
    expect(jsonObject(alias.stdout)).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));
  });

  it("creates a vault bridge and resolves doctor through it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-cli-link-"));
    tempRoots.push(root);
    const vault = path.join(root, "vault");
    const repo = path.join(root, "repo");
    await mkdir(path.join(vault, "notes"), { recursive: true });
    await mkdir(repo, { recursive: true });

    const setup = runCli(["setup", "--vault", vault, "--yes"]);
    expect(setup.status).toBe(0);

    const link = runCli(["link", "--vault", vault, "--folder", "notes"], undefined, undefined, repo);
    expect(link.status).toBe(0);
    expect(link.stderr).toBe("");
    expect(link.stdout).toContain("Oh My Second Brain vault bridge ready.");

    const linkPath = path.join(repo, ".oms", "linked", "notes");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(path.join(vault, "notes"));
    expect(await readFile(path.join(repo, ".gitignore"), "utf-8")).toContain(".oms/linked/");

    const doctor = runCli(["doctor"], undefined, undefined, repo);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain(`Vault: ${vault}`);
  });
});
