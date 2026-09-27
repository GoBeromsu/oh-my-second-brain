import { describe, expect, it } from "vitest";
import {
  checkUpdateNotice,
  compareVersions,
  formatUpdateNotice,
  formatUpdateResult,
  runUpdate,
  type RunUpdateOptions,
  type UpdateRunnerCall,
} from "./update.js";

function okCall(stdout = ""): UpdateRunnerCall {
  return { exitCode: 0, stdout, stderr: "" };
}

function failCall(stderr: string): UpdateRunnerCall {
  return { exitCode: 1, stdout: "", stderr };
}

const runningPrefix = "/opt/oms";
const entrypoint = "/launch/oms.js";
const realpath = () => `${runningPrefix}/lib/node_modules/oh-my-second-brain/dist/cli/oms.js`;

function updateOptions(overrides: Partial<RunUpdateOptions> = {}): RunUpdateOptions {
  return {
    currentVersion: "0.1.7",
    latestVersion: "0.1.8",
    yes: true,
    entrypoint,
    realpath,
    ...overrides,
  };
}

function matchingRunner(calls: string[]): (command: string, args: readonly string[]) => UpdateRunnerCall {
  return (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm" && args.join(" ") === "prefix -g") return okCall(`${runningPrefix}\n`);
    return okCall();
  };
}

describe("package updater", () => {
  it("refuses a non-TTY update without mutating", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ yes: false, interactive: false, runner: matchingRunner(calls) }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
    expect(formatUpdateResult(result)).toContain("oms package update --yes");
  });

  it("keeps check mode read-only", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ check: true, runner: matchingRunner(calls) }));

    expect(result).toMatchObject({ success: true, updateAvailable: true, packageMutated: false, mutated: false });
    expect(result.commands).toEqual([
      "npm uninstall -g oh-my-second-brain",
      "curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash",
      "oms host sync",
    ]);
    expect(result.message).toContain("Refusing to update an npm-owned installation in place");
    expect(calls).toEqual([]);
  });

  it("keeps dry-run non-mutating without resolving package topology", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ dryRun: true, runner: matchingRunner(calls) }));

    expect(result.success).toBe(true);
    expect(result.commands).toEqual([
      "npm uninstall -g oh-my-second-brain",
      "curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash",
      "oms host sync",
    ]);
    expect(calls).toEqual([]);
  });

  // F2 regression: `npm install -g` resolves npm from PATH, so the Node that
  // rebuilds the native addon is whatever the shell exposes while the managed
  // MCP registrations stay pinned to the interpreter recorded at install time.
  // An npm-owned install must be refused and migrated, never updated in place.
  it("refuses an npm-owned in-place update and spawns no package manager", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ runner: matchingRunner(calls) }));

    expect(result).toMatchObject({ success: false, packageMutated: false, mutated: false });
    expect(calls).toEqual([]);
    expect(result.message).toContain("Refusing to update an npm-owned installation in place");
    expect(result.message).toContain("npm uninstall -g oh-my-second-brain");
    expect(result.message).toContain("scripts/install.sh");
    expect(result.commands.some((command) => command === "npm install -g oh-my-second-brain@latest")).toBe(false);
  });

  it("updates a Volta-owned installation through Volta without consulting npm's global prefix", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      realpath: () => "/Users/test/.volta/tools/image/packages/oh-my-second-brain/lib/node_modules/oh-my-second-brain/dist/cli/oms.js",
      runtimeNodeVersion: "24.21.0",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    }));

    expect(result).toMatchObject({ success: true, packageMutated: true, mutated: true });
    expect(result.commands).toEqual(["volta run --node 24.21.0 npm install -g oh-my-second-brain@latest"]);
    expect(calls).toEqual(["volta run --node 24.21.0 npm install -g oh-my-second-brain@latest"]);
  });

  it("does nothing when the installed package is already latest", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      currentVersion: "0.1.8",
      latestVersion: "0.1.8",
      runner: matchingRunner(calls),
    }));

    expect(result).toMatchObject({ success: true, updateAvailable: false, packageMutated: false, mutated: false });
    expect(result.commands).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("checks the registry with the expected read-only npm command", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      latestVersion: undefined,
      check: true,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall('"0.1.8"\n');
      },
    }));

    expect(result.success).toBe(true);
    expect(calls).toEqual(["npm view oh-my-second-brain@latest version --json"]);
  });

  it("reports registry errors without attempting installation", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      latestVersion: undefined,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return failCall("registry unavailable");
      },
    }));

    expect(result.success).toBe(false);
    expect(result.message).toContain("registry unavailable");
    expect(calls).toEqual(["npm view oh-my-second-brain@latest version --json"]);
  });

  it("rejects an unresolvable running binary without attempting installation", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      realpath: () => { throw new Error("ENOENT"); },
      runner: matchingRunner(calls),
    }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
    expect(result.message).toContain("Refusing to update an npm-owned installation in place");
    expect(result.message).toContain("oms host sync");
  });

  it("does not invoke a host command when the Volta-owned installation fails", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      realpath: () => "/Users/test/.volta/tools/image/packages/oh-my-second-brain/lib/node_modules/oh-my-second-brain/dist/cli/oms.js",
      runtimeNodeVersion: "24.21.0",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return failCall("install refused");
      },
    }));

    expect(result.success).toBe(false);
    expect(result.packageMutated).toBe(false);
    expect(result.message).toContain("volta update failed: install refused");
    expect(calls).toEqual(["volta run --node 24.21.0 npm install -g oh-my-second-brain@latest"]);
  });

  // F2 regression: a Windows npm-owned layout is still npm-owned, so it takes
  // the same refusal rather than a PATH-resolved `npm install -g`.
  it("refuses a Windows npm-owned layout without invoking any package manager", async () => {
    const calls: string[] = [];
    const prefix = "C:\\Users\\oms\\AppData\\Roaming\\npm";
    const result = await runUpdate(updateOptions({
      entrypoint: "C:\\launch\\oms.js",
      realpath: () => `${prefix}\\node_modules\\oh-my-second-brain\\dist\\cli\\oms.js`,
      runner: matchingRunner(calls),
    }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("Refusing to update an npm-owned installation in place");
    expect(calls).toEqual([]);
  });

  it("compares SemVer prerelease identifiers before stable releases", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("reports an update notice with the separated package and host commands", async () => {
    const notice = await checkUpdateNotice({ currentVersion: "0.1.7", latestVersion: "0.1.8" });
    const formatted = formatUpdateNotice(notice);

    expect(formatted).toContain("oms package update --yes");
    expect(formatted).toContain("newly installed `oms host sync`");
  });
});
