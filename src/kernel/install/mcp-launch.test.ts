import * as childProcess from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOmsNativeRuntime, omsCliPath, omsMcpLaunch, omsMcpVault, omsNodePath } from "./mcp-launch.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

afterEach(() => vi.restoreAllMocks());

describe("OMS runtime binding", () => {
  it("binds an absolute runtime and its own package regardless of PATH", () => {
    vi.stubEnv("PATH", "/different-runtime/bin");
    try {
      const launch = omsMcpLaunch("/vault with spaces");
      expect(path.isAbsolute(launch.command)).toBe(true);
      expect(launch.command).toBe(omsNodePath());
      expect(launch.args).toEqual([omsCliPath(), "serve", "mcp", "--vault", "/vault with spaces"]);
      expect(omsMcpVault(launch.command, launch.args)).toBe("/vault with spaces");
    } finally { vi.unstubAllEnvs(); }
  });

  it("recognizes legacy registrations only for their exact serve mcp shape", () => {
    expect(omsMcpVault("oms", ["serve", "mcp", "--vault", "/vault"])).toBe("/vault");
    expect(omsMcpVault("oms", ["serve", "http", "--vault", "/vault"])).toBeNull();
    expect(omsMcpVault("node", omsMcpLaunch("/vault").args)).toBeNull();
    expect(omsMcpVault("/different/custom-runner", omsMcpLaunch("/vault").args)).toBeNull();
    expect(omsMcpVault(process.execPath, ["/other/package/dist/cli/oms.js", "serve", "mcp", "--vault", "/vault"])).toBeNull();
    expect(omsMcpVault(process.execPath, null)).toBeNull();
    expect(omsMcpVault(process.execPath, [false])).toBeNull();
    expect(omsMcpVault(null, omsMcpLaunch("/vault").args)).toBeNull();
  });

  it.each(["canonical", "symlinked"])("verifies a Homebrew opt link (%s prefix) and survives keg cleanup", async spelling => {
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "oms-node-keg-")));
    const canonical = path.join(temporary, "brew");
    const root = spelling === "symlinked" ? path.join(temporary, "alias") : canonical;
    const old = path.join(root, "Cellar", "node@24", "24.19.0");
    const next = path.join(root, "Cellar", "node@24", "24.21.0");
    const opt = path.join(root, "opt", "node@24");
    try {
      await mkdir(canonical);
      if (spelling === "symlinked") await symlink(canonical, root);
      await mkdir(path.join(old, "bin"), { recursive: true });
      await mkdir(path.dirname(opt), { recursive: true });
      await writeFile(path.join(old, "bin", "node"), "old");
      await symlink(old, opt);
      const command = omsNodePath(path.join(old, "bin", "node"), "24.19.0");
      expect(command).toBe(path.join(canonical, "opt", "node@24", "bin", "node"));
      await mkdir(path.join(next, "bin"), { recursive: true });
      await writeFile(path.join(next, "bin", "node"), "next");
      await unlink(opt);
      await symlink(next, opt);
      await rm(old, { recursive: true });
      expect(await readFile(command, "utf8")).toBe("next");
      expect(omsNodePath(path.join(next, "bin", "node"), "24.21.0")).toBe(command);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it("never substitutes an unverified, missing, wrong-major, or unversioned brew alias", () => {
    const executable = "/brew/Cellar/node@24/24.19.0/bin/node";
    expect(omsNodePath(executable, "24.19.0", value => value)).toBe(executable);
    expect(omsNodePath(executable, "26.0.0", value => value)).toBe(executable);
    expect(omsNodePath(executable, "24.19.0", () => { throw new Error("missing"); })).toBe(executable);
    const unversioned = "/brew/Cellar/node/24.19.0/bin/node";
    expect(omsNodePath(unversioned, "24.19.0", value => value)).toBe(unversioned);
  });

  it("admits the actual current SQLite runtime using the explicit executable", () => {
    const probe = vi.spyOn(childProcess, "spawnSync");
    expect(() => assertOmsNativeRuntime()).not.toThrow();
    expect(probe.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(probe.mock.calls[0]?.[1]).toContain("--input-type=commonjs");
  });

  it.each([
    { status: 1, stderr: "ERR_DLOPEN_FAILED ABI 147 expected 137", error: undefined, signal: null },
    { status: null, stderr: "", error: new Error("ENOENT stale runtime"), signal: null },
    { status: null, stderr: "", error: undefined, signal: "SIGTERM" },
  ])("fails closed with runtime identity on a failed smoke: $stderr", result => {
    vi.spyOn(childProcess, "spawnSync").mockReturnValue(result as ReturnType<typeof childProcess.spawnSync>);
    expect(() => assertOmsNativeRuntime()).toThrow("OMS_NATIVE_RUNTIME_UNAVAILABLE");
    expect(() => assertOmsNativeRuntime()).toThrow(`ABI ${process.versions.modules}`);
  });
});
