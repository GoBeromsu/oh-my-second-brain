import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  cli = distCli,
) {
  if (!existsSync(cli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before update e2e tests.");
  }
  return spawnSync(process.execPath, [cli, ...args], {
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

function makeInstalledCli(prefix: string): string {
  const packageRoot = path.join(prefix, "lib", "node_modules", "oh-my-second-brain");
  mkdirSync(packageRoot, { recursive: true });
  cpSync(path.join(repoRoot, "dist"), path.join(packageRoot, "dist"), { recursive: true });
  cpSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  return path.join(packageRoot, "dist", "cli", "oms.js");
}

function installFakeNpm(bin: string, prefix: string, installError: string, hostMarker: string): void {
  mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
  printf '%s\\n' "${prefix}"
  exit 0
fi
printf '%s\\n' "${installError}" >&2
exit 23
`, "utf-8");
  chmodSync(npm, 0o755);
  const packageBin = path.join(prefix, "bin");
  mkdirSync(packageBin, { recursive: true });
  const oms = path.join(packageBin, "oms");
  writeFileSync(oms, `#!/bin/sh
touch "${hostMarker}"
exit 0
`, "utf-8");
  chmodSync(oms, 0o755);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("oms package update isolated e2e", () => {
  it("refuses a non-TTY update without --yes and leaves the cwd untouched", () => {
    const cwd = makeTempRoot("oms-update-non-tty-");
    const home = makeTempRoot("oms-update-home-");
    const result = runCli(["package", "update"], cwd, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("stdin is not a TTY");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("keeps --dry-run non-mutating while separating package install from host sync", () => {
    const cwd = makeTempRoot("oms-update-dry-run-");
    const home = makeTempRoot("oms-update-home-");
    const result = runCli(["package", "update", "--dry-run"], cwd, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm install -g oh-my-second-brain@latest");
    expect(result.stdout).toContain("oms host sync");
    expect(result.stdout).not.toContain("reconcile");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("checks for package updates without requiring a host pointer or changing the vault", () => {
    const cwd = makeTempRoot("oms-update-check-cwd-");
    const home = makeTempRoot("oms-update-home-");
    const omsDir = path.join(cwd, ".oms");
    mkdirSync(omsDir);
    const owned = path.join(omsDir, "user-owned.txt");
    writeFileSync(owned, "must remain unchanged\n", "utf-8");
    const before = readFileSync(owned, "utf-8");

    const result = runCli(["package", "check"], cwd, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Update available");
    expect(result.stdout).not.toContain("host vault pointer");
    expect(readFileSync(owned, "utf-8")).toBe(before);
  });

  it("rejects a source-tree binary before npm can mutate a package or host integration", () => {
    const cwd = makeTempRoot("oms-update-source-tree-");
    const home = makeTempRoot("oms-update-home-");
    const omsDir = path.join(cwd, ".oms");
    mkdirSync(omsDir);
    const owned = path.join(omsDir, "user-owned.txt");
    writeFileSync(owned, "must remain unchanged\n", "utf-8");
    const beforeOmsHash = createHash("sha256")
      .update(readFileSync(owned))
      .digest("hex");
    const hostMarker = path.join(home, "host-sync-ran");

    const result = runCli(["package", "update", "--yes"], cwd, {
      HOME: home,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not owned by a global npm prefix");
    expect(result.stdout).toContain("npm prefix -g");
    const afterOmsHash = createHash("sha256")
      .update(readFileSync(owned))
      .digest("hex");
    expect(afterOmsHash).toBe(beforeOmsHash);
    expect(existsSync(hostMarker)).toBe(false);
  });

  it("reports package installation failure without running host sync or changing the vault", () => {
    const cwd = makeTempRoot("oms-update-install-failure-");
    const prefix = makeTempRoot("oms-update-prefix-");
    const bin = path.join(makeTempRoot("oms-update-fake-bin-"), "bin");
    const cli = makeInstalledCli(prefix);
    const hostMarker = path.join(cwd, "host-sync-ran");
    installFakeNpm(bin, realpathSync(prefix), "synthetic install refused", hostMarker);
    const owned = path.join(cwd, "user-owned.txt");
    writeFileSync(owned, "must remain unchanged\n", "utf-8");
    const before = readFileSync(owned, "utf-8");

    const result = runCli(["package", "update", "--yes"], cwd, {
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    }, cli);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("npm update failed: synthetic install refused");
    expect(result.stdout).not.toContain("Successfully updated");
    expect(readFileSync(owned, "utf-8")).toBe(before);
    expect(existsSync(hostMarker)).toBe(false);
  });
});
