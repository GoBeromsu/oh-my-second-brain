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
const runtimeReport = { node: process.versions.node, modules: process.versions.modules };
const differentRuntime = {
  node: process.versions.node === "26.0.0" ? "24.19.0" : "26.0.0",
  modules: process.versions.modules === "147" ? "137" : "147",
};
const nodeRuntimeCommand = "node -p JSON.stringify({node:process.versions.node,modules:process.versions.modules})";

function updateOptions(overrides: Partial<RunUpdateOptions> = {}): RunUpdateOptions {
  return {
    currentVersion: "0.1.7",
    latestVersion: "0.1.8",
    yes: true,
    entrypoint,
    realpath,
    access: async () => {},
    ...overrides,
  };
}

function matchingRunner(calls: string[]): (command: string, args: readonly string[]) => UpdateRunnerCall {
  return (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm" && args.join(" ") === "prefix -g") return okCall(`${runningPrefix}\n`);
    if (args[0] === "version" || command === "node") return okCall(JSON.stringify(runtimeReport));
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
    expect(formatUpdateResult(result)).toContain("oms setup package update --yes");
  });

  it("keeps check mode read-only", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ check: true, runner: matchingRunner(calls) }));

    expect(result).toMatchObject({ success: true, updateAvailable: true, packageMutated: false, mutated: false });
    expect(result.commands).toEqual(["npm install -g oh-my-second-brain@latest"]);
    expect(calls).toEqual([]);
  });

  it("keeps dry-run non-mutating without resolving package topology", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ dryRun: true, runner: matchingRunner(calls) }));

    expect(result.success).toBe(true);
    expect(result.commands).toEqual(["npm install -g oh-my-second-brain@latest"]);
    expect(calls).toEqual([]);
  });

  it("installs only the package and directs the caller to explicit host sync", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ runner: matchingRunner(calls) }));

    expect(result).toMatchObject({ success: true, packageMutated: true, mutated: true });
    expect(calls).toEqual([
      "npm prefix -g",
      "npm version --json",
      nodeRuntimeCommand,
      "npm install -g oh-my-second-brain@latest",
    ]);
    expect(result.message).toContain("newly installed `oms setup host sync`");
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

  it("rejects an npm prefix mismatch with cross-version-safe recovery guidance", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall("/other/prefix\n");
      },
    }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual(["npm prefix -g"]);
    expect(result.message).toContain("npm --prefix /opt/oms install -g oh-my-second-brain@latest");
    expect(result.message).toContain("newly installed `oms setup host sync`");
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
    expect(result.message).toContain("npm install -g oh-my-second-brain@latest");
    expect(result.message).toContain("oms setup host sync");
  });

  it("does not invoke a host command when installation fails", async () => {
    const calls: string[] = [];
    const runner = matchingRunner(calls);
    const result = await runUpdate(updateOptions({
      runner: (command, args) => {
        const result = runner(command, args);
        return args[0] === "install" ? failCall("install refused") : result;
      },
    }));

    expect(result.success).toBe(false);
    expect(result.packageMutated).toBe(false);
    expect(result.message).toContain("npm update failed: install refused");
    expect(calls).toEqual(["npm prefix -g", "npm version --json", nodeRuntimeCommand, "npm install -g oh-my-second-brain@latest"]);
  });

  it.each([
    ["npm", differentRuntime],
    ["npm", { ...runtimeReport, modules: "different-abi" }],
    ["npm", { ...runtimeReport, node: "different-version" }],
    ["node", differentRuntime],
  ])("refuses a matching prefix when %s uses a different Node runtime (%j)", async (probe, report) => {
    const calls: string[] = [];
    const runner = matchingRunner(calls);
    const result = await runUpdate(updateOptions({
      runner: (command, args) => {
        const result = runner(command, args);
        return command === probe && args[0] !== "prefix" ? okCall(JSON.stringify(report)) : result;
      },
    }));

    expect(result).toMatchObject({ success: false, updateAvailable: true, packageMutated: false, mutated: false });
    expect(calls).toEqual(probe === "npm"
      ? ["npm prefix -g", "npm version --json"]
      : ["npm prefix -g", "npm version --json", nodeRuntimeCommand]);
    expect(result.message).toContain(`running OMS uses Node ${process.versions.node} (ABI ${process.versions.modules})`);
    expect(result.message).toContain(probe === "npm" ? "npm uses Node" : "PATH node used by npm lifecycle scripts uses Node");
    expect(result.message).toContain("Select the same Node installation");
  });

  it.each(["npm", "node"])("fails closed when the %s runtime probe fails", async (probe) => {
    const calls: string[] = [];
    const runner = matchingRunner(calls);
    const result = await runUpdate(updateOptions({
      runner: (command, args) => {
        const result = runner(command, args);
        return command === probe && args[0] !== "prefix" ? failCall("probe unavailable") : result;
      },
    }));

    expect(result).toMatchObject({ success: false, packageMutated: false, mutated: false });
    expect(result.message).toContain("unable to verify the Node runtime");
    expect(result.message).toContain("probe unavailable");
    expect(calls.some((call) => call.includes(" install "))).toBe(false);
  });

  it.each(["not JSON", "null", '"24.0.0"', "{}", '{"node":24}', '{"node":"24.0.0"}', '{"node":"24.0.0","modules":137}'])(
    "fails closed on missing or malformed runtime metadata: %s", async (stdout) => {
      const calls: string[] = [];
      const runner = matchingRunner(calls);
      const result = await runUpdate(updateOptions({
        runner: (command, args) => {
          const result = runner(command, args);
          return args[0] === "version" ? okCall(stdout) : result;
        },
      }));

      expect(result).toMatchObject({ success: false, packageMutated: false, mutated: false });
      expect(result.message).toContain("runtime probe did not return a Node version and modules ABI");
      expect(calls).toEqual(["npm prefix -g", "npm version --json"]);
    },
  );

  it("refuses an unwritable resolved prefix before npm install", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      runner: matchingRunner(calls),
      access: async () => { throw new Error("EACCES"); },
    }));

    expect(result.success).toBe(false);
    expect(result.packageMutated).toBe(false);
    expect(calls).toEqual(["npm prefix -g"]);
    expect(result.message).toContain("npm --prefix /opt/oms install -g oh-my-second-brain@latest");
    expect(result.message).toContain("newly installed `oms setup host sync`");
  });

  it("recognizes a Windows global package layout without invoking its host binary", async () => {
    const calls: string[] = [];
    const runner = matchingRunner(calls);
    const prefix = "C:\\Users\\oms\\AppData\\Roaming\\npm";
    const result = await runUpdate(updateOptions({
      entrypoint: "C:\\launch\\oms.js",
      realpath: () => `${prefix}\\node_modules\\oh-my-second-brain\\dist\\cli\\oms.js`,
      runner: (command, args) => {
        const result = runner(command, args);
        return args[0] === "prefix" ? okCall(`${prefix}\n`) : result;
      },
    }));

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      "npm prefix -g",
      "npm version --json",
      nodeRuntimeCommand,
      "npm install -g oh-my-second-brain@latest",
    ]);
  });

  it("compares SemVer prerelease identifiers before stable releases", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("reports an update notice with the separated package and host commands", async () => {
    const notice = await checkUpdateNotice({ currentVersion: "0.1.7", latestVersion: "0.1.8" });
    const formatted = formatUpdateNotice(notice);

    expect(formatted).toContain("oms setup package update --yes");
    expect(formatted).toContain("newly installed `oms setup host sync`");
  });
});
