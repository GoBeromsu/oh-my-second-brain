import { formatUpdateResult, runUpdate } from "../kernel/update/update.js";
import { readCurrentPackageVersion } from "./update-notice.js";

interface PackageArguments {
  readonly verb: "check" | "update";
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly timeoutMs: number | undefined;
}

function packageUsage(): string {
  return [
    "Usage: oms package <check|update> [options]",
    "",
    "  oms package check [--timeout-ms <milliseconds>]",
    "  oms package update [--dry-run | --yes] [--timeout-ms <milliseconds>]",
    "",
    "Package updates never modify host integrations. After an update, run `oms host sync` explicitly.",
  ].join("\n");
}

function parsePackageArguments(argv: readonly string[]): PackageArguments {
  const verb = argv[0];
  if (verb !== "check" && verb !== "update") {
    throw new Error(`Unknown package command: ${verb ?? "(none)"}.`);
  }

  let dryRun = false;
  let yes = false;
  let timeoutMs: number | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (seen.has(argument)) throw new Error(`Duplicate package option: ${argument}.`);
    seen.add(argument);

    if (argument === "--dry-run") {
      if (verb !== "update") throw new Error("--dry-run is valid only for `oms package update`.");
      dryRun = true;
      continue;
    }
    if (argument === "--yes") {
      if (verb !== "update") throw new Error("--yes is valid only for `oms package update`.");
      yes = true;
      continue;
    }
    if (argument === "--timeout-ms") {
      const value = argv[++index];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms requires a positive integer.");
      }
      timeoutMs = parsed;
      continue;
    }
    throw new Error(`Unsupported package option: ${argument}.`);
  }

  if (dryRun && yes) throw new Error("--dry-run and --yes cannot be combined.");
  return { verb, dryRun, yes, timeoutMs };
}

export async function runPackageCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      console.log(packageUsage());
      return;
    }

    const parsed = parsePackageArguments(argv);
    const result = await runUpdate({
      currentVersion: await readCurrentPackageVersion(),
      latestVersion: process.env["OMS_UPDATE_LATEST_VERSION"],
      check: parsed.verb === "check",
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      interactive: process.stdin.isTTY === true && process.env["OMS_NON_INTERACTIVE"] !== "1",
      timeoutMs: parsed.timeoutMs,
    });
    console.log(formatUpdateResult(result));
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[oms package] ${message}`);
    console.error(packageUsage());
  }
}
