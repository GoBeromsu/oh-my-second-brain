import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const tempRoots: string[] = [];

function runCli(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before update e2e tests.");
  }
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd,
    env: {
      ...process.env,
      OMS_UPDATE_NOTICE: "0",
      OMS_NO_UPDATE_NOTICE: "1",
      OMS_UPDATE_LATEST_VERSION: "99.0.0",
      ...env,
    },
    encoding: "utf-8",
  });
}

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("oms update isolated e2e", () => {
  it("refuses a non-TTY update without --yes and leaves the cwd untouched", () => {
    const cwd = makeTempRoot("oms-update-non-tty-");
    const result = runCli(["update", "--runtime", "codex", "--vault", cwd], cwd);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("stdin is not a TTY");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("keeps --dry-run non-mutating while showing both update commands", () => {
    const cwd = makeTempRoot("oms-update-dry-run-");
    const result = runCli(["update", "--runtime", "codex", "--vault", cwd, "--dry-run"], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm install -g oh-my-second-brain@latest");
    expect(result.stdout).toContain("update-reconcile --runtime codex");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("resolves an OMS_VAULT target before building the reconciliation plan", () => {
    const cwd = makeTempRoot("oms-update-env-cwd-");
    const target = makeTempRoot("oms-update-env-target-");
    const result = runCli(["update", "--runtime", "codex", "--dry-run"], cwd, {
      OMS_VAULT: target,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`--vault ${target}`);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("rejects an inferred cwd target instead of writing to an unverified directory", () => {
    const cwd = makeTempRoot("oms-update-cwd-reject-");
    const omsDir = path.join(cwd, ".oms");
    mkdirSync(omsDir);
    writeFileSync(path.join(omsDir, "user-owned.txt"), "must remain unchanged\n", "utf-8");
    const before = readFileSync(path.join(omsDir, "user-owned.txt"), "utf-8");

    const result = runCli(["update", "--runtime", "codex"], cwd, {
      HOME: makeTempRoot("oms-update-home-"),
      OMS_VAULT: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified vault target");
    expect(readFileSync(path.join(omsDir, "user-owned.txt"), "utf-8")).toBe(before);
  });

  it("propagates reconcile failure to the parent update exit code", () => {
    const cwd = makeTempRoot("oms-update-reconcile-fail-");
    const omsDir = path.join(cwd, ".oms");
    const home = makeTempRoot("oms-update-reconcile-home-");
    const fakeBin = path.join(home, "bin");
    const fakeNpm = path.join(fakeBin, "npm");
    const decoy = path.join(home, "decoy");
    const symlinkTarget = path.join(home, ".hermes", "skills", "knowledge-management", "oms");
    mkdirSync(omsDir);
    writeFileSync(path.join(omsDir, "user-owned.txt"), "must remain unchanged\n", "utf-8");
    const beforeOmsHash = createHash("sha256")
      .update(readFileSync(path.join(omsDir, "user-owned.txt")))
      .digest("hex");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeNpm, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(fakeNpm, 0o755);
    mkdirSync(decoy);
    mkdirSync(path.dirname(symlinkTarget), { recursive: true });
    symlinkSync(decoy, symlinkTarget, "dir");

    const result = runCli(["update", "--runtime", "hermes", "--vault", cwd, "--yes"], cwd, {
      HOME: home,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      OMS_HERMES_HOME: path.join(home, ".hermes"),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("reconciliation failed");
    expect(result.stdout).toContain("Refusing to replace symlinked");
    const afterOmsHash = createHash("sha256")
      .update(readFileSync(path.join(omsDir, "user-owned.txt")))
      .digest("hex");
    expect(afterOmsHash).toBe(beforeOmsHash);
  });
});
