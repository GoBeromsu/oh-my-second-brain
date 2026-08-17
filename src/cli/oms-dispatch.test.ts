import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    for (const command of ["setup", "install", "uninstall", "update", "doctor", "audit", "lint", "link", "semantic", "mcp", "hook"]) {
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

  it("emits audit JSON and exits 0 for a clean fixture folder", () => {
    const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
    const audit = runCli(["audit", "--vault", fixtureVault, "--folder", "references", "--json"]);

    expect(audit.status).toBe(0);
    expect(audit.stderr).toBe("");
    expect(jsonObject(audit.stdout)).toEqual(
      expect.objectContaining({
        folder: "references",
        scannedNotes: 1,
        excludedNotes: 0,
        clean: true,
        violations: [],
      }),
    );
  });

  it("G002-CLI-001 rejects audit folder scopes that are not top-level folders", () => {
    const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
    const audit = runCli(["audit", "--vault", fixtureVault, "--folder", "references/missing", "--json"]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toBe("");
    expect(audit.stderr).toContain("path separators");
  });

  it("reports incomplete local .oms during audit instead of falling back to bundled defaults", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".oms", "concepts"), { recursive: true });

    const audit = runCli(["audit", "--vault", vault, "--json"]);

    expect(audit.status).toBe(1);
    expect(audit.stdout).toBe("");
    expect(audit.stderr).toContain("Local .oms ontology is incomplete");
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
    await writeFile(
      path.join(vault, "notes", "Alpha.md"),
      "# Alpha\n\nAlpha bridge lexical search should work immediately after link.\n",
      "utf-8",
    );

    const setup = runCli(["setup", "--vault", vault, "--yes"]);
    expect(setup.status).toBe(0);

    const link = runCli(["link", "--vault", vault, "--folder", "notes"], undefined, undefined, repo);
    expect(link.status).toBe(0);
    expect(link.stderr).toBe("");
    expect(link.stdout).toContain("Oh My Second Brain vault bridge ready.");
    expect(link.stdout).toContain("Convention: wrote");

    const linkPath = path.join(repo, ".oms", "linked", "notes");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), await readlink(linkPath))).toBe(path.join(vault, "notes"));
    expect(await readFile(path.join(repo, ".gitignore"), "utf-8")).toContain(".oms/linked/");
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- oms:begin -->");
    expect(agents).toContain(`- Connected vault: ${path.basename(vault)}`);
    expect(agents).not.toContain(vault);
    expect(agents).toContain("`oms query \"what context should I know for this change?\"`");
    expect(agents).toContain("`oms mcp`");

    const doctor = runCli(["doctor"], undefined, undefined, repo);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain(`Vault: ${vault}`);
    const search = runCli(["search", "--lex", "Alpha"], undefined, undefined, repo);
    expect(search.status).toBe(0);
    expect(search.stderr).toBe("");
    const searchJson = jsonObject(search.stdout);
    expect(searchJson).toEqual(expect.objectContaining({ available: true }));
    expect(searchJson.hits).toEqual([
      expect.objectContaining({ path: "notes/Alpha.md" }),
    ]);
  });

  it("routes update-reconcile dry-run through the scoped Claude cleanup plan", async () => {
    const vault = await makeVault();
    const result = runCli(["update-reconcile", "--runtime", "claude", "--vault", vault, "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("claude mcp remove oms --scope local");
    expect(result.stdout).toContain("claude mcp remove oms --scope project");
    expect(result.stdout).toContain("claude mcp remove oms --scope user");
  });

  it("returns stable cleanup fields for host JSON output", async () => {
    const vault = await makeVault();
    const result = runCli(["install", "--runtime", "claude", "--vault", vault, "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = jsonObject(result.stdout) as {
      dryRun: boolean;
      results: Array<{ cleanup: unknown[]; messages: string[] }>;
    };
    expect(output.dryRun).toBe(true);
    expect(output.results[0]?.cleanup).toEqual([]);
    expect(output.results[0]?.messages.join(" ")).toContain("scope local");
  });
});
