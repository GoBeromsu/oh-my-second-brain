import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";

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

export interface RunUpdateOptions {
  readonly currentVersion: string | null;
  readonly latestVersion?: string;
  readonly packageName?: string;
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
  readonly timeoutMs?: number;
  readonly runner?: UpdateRunner;
  /** Injectable only to make ownership topology deterministic in tests. */
  readonly entrypoint?: string;
  readonly realpath?: (target: string) => string;
  /** Injectable only to make Volta's retained Node runtime deterministic in tests. */
  readonly runtimeNodeVersion?: string;
}

export interface UpdateResult {
  readonly success: boolean;
  readonly currentVersion: string | null;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  /**
   * Ownership topology of the running installation. An npm-owned install cannot
   * be updated in place, so its guidance must name the migration commands
   * instead of `oms package update --yes`, which would only be refused again.
   */
  readonly packageManager: PackageManager;
  /** Whether npm installed a package during this invocation. */
  readonly packageMutated: boolean;
  /** Whether this invocation installed the package. */
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

type PackageManager = "npm" | "volta";

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
    const answer = await readline.question("[oms] Update package? [y/N] ");
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

function runningPackagePrefix(options: RunUpdateOptions): string {
  const entrypoint = options.entrypoint ?? process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("The running OMS binary path is unavailable.");
  }
  const binary = (options.realpath ?? realpathSync)(entrypoint);
  const posixIndex = binary.indexOf("/lib/node_modules/");
  const winIndex = binary.toLocaleLowerCase().indexOf("\\node_modules\\");
  if (posixIndex === -1 && winIndex === -1) {
    throw new Error(`The running OMS binary is not owned by a global npm prefix: ${binary}`);
  }
  if (posixIndex !== -1) {
    return binary.slice(0, posixIndex);
  }
  return binary.slice(0, winIndex);
}

function packageManagerForEntrypoint(options: RunUpdateOptions, packageName: string): PackageManager {
  const entrypoint = options.entrypoint ?? process.argv[1];
  if (entrypoint === undefined) return "npm";
  let binary: string;
  try {
    binary = (options.realpath ?? realpathSync)(entrypoint).replaceAll("\\", "/").toLocaleLowerCase();
  } catch {
    return "npm";
  }
  const packagePath = packageName.replaceAll("\\", "/").toLocaleLowerCase();
  return binary.includes(`/tools/image/packages/${packagePath}/lib/node_modules/${packagePath}/`)
    ? "volta"
    : "npm";
}

const INSTALLER_URL = "https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh";

function npmOwnedMigrationCommands(packageName: string): string[] {
  return [`npm uninstall -g ${packageName}`, `curl -fsSL ${INSTALLER_URL} | bash`, "oms host sync"];
}

/**
 * An npm-owned global install cannot be updated in place.
 *
 * `npm install -g` would be resolved from `PATH`, and a PATH-resolved npm runs
 * under whichever Node the shell happens to expose. That Node is the one that
 * rebuilds the native SQLite addon, while the managed MCP registrations stay
 * pinned to the absolute interpreter recorded at install time. Matching global
 * prefixes prove only WHERE the package lands, never WHICH interpreter built
 * it, so no prefix check can close that gap — the addon and the launcher drift
 * apart and OMS fails to start under the host (issue #139).
 *
 * The supported layout pins one Node through Volta; migrating there is the
 * repair, so this refuses rather than performing an update it cannot make
 * coherent.
 */
function npmOwnedUpdateRefusal(options: RunUpdateOptions, packageName: string): string {
  let location: string;
  try {
    location = `this OMS lives in the npm global prefix ${runningPackagePrefix(options)}`;
  } catch (error) {
    location = error instanceof Error ? error.message : String(error);
  }
  return `Refusing to update an npm-owned installation in place: ${location}, and a PATH-resolved \`npm\` would rebuild the native addon under whichever Node the shell exposes while the managed MCP registrations stay pinned to the interpreter recorded at install time. Reinstall through the Volta-pinned installer instead: ${npmOwnedMigrationCommands(packageName).join(", then ")}.`;
}

