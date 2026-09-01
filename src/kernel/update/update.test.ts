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
    runtime: "codex",
    vault: "/tmp/Vault",
    yes: true,
    entrypoint,
    realpath,
    ...overrides,
  };
}

function matchingRunner(calls: string[], reconcileResult = okCall()): (command: string, args: readonly string[]) => UpdateRunnerCall {
  return (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm" && args.join(" ") === "prefix -g") return okCall(`${runningPrefix}\n`);
    if (command === "npm") return okCall();
    return reconcileResult;
  };
}

describe("oms update", () => {
  it("refuses a non-TTY update without mutating", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ yes: false, interactive: false, runner: matchingRunner(calls) }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
    expect(formatUpdateResult(result)).toContain("oms update --yes");
  });

  it("keeps dry-run non-mutating without resolving topology", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ dryRun: true, runner: matchingRunner(calls) }));

    expect(result.success).toBe(true);
    expect(result.commands).toEqual([
      "npm install -g oh-my-second-brain@latest",
      "oms reconcile --runtime codex --vault /tmp/Vault",
    ]);
    expect(calls).toEqual([]);
  });

  it("plans but does not execute reconciliation in check mode when already current", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      currentVersion: "0.1.8",
      latestVersion: "0.1.8",
      check: true,
      runner: matchingRunner(calls),
    }));

    expect(result.success).toBe(true);
    expect(result.commands).toEqual(["oms reconcile --runtime codex --vault /tmp/Vault"]);
    expect(calls).toEqual([]);
  });

  it("uses npm prefix matching the real running binary before installing", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ runner: matchingRunner(calls), executeExternal: true }));

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      "npm prefix -g",
      "npm install -g oh-my-second-brain@latest",
      "/opt/oms/bin/oms reconcile --runtime codex --vault /tmp/Vault --execute",
    ]);
  });

  it("rejects an npm prefix mismatch without attempting installation", async () => {
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
    expect(result.message).toContain("/opt/oms");
    expect(result.message).toContain("/other/prefix");
    expect(result.message).toContain("npm --prefix /opt/oms install -g oh-my-second-brain@latest");
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
    expect(result.message).toContain("ENOENT");
  });

  it("reconciles even when the installed package is already latest", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      currentVersion: "0.1.8",
      latestVersion: "0.1.8",
      runner: matchingRunner(calls),
    }));

    expect(result.success).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("already up to date");
    expect(result.message).toContain("reconciliation completed");
    expect(calls).toEqual([
      "npm prefix -g",
      "/opt/oms/bin/oms reconcile --runtime codex --vault /tmp/Vault",
    ]);
  });

  it("does not reconcile when installation fails", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return command === "npm" && args[0] === "prefix" ? okCall(`${runningPrefix}\n`) : failCall("registry unavailable");
      },
    }));

    expect(result.success).toBe(false);
    expect(calls).toEqual(["npm prefix -g", "npm install -g oh-my-second-brain@latest"]);
  });

  it("reports the exact installed-bin resume command when reconciliation fails", async () => {
    const calls: string[] = [];
    const result = await runUpdate(updateOptions({ runner: matchingRunner(calls, failCall("host config refused")) }));

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(true);
    expect(result.message).toContain("Resume with `/opt/oms/bin/oms reconcile --runtime codex --vault /tmp/Vault`");
  });

  it("compares SemVer prerelease identifiers before stable releases", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("reports an update notice without mutating", async () => {
    const notice = await checkUpdateNotice({ currentVersion: "0.1.7", latestVersion: "0.1.8" });
    expect(notice).toMatchObject({ currentVersion: "0.1.7", latestVersion: "0.1.8" });
    expect(formatUpdateNotice(notice)).toContain("oms update --yes");
  });
});
