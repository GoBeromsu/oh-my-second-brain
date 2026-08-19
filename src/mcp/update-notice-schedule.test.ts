import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  __resetUpdateNoticeRefreshLockForTests,
  scheduleUpdateNoticeRefresh,
  updateNoticeCachePath,
} from "./update-notice.js";
import type { UpdateRunnerCall } from "../update/update.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/**
 * Records every registry query the scheduler triggers. The runner is the only
 * network seam `refreshUpdateNoticeCache` can reach, so an empty log proves no
 * refresh ran — no clock, no sleep, no polling involved.
 */
function recordingRunner(calls: string[]): () => UpdateRunnerCall {
  return () => {
    calls.push("npm view");
    return { exitCode: 0, stdout: "0.9.9", stderr: "" };
  };
}

async function stateDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `oms-notice-schedule-${prefix}-`));
}

async function seedStableCache(dir: string, checkedAt: number): Promise<void> {
  await writeFile(
    updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }),
    JSON.stringify({ version: 1, channels: { stable: { latestVersion: "0.5.0", checkedAt } } }),
    "utf-8",
  );
}

afterEach(() => {
  __resetUpdateNoticeRefreshLockForTests();
});

describe("scheduleUpdateNoticeRefresh", () => {
  it("schedules no refresh when the installed channel's cache is within the TTL", async () => {
    // Given: a stable cache stamped one minute ago
    const dir = await stateDir("fresh");
    const calls: string[] = [];
    try {
      await seedStableCache(dir, NOW - 60_000);

      // When: the serve path schedules a refresh
      const scheduled = scheduleUpdateNoticeRefresh({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: recordingRunner(calls),
      });
      await scheduled;

      // Then: nothing was scheduled and the registry was never queried
      expect(scheduled).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("schedules exactly one refresh when the cache is past the TTL", async () => {
    // Given: a stable cache stamped 25 hours ago
    const dir = await stateDir("stale");
    const calls: string[] = [];
    try {
      await seedStableCache(dir, NOW - DAY_MS - 3_600_000);

      // When: the serve path schedules a refresh and it settles
      await scheduleUpdateNoticeRefresh({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: recordingRunner(calls),
      });

      // Then: one registry query ran and the stamp was rewritten
      expect(calls).toEqual(["npm view"]);
      const cache: unknown = JSON.parse(
        await readFile(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), "utf-8"),
      );
      expect(cache).toEqual({
        version: 1,
        channels: { stable: { latestVersion: "0.9.9", checkedAt: NOW } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("schedules one refresh when no cache file exists at all", async () => {
    // Given: an empty state dir
    const dir = await stateDir("missing");
    const calls: string[] = [];
    try {
      // When: the serve path schedules a refresh and it settles
      await scheduleUpdateNoticeRefresh({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: recordingRunner(calls),
      });

      // Then: the missing cache counts as stale, so exactly one query ran
      expect(calls).toEqual(["npm view"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a fresh stamp on the other channel as stale for the installed channel", async () => {
    // Given: a fresh stable stamp while the install is on the prerelease channel
    const dir = await stateDir("channel");
    const calls: string[] = [];
    try {
      await seedStableCache(dir, NOW - 60_000);

      // When: a prerelease install schedules a refresh
      await scheduleUpdateNoticeRefresh({
        installedVersion: "0.2.0-beta.1",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: recordingRunner(calls),
      });

      // Then: freshness is per channel, so the prerelease refresh still ran
      expect(calls).toEqual(["npm view"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes at most once per process even when called again", async () => {
    // Given: a stale cache and a first scheduled refresh that already settled
    const dir = await stateDir("lock");
    const calls: string[] = [];
    try {
      await seedStableCache(dir, NOW - DAY_MS - 3_600_000);
      const options = {
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: recordingRunner(calls),
      } as const;
      await scheduleUpdateNoticeRefresh(options);

      // When: a second boot-path call happens in the same process
      const second = scheduleUpdateNoticeRefresh(options);
      await second;

      // Then: the per-process lock made it a no-op
      expect(second).toBeNull();
      expect(calls).toEqual(["npm view"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("schedules no refresh when notices are suppressed", async () => {
    // Given: a missing cache but suppression env set
    const dir = await stateDir("suppressed");
    const calls: string[] = [];
    try {
      // When: the serve path schedules a refresh
      const scheduled = scheduleUpdateNoticeRefresh({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir, OMS_UPDATE_NOTICE: "0" },
        now: NOW,
        runner: recordingRunner(calls),
      });
      await scheduled;

      // Then: suppression short-circuits before the network seam
      expect(scheduled).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
