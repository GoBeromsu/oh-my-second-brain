import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBundledAssetPaths } from "../core/runtime/assets.js";
import {
  checkUpdateNotice,
  formatUpdateNotice,
  type UpdateRunner,
} from "../update/update.js";

const bundledAssets = resolveBundledAssetPaths();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readCurrentPackageVersion(): Promise<string | null> {
  const packageJson: unknown = JSON.parse(
    await readFile(path.join(bundledAssets.packageRoot, "package.json"), "utf-8"),
  );
  return isRecord(packageJson) && typeof packageJson["version"] === "string"
    ? packageJson["version"]
    : null;
}

function updateNoticeDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["OMS_UPDATE_NOTICE"] === "0" || env["OMS_NO_UPDATE_NOTICE"] === "1";
}

function parseUpdateNoticeTimeout(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env["OMS_UPDATE_NOTICE_TIMEOUT_MS"];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function maybePrintUpdateNotice(options: {
  readonly currentVersion?: string | null;
  readonly latestVersion?: string;
  readonly timeoutMs?: number;
  readonly runner?: UpdateRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (message: string) => void;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (updateNoticeDisabled(env)) return;

  const currentVersion = options.currentVersion ?? await readCurrentPackageVersion();
  const notice = await checkUpdateNotice({
    currentVersion,
    latestVersion: options.latestVersion ?? env["OMS_UPDATE_LATEST_VERSION"],
    timeoutMs: options.timeoutMs ?? parseUpdateNoticeTimeout(env),
    runner: options.runner,
  });
  const formatted = formatUpdateNotice(notice);
  if (formatted.length === 0) return;

  const write = options.write ?? ((message: string) => console.error(message));
  write(`\n${formatted}`);
}