export async function runUpdate(options: RunUpdateOptions): Promise<UpdateResult> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? defaultRunner;
  const packageManager = packageManagerForEntrypoint(options, packageName);
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
      packageManager,
      packageMutated: false,
      mutated: false,
      message: `Update check failed: ${latest.error}`,
      commands: [],
      errors: [latest.error],
    };
  }

  const currentVersion = options.currentVersion;
  const updateAvailable =
    currentVersion === null || compareVersions(currentVersion, latest.version) < 0;
  const installArgs = ["run", "--node", options.runtimeNodeVersion ?? process.versions.node, "npm", "install", "-g", `${packageName}@latest`];
  const commands = packageManager === "volta"
    ? [formatCommand(packageManager, installArgs)]
    : npmOwnedMigrationCommands(packageName);

  if (options.dryRun === true || options.check === true) {
    return {
      success: true,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable,
      packageManager,
      packageMutated: false,
      mutated: false,
      message: !updateAvailable
        ? `Oh My Second Brain is already up to date (${currentVersion ?? latest.version}).`
        : packageManager === "npm"
          ? `Update available: ${currentVersion ?? "unknown"} -> ${latest.version}. ${npmOwnedUpdateRefusal(options, packageName)}`
          : `Update available: ${currentVersion ?? "unknown"} -> ${latest.version}.`,
      commands: updateAvailable ? commands : [],
      errors: [],
    };
  }

  if (updateAvailable && packageManager === "npm") {
    const refusal = npmOwnedUpdateRefusal(options, packageName);
    return {
      success: false,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable,
      packageManager,
      packageMutated: false,
      mutated: false,
      message: refusal,
      commands,
      errors: [refusal],
    };
  }

  if (updateAvailable && options.yes !== true) {
    if (options.interactive !== true) {
      return {
        success: false,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: true,
        packageManager,
        packageMutated: false,
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
        packageManager,
        packageMutated: false,
        mutated: false,
        message: "Update cancelled; no changes were made.",
        commands,
        errors: ["Update confirmation was not received."],
      };
    }
  }

  if (updateAvailable) {
    const installResult = await runner(packageManager, installArgs, { timeoutMs });
    if (installResult.exitCode !== 0) {
      const error = installResult.stderr.trim() || installResult.stdout.trim() || `${packageManager} install failed`;
      return {
        success: false,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: true,
        packageManager,
        packageMutated: false,
        mutated: false,
        message: `${packageManager} update failed: ${error}`,
        commands,
        errors: [error],
      };
    }
  }

  return {
    success: true,
    currentVersion,
    latestVersion: latest.version,
    updateAvailable,
    packageManager,
    packageMutated: updateAvailable,
    mutated: updateAvailable,
    message: updateAvailable
      ? `Successfully updated Oh My Second Brain from ${currentVersion ?? "unknown"} to ${latest.version}. Run the newly installed \`oms host sync\` to refresh host integrations.`
      : `Oh My Second Brain is already up to date (${currentVersion ?? latest.version}).`,
    commands: updateAvailable ? commands : [],
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
  const lines = [`[oms package] ${result.message}`];
  if (result.updateAvailable && !result.mutated) {
    lines.push("");
    lines.push("Planned commands:");
    for (const command of result.commands) {
      lines.push(`  ${command}`);
    }
    lines.push("");
    // An npm-owned install refuses every in-place update, so pointing at
    // `oms package update --yes` would send the user back into the refusal.
    lines.push(result.packageManager === "npm"
      ? "Run the commands above to migrate to the Volta-pinned installation; `oms package update` cannot update an npm-owned install in place."
      : "Run `oms package update --yes` to install the package. Then run the newly installed `oms host sync` to refresh host integrations.");
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
  // The notice carries no ownership topology, and an npm-owned install refuses
  // `oms package update`, so the notice names only the read-only check, which
  // prints the correct command for this installation.
  return [
    `[oms] Update available: ${notice.currentVersion ?? "unknown"} -> ${notice.latestVersion}.`,
    "Run `oms package check` to inspect the release and see how to install it for this installation. After installing, run the newly installed `oms host sync` to refresh host integrations.",
  ].join("\n");
}
