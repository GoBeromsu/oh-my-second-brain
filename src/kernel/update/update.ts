import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { RuntimeSelection } from "../install/hosts.js";

export interface UpdateRunnerCall {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UpdateRunnerOptions {
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export type UpdateRunner = (
  command: string,
  args: readonly string[],
  options: UpdateRunnerOptions,
) => UpdateRunnerCall | Promise<UpdateRunnerCall>;

export interface ReconcileCommand {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

export interface RunUpdateOptions {
  readonly currentVersion: string | null;
  readonly latestVersion?: string;
  readonly packageName?: string;
  readonly runtime: RuntimeSelection;
  readonly vault: string;
  readonly check?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  /**
   * Whether this invocation has an interactive TTY available for confirmation.
   * Callers that do not provide this option remain non-interactive.
   */
  readonly interactive?: boolean;
  /** Confirmation hook used by the CLI and deterministic tests. */
  readonly confirm?: () => boolean | Promise<boolean>;
  readonly executeExternal?: boolean;
  readonly timeoutMs?: number;
  readonly runner?: UpdateRunner;
  readonly reconcileCommand?: ReconcileCommand;
}

export interface UpdateResult {
  readonly success: boolean;
  readonly currentVersion: string | null;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly mutated: boolean;
  readonly message: string;
  readonly commands: readonly string[];
  readonly errors: readonly string[];
}

export interface UpdateNotice {
  readonly currentVersion: string | null;
  readonly latestVersion: string;
}

export interface CheckUpdateNoticeOptions {
  readonly currentVersion: string | null;
  readonly latestVersion?: string;
  readonly packageName?: string;
  readonly timeoutMs?: number;
  readonly runner?: UpdateRunner;
}

const DEFAULT_PACKAGE_NAME = "oh-my-second-brain";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_NOTICE_TIMEOUT_MS = 1_500;

function defaultRunner(
  command: string,
  args: readonly string[],
  options: UpdateRunnerOptions,
): UpdateRunnerCall {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: options.timeoutMs,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderrFromResult = typeof result.stderr === "string" ? result.stderr : "";
  const stderr = result.error instanceof Error ? result.error.message : stderrFromResult;
  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
  };
}

function cleanVersion(raw: string): string {
  return raw.trim().replace(/^"|"$/g, "").replace(/^v/, "");
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericStrings(leftVersion.core[index] ?? "0", rightVersion.core[index] ?? "0");
    if (comparison !== 0) return comparison;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
  if (leftVersion.prerelease.length === 0) return 1;
  if (rightVersion.prerelease.length === 0) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const comparison = compareNumericStrings(leftIdentifier, rightIdentifier);
      if (comparison !== 0) return comparison;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (leftIdentifier < rightIdentifier) return -1;
    if (leftIdentifier > rightIdentifier) return 1;
  }
  return 0;
}

interface ParsedVersion {
  readonly core: readonly string[];
  readonly prerelease: readonly string[];
}

function parseVersion(raw: string): ParsedVersion {
  const cleaned = cleanVersion(raw);
  const match = /^(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(cleaned);
  if (match === null) {
    return { core: ["0", "0", "0"], prerelease: [] };
  }
  return {
    core: (match[1] ?? "0").split("."),
    prerelease: match[2]?.split(".") ?? [],
  };
}

function compareNumericStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length < normalizedRight.length) return -1;
  if (normalizedLeft.length > normalizedRight.length) return 1;
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

async function confirmUpdate(): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("[oms] Update package and refresh host adapters? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export async function resolveLatestVersion(options: {
  readonly packageName: string;
  readonly latestVersion?: string | undefined;
  readonly timeoutMs: number;
  readonly runner?: UpdateRunner | undefined;
}): Promise<{ readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string }> {
  if (options.latestVersion !== undefined) {
    return { ok: true, version: cleanVersion(options.latestVersion) };
  }

  const result = await (options.runner ?? defaultRunner)(
    "npm",
    ["view", `${options.packageName}@latest`, "version", "--json"],
    { timeoutMs: options.timeoutMs },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || "npm registry query failed",
    };
  }

  const version = cleanVersion(result.stdout);
  if (!version) {
    return { ok: false, error: "npm registry returned an empty latest version" };
  }
  return { ok: true, version };
}

function buildReconcileArgs(options: {
  readonly runtime: RuntimeSelection;
  readonly vault: string;
  readonly executeExternal: boolean;
}): readonly string[] {
  const args = ["update-reconcile", "--runtime", options.runtime, "--vault", options.vault];
  if (options.executeExternal) {
    args.push("--execute");
  }
  return args;
}

function buildReconcileCommand(options: RunUpdateOptions): ReconcileCommand {
  if (options.reconcileCommand !== undefined) return options.reconcileCommand;
  const entrypoint = process.argv[1] ?? "oms";
  return { command: process.execPath, argsPrefix: [entrypoint] };
}

