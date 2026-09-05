import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { update, currentVersion, format } = vi.hoisted(() => ({
  update: vi.fn(),
  currentVersion: vi.fn(async () => "0.12.2"),
  format: vi.fn((result: { readonly message: string }) => `[oms package] ${result.message}`),
}));

vi.mock("../kernel/update/update.js", () => ({
  runUpdate: update,
  formatUpdateResult: format,
}));
vi.mock("./update-notice.js", () => ({ readCurrentPackageVersion: currentVersion }));

import { runPackageCommand } from "./package-command.js";

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  update.mockResolvedValue({ success: true, message: "receipt" });
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = undefined;
  delete process.env["OMS_UPDATE_LATEST_VERSION"];
  delete process.env["OMS_NON_INTERACTIVE"];
});

describe("package command", () => {
  it("runs a read-only package check through the kernel updater", async () => {
    process.env["OMS_UPDATE_LATEST_VERSION"] = "0.12.3";

    await runPackageCommand(["check", "--timeout-ms", "2500"]);

    expect(update).toHaveBeenCalledWith({
      currentVersion: "0.12.2",
      latestVersion: "0.12.3",
      check: true,
      dryRun: false,
      yes: false,
      interactive: process.stdin.isTTY === true,
      timeoutMs: 2500,
    });
    expect(log).toHaveBeenCalledWith("[oms package] receipt");
    expect(process.exitCode).toBe(0);
  });

  it("runs a confirmed package-only update", async () => {
    await runPackageCommand(["update", "--yes"]);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      currentVersion: "0.12.2",
      check: false,
      dryRun: false,
      yes: true,
    }));
    expect(process.exitCode).toBe(0);
  });

  it("supports a non-mutating update preview", async () => {
    await runPackageCommand(["update", "--dry-run"]);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, yes: false }));
    expect(process.exitCode).toBe(0);
  });

  it("propagates updater failure through the process exit code and receipt", async () => {
    update.mockResolvedValue({ success: false, message: "npm update failed: denied" });

    await runPackageCommand(["update", "--yes"]);

    expect(log).toHaveBeenCalledWith("[oms package] npm update failed: denied");
    expect(process.exitCode).toBe(1);
  });

  it("rejects invalid verbs and update-only flags on check", async () => {
    await runPackageCommand(["check", "--yes"]);

    expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("[oms package] --yes is valid only for `oms package update`.");
    expect(process.exitCode).toBe(1);

    error.mockClear();
    process.exitCode = undefined;
    await runPackageCommand(["upgrade"]);
    expect(error).toHaveBeenCalledWith("[oms package] Unknown package command: upgrade.");
    expect(process.exitCode).toBe(1);
  });

  it("rejects conflicting mutation flags before invoking the updater", async () => {
    await runPackageCommand(["update", "--dry-run", "--yes"]);

    expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("[oms package] --dry-run and --yes cannot be combined.");
    expect(process.exitCode).toBe(1);
  });

  it("documents explicit host sync rather than applying hosts automatically", async () => {
    await runPackageCommand(["--help"]);

    expect(update).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("oms host sync");
    expect(process.exitCode).toBe(0);
  });
});
