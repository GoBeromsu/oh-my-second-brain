import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `oms setup` end to end, against the built CLI.
 *
 * Setup is the interactive seal (same as `oms contract setup`). The retired
 * approval-token flags are refused with the command that owns each concern,
 * and a non-terminal invocation is refused. None of these paths write to the
 * vault or to the (temporary) home store. The interview itself is exercised
 * in-process by contract-command.test.ts with scripted IO.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly home: string; readonly vault: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-setup-e2e-"));
  roots.push(root);
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  await mkdir(home);
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "alpha.md"), "---\ntitle: Alpha\n---\n# Alpha\n");
  return { home, vault };
}

function runCli(home: string, args: readonly string[]) {
  if (!existsSync(distCli)) throw new Error("dist/cli/oms.js is missing; run npm run build before setup CLI tests.");
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      OMS_NO_UPDATE_NOTICE: "1",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OMS_RUNTIME_ROOT: path.join(home, ".oms", "runtime", "v1"),
    },
  });
}

async function listing(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).sort();
}

const RETIRED: readonly (readonly [string, RegExp])[] = [
  ["--dry-run", /no dry-run/],
  ["--yes", /no approval flags/],
  ["--approval-token", /no approval flags/],
  ["--approved-digest", /no approval flags/],
  ["--install-claude", /oms host install/],
  ["--models-default", /oms model install --default/],
  ["--models-descriptor", /oms model install --descriptor/],
  ["--models-no-default", /oms model waive --yes/],
  ["--template-folder", /setup interview/],
];

describe("oms setup end to end", () => {
  it("prints usage naming the contract setup alias", async () => {
    const { home } = await fixture();
    const result = runCli(home, ["setup", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: oms setup [--vault <path>]");
    expect(result.stdout).toContain("oms contract setup");
  });

  it("refuses every retired approval-token flag with its owning command and writes nothing", async () => {
    const { home, vault } = await fixture();
    const before = await listing(vault);
    for (const [flag, guidance] of RETIRED) {
      const result = runCli(home, ["setup", "--vault", vault, flag]);
      expect(result.status, flag).toBe(1);
      expect(result.stderr, flag).toContain(`setup option ${flag} was removed.`);
      expect(result.stderr, flag).toMatch(guidance);
    }
    expect(await listing(vault)).toEqual(before);
    expect(existsSync(path.join(home, ".oms", "vaults"))).toBe(false);
  });

  it("refuses a non-terminal setup through both spellings without sealing or issuing settings", async () => {
    const { home, vault } = await fixture();
    const before = await listing(vault);
    for (const args of [["setup", "--vault", vault], ["contract", "setup", "--vault", vault]]) {
      const result = runCli(home, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("needs an interactive terminal");
    }
    expect(await listing(vault)).toEqual(before);
    expect(existsSync(path.join(vault, ".oms"))).toBe(false);
    expect(existsSync(path.join(home, ".oms", "vaults"))).toBe(false);
    expect(await readFile(path.join(vault, "notes", "alpha.md"), "utf8")).toBe("---\ntitle: Alpha\n---\n# Alpha\n");
  });
});