export async function runUpdate(options: RunUpdateOptions): Promise<UpdateResult> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? defaultRunner;
  const latest = await resolveLatestVersion({
    packageName,
    latestVersion: options.latestVersion,
    timeoutMs,
    runner,
  });
  if (!latest.ok) {
    return {
      success: false,
      currentVersion: options.currentVersion,
      latestVersion: "unknown",
      updateAvailable: false,
      mutated: false,
      message: `Update check failed: ${latest.error}`,
      commands: [],
      errors: [latest.error],
    };
  }

  const currentVersion = options.currentVersion;
  const updateAvailable =
    currentVersion === null || compareVersions(currentVersion, latest.version) < 0;
  const npmArgs = ["install", "-g", `${packageName}@latest`];
  const reconcile = buildReconcileCommand(options);
  const reconcileArgs = [
    ...reconcile.argsPrefix,
    ...buildReconcileArgs({
      runtime: options.runtime,
      vault: options.vault,
      executeExternal: options.executeExternal === true,
    }),
  ];
  const commands = [
    formatCommand("npm", npmArgs),
    formatCommand(reconcile.command, reconcileArgs),
  ];

  if (!updateAvailable) {
    return {
      success: true,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable: false,
      mutated: false,
      message: `Oh My Second Brain is already up to date (${currentVersion ?? latest.version}).`,
      commands: [],
      errors: [],
    };
  }

  if (options.dryRun === true || options.check === true) {
    return {
      success: true,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable: true,
      mutated: false,
      message: `Update available: ${currentVersion ?? "unknown"} -> ${latest.version}.`,
      commands,
      errors: [],
    };
  }

  if (options.yes !== true) {
    if (options.interactive !== true) {
      return {
        success: false,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: true,
        mutated: false,
        message: `Update available: ${currentVersion ?? "unknown"} -> ${latest.version}. Refusing to update without --yes when stdin is not a TTY.`,
        commands,
        errors: ["Interactive confirmation is required for update execution."],
      };
    }

    let confirmed = false;
    try {
      confirmed = await (options.confirm ?? confirmUpdate)();
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      return {
        success: false,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: true,
        mutated: false,
        message: "Update cancelled; no changes were made.",
        commands,
        errors: ["Update confirmation was not received."],
      };
    }
  }

  const npmResult = await runner("npm", npmArgs, { timeoutMs });
  if (npmResult.exitCode !== 0) {
    const error = npmResult.stderr.trim() || npmResult.stdout.trim() || "npm install failed";
    return {
      success: false,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable: true,
      mutated: false,
      message: `npm update failed: ${error}`,
      commands,
      errors: [error],
    };
  }

  const reconcileResult = await runner(reconcile.command, reconcileArgs, {
    timeoutMs,
    env: { OMS_UPDATE_RECONCILE: "1" },
  });
  if (reconcileResult.exitCode !== 0) {
    const error =
      reconcileResult.stderr.trim() || reconcileResult.stdout.trim() || "runtime reconciliation failed";
    return {
      success: false,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable: true,
      mutated: true,
      message: `Updated package to ${latest.version}, but reconciliation failed: ${error}`,
      commands,
      errors: [error],
    };
  }

  return {
    success: true,
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: true,
    mutated: true,
    message: `Successfully updated Oh My Second Brain from ${currentVersion ?? "unknown"} to ${latest.version}.`,
    commands,
    errors: [],
  };
}

export async function checkUpdateNotice(
  options: CheckUpdateNoticeOptions,
): Promise<UpdateNotice | null> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NOTICE_TIMEOUT_MS;
  const runner = options.runner ?? defaultRunner;
  const latest = await resolveLatestVersion({
    packageName,
    latestVersion: options.latestVersion,
    timeoutMs,
    runner,
  });
  if (!latest.ok) return null;

  const currentVersion = options.currentVersion;
  const updateAvailable =
    currentVersion === null || compareVersions(currentVersion, latest.version) < 0;
  if (!updateAvailable) return null;

  return {
    currentVersion,
    latestVersion: latest.version,
  };
}

export function formatUpdateResult(result: UpdateResult): string {
  const lines = [`[oms update] ${result.message}`];
  if (result.updateAvailable && !result.mutated) {
    lines.push("");
    lines.push("Planned commands:");
    for (const command of result.commands) {
      lines.push(`  ${command}`);
    }
    lines.push("");
    lines.push("Run `oms update --yes` to perform the package update and refresh host adapters.");
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ${error}`);
    }
  }
  return lines.join("\n");
}

export function formatUpdateNotice(notice: UpdateNotice | null): string {
  if (notice === null) return "";
  return [
    `[oms] Update available: ${notice.currentVersion ?? "unknown"} -> ${notice.latestVersion}.`,
    "Run `oms update --dry-run` to preview or `oms update --yes` to update and refresh host adapters.",
  ].join("\n");
}
