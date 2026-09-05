import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, resolveLatestVersion, type UpdateRunner } from "../kernel/update/update.js";

/**
 * Boot-time update nudge for the MCP server.
 *
 * The hot path (`cachedUpdateNotice`) only reads a small JSON cache; it never
 * touches the network and never throws. The registry query lives in
 * `refreshUpdateNoticeCache`, scheduled detached from the serve path so a slow
 * or offline registry cannot delay or fail server startup. Nothing here writes
 * stdout: stdout is the JSON-RPC transport.
 */

export type UpdateChannel = "stable" | "prerelease";

interface ChannelStamp {
  readonly latestVersion: string;
  readonly checkedAt: number;
}

interface UpdateNoticeCache {
  readonly version: 1;
  readonly channels: Readonly<Partial<Record<UpdateChannel, ChannelStamp>>>;
}

export interface CachedUpdateNoticeOptions {
  readonly installedVersion: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
}

export interface RefreshUpdateNoticeCacheOptions extends CachedUpdateNoticeOptions {
  readonly runner?: UpdateRunner;
  readonly timeoutMs?: number;
}

const CACHE_FILE_NAME = "update-notice-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 4_000;
const PACKAGE_NAME = "oh-my-second-brain";

let refreshStarted = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noticeSuppressed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["OMS_UPDATE_NOTICE"] === "0" || env["OMS_NO_UPDATE_NOTICE"] === "1";
}

export function updateNoticeCachePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const stateDir = env["OMS_AUTO_UPDATE_STATE_DIR"];
  const dir = stateDir !== undefined && stateDir.length > 0 ? stateDir : path.join(os.homedir(), ".oms");
  return path.join(dir, CACHE_FILE_NAME);
}

export function updateChannelOf(installedVersion: string): UpdateChannel {
  return installedVersion.includes("-") ? "prerelease" : "stable";
}

function parseStamp(value: unknown): ChannelStamp | null {
  if (!isRecord(value)) return null;
  const latestVersion = value["latestVersion"];
  const checkedAt = value["checkedAt"];
  if (typeof latestVersion !== "string" || latestVersion.length === 0) return null;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  return { latestVersion, checkedAt };
}

function readCache(cachePath: string): UpdateNoticeCache | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf-8");
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }

  if (!isRecord(parsed) || parsed["version"] !== 1 || !isRecord(parsed["channels"])) return null;

  const channels: Partial<Record<UpdateChannel, ChannelStamp>> = {};
  for (const channel of ["stable", "prerelease"] as const) {
    const stamp = parseStamp(parsed["channels"][channel]);
    if (stamp !== null) channels[channel] = stamp;
  }
  return { version: 1, channels };
}

/** True when the channel's stamp exists and is within the 24h TTL. */
function stampIsFresh(stamp: ChannelStamp | undefined, now: number): boolean {
  if (stamp === undefined) return false;
  const age = now - stamp.checkedAt;
  return age >= 0 && age <= CACHE_TTL_MS;
}

/**
 * Reads the cached latest version for the installed channel and renders a
 * one-line nudge when that version is newer and the stamp is within the 24h
 * TTL. Freshness is per channel, so a stable refresh never makes an older
 * prerelease stamp look current. Returns null on every failure or suppression.
 */
export function cachedUpdateNotice(options: CachedUpdateNoticeOptions): string | null {
  const env = options.env ?? process.env;
  if (noticeSuppressed(env)) return null;

  const cache = readCache(updateNoticeCachePath(env));
  if (cache === null) return null;

  const stamp = cache.channels[updateChannelOf(options.installedVersion)];
  if (stamp === undefined) return null;

  if (!stampIsFresh(stamp, options.now ?? Date.now())) return null;
  if (compareVersions(options.installedVersion, stamp.latestVersion) >= 0) return null;

  return `Update available for Oh My Second Brain: ${options.installedVersion} -> ${stamp.latestVersion}. Run \`oms package update --yes\` to update OMS, then \`oms host sync\` to refresh host registrations.`;
}

function reclaimStaleLock(lockPath: string): void {
  let lockedAt: number;
  try {
    lockedAt = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
  if (Date.now() - lockedAt > CACHE_TTL_MS) rmSync(lockPath, { force: true });
}

function writeCacheAtomically(cachePath: string, cache: UpdateNoticeCache): void {
  const dir = path.dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  // Cross-process serialization: whoever creates the lock wins this round; a
  // loser simply skips the write, because a missed refresh is harmless. A lock
  // left behind by a killed process is reclaimed once it is older than the TTL,
  // so a crash cannot silence update checks forever.
  const lockPath = `${cachePath}.lock`;
  reclaimStaleLock(lockPath);
  const lockFd = openSync(lockPath, "wx");
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(cache)}\n`, "utf-8");
    renameSync(tempPath, cachePath);
  } finally {
    rmSync(tempPath, { force: true });
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

/**
 * Performs ONE bounded registry query and stores the result under the
 * installed channel's stamp, preserving the other channel's stamp. Awaitable
 * for tests; production calls it detached via `scheduleUpdateNoticeRefresh`.
 * Fails open: any error leaves the cache untouched and resolves normally.
 */
export async function refreshUpdateNoticeCache(
  options: RefreshUpdateNoticeCacheOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  if (noticeSuppressed(env)) return;

  const cachePath = updateNoticeCachePath(env);
  try {
    const latest = await resolveLatestVersion({
      packageName: PACKAGE_NAME,
      timeoutMs: options.timeoutMs ?? REFRESH_TIMEOUT_MS,
      runner: options.runner,
      latestVersion: env["OMS_UPDATE_LATEST_VERSION"],
    });
    if (!latest.ok) return;

    const existing = readCache(cachePath);
    writeCacheAtomically(cachePath, {
      version: 1,
      channels: {
        ...existing?.channels,
        [updateChannelOf(options.installedVersion)]: {
          latestVersion: latest.version,
          checkedAt: options.now ?? Date.now(),
        },
      },
    });
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}

/**
 * Serve-path entrypoint: starts at most one detached refresh per process. Never
 * awaited by the caller, so startup latency is unaffected.
 *
 * Skips the registry entirely while the installed channel's stamp is still
 * within the TTL: a fresh cache already answers the boot-time question, so
 * every serve boot inside that window costs zero subprocesses. Returns the
 * detached promise when a refresh was started and null when none was needed,
 * so tests can await the background work without a timer.
 */
export function scheduleUpdateNoticeRefresh(
  options: RefreshUpdateNoticeCacheOptions,
): Promise<void> | null {
  if (refreshStarted) return null;

  const env = options.env ?? process.env;
  if (noticeSuppressed(env)) return null;

  const cache = readCache(updateNoticeCachePath(env));
  const stamp = cache?.channels[updateChannelOf(options.installedVersion)];
  if (stampIsFresh(stamp, options.now ?? Date.now())) return null;

  refreshStarted = true;
  return refreshUpdateNoticeCache(options);
}

/** Clears the per-process refresh lock. Test-only seam. */
export function __resetUpdateNoticeRefreshLockForTests(): void {
  refreshStarted = false;
}

/** Appends the nudge to the server's base instructions as a single extra line. */
export function buildServerInstructions(baseInstructions: string, nudge: string | null): string {
  return nudge === null ? baseInstructions : `${baseInstructions}\n${nudge}`;
}
