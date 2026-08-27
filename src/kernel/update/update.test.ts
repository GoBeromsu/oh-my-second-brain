import { describe, expect, it } from "vitest";
import {
  checkUpdateNotice,
  compareVersions,
  formatUpdateNotice,
  formatUpdateResult,
  runUpdate,
  type UpdateRunnerCall,
} from "./update.js";

function okCall(stdout = ""): UpdateRunnerCall {
  return { exitCode: 0, stdout, stderr: "" };
}

function failCall(stderr: string): UpdateRunnerCall {
  return { exitCode: 1, stdout: "", stderr };
}

describe("oms update", () => {
  it("UPD-001 refuses a non-TTY update without mutating", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      interactive: false,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall("0.1.8");
      },
    });

    expect(result.success).toBe(false);
    expect(result.updateAvailable).toBe(true);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
    expect(formatUpdateResult(result)).toContain("oms update --yes");
  });

  it("UPD-001b prompts on a TTY and updates only after confirmation", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      interactive: true,
      confirm: async () => true,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(true);
    expect(result.mutated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("UPD-001c leaves a TTY update untouched when confirmation is declined", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      interactive: true,
      confirm: async () => false,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
  });

  it("UPD-001e treats a closed TTY prompt as a declined confirmation", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      interactive: true,
      confirm: async () => {
        throw new Error("stdin closed");
      },
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
  });

  it("UPD-001d keeps dry-run non-mutating regardless of TTY state", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      interactive: true,
      dryRun: true,
      confirm: async () => {
        throw new Error("dry-run must not prompt");
      },
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(true);
    expect(result.mutated).toBe(false);
    expect(calls).toEqual([]);
  });

  it("UPD-002 compares SemVer prerelease identifiers before stable releases", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];

    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index - 1] as string, ordered[index] as string)).toBeLessThan(0);
    }
    expect(compareVersions("v1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("UPD-002 reports dry-run plan without invoking the runner", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "codex",
      vault: "/tmp/Vault",
      dryRun: true,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(true);
    expect(result.mutated).toBe(false);
    expect(result.commands).toContain("npm install -g oh-my-second-brain@latest");
    expect(result.commands.some((command) => command.includes("update-reconcile --runtime codex"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("UPD-003 executes npm update and re-exec reconciliation only with yes", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "codex",
      vault: "/tmp/Vault",
      yes: true,
      executeExternal: true,
      reconcileCommand: { command: "node", argsPrefix: ["/pkg/dist/cli/oms.js"] },
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(result.success).toBe(true);
    expect(result.mutated).toBe(true);
    expect(calls).toEqual([
      "npm install -g oh-my-second-brain@latest",
      "node /pkg/dist/cli/oms.js update-reconcile --runtime codex --vault /tmp/Vault --execute",
    ]);
  });

  it("UPD-004 skips reconciliation when npm update fails", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      yes: true,
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return failCall("registry unavailable");
      },
    });

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("npm update failed");
    expect(calls).toEqual(["npm install -g oh-my-second-brain@latest"]);
  });

  it("UPD-005 reports partial success when reconciliation fails after npm update", async () => {
    const calls: string[] = [];
    const result = await runUpdate({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runtime: "all",
      vault: "/tmp/Vault",
      yes: true,
      reconcileCommand: { command: "node", argsPrefix: ["/pkg/dist/cli/oms.js"] },
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return calls.length === 1 ? okCall() : failCall("host config refused");
      },
    });

    expect(result.success).toBe(false);
    expect(result.mutated).toBe(true);
    expect(result.message).toContain("reconciliation failed");
    expect(calls).toHaveLength(2);
  });

  it("UPD-NOTICE-001 reports an update notice without mutating", async () => {
    const calls: string[] = [];
    const notice = await checkUpdateNotice({
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      runner: (command, args) => {
        calls.push([command, ...args].join(" "));
        return okCall();
      },
    });

    expect(notice).not.toBeNull();
    expect(notice?.currentVersion).toBe("0.1.7");
    expect(notice?.latestVersion).toBe("0.1.8");
    expect(calls).toEqual([]);
    expect(formatUpdateNotice(notice)).toContain("oms update --yes");
  });

  it("UPD-NOTICE-002 stays silent when current version is already latest", async () => {
    await expect(
      checkUpdateNotice({
        currentVersion: "0.1.8",
        latestVersion: "0.1.8",
      }),
    ).resolves.toBeNull();
  });

  it("UPD-NOTICE-003 stays silent when registry lookup fails", async () => {
    await expect(
      checkUpdateNotice({
        currentVersion: "0.1.7",
        runner: () => failCall("registry unavailable"),
      }),
    ).resolves.toBeNull();
  });
});
