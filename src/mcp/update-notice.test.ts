import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  cachedUpdateNotice,
  refreshUpdateNoticeCache,
  updateNoticeCachePath,
} from "./update-notice.js";
import type { UpdateRunnerCall } from "../update/update.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

async function stateDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "oms-update-notice-"));
}

async function seedCache(dir: string, cache: unknown): Promise<void> {
  await writeFile(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), JSON.stringify(cache), "utf-8");
}

function freshStableCache(latestVersion: string, checkedAt = NOW - 60_000): unknown {
  return { version: 1, channels: { stable: { latestVersion, checkedAt } } };
}

function okCall(stdout: string): UpdateRunnerCall {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("cachedUpdateNotice", () => {
  it("returns one nudge line when a fresh cache holds a newer version", async () => {
    // Given: a fresh stable-channel cache advertising a newer version
    const dir = await stateDir();
    try {
      await seedCache(dir, freshStableCache("0.9.9"));

      // When: the boot path reads the cache
      const notice = cachedUpdateNotice({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
      });

      // Then: exactly one nudge line naming both versions is returned
      expect(notice).not.toBeNull();
      expect(notice?.split("\n")).toHaveLength(1);
      expect(notice).toContain("0.1.9");
      expect(notice).toContain("0.9.9");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the cached check is older than the 24h TTL", async () => {
    // Given: a stable cache stamped 25 hours ago
    const dir = await stateDir();
    try {
      await seedCache(dir, freshStableCache("0.9.9", NOW - DAY_MS - 3_600_000));

      // When: the boot path reads the cache
      const notice = cachedUpdateNotice({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
      });

      // Then: stale state produces no nudge
      expect(notice).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the cache file is missing", async () => {
    // Given: an empty state dir
    const dir = await stateDir();
    try {
      // When/Then: a missing cache yields no nudge
      expect(
        cachedUpdateNotice({
          installedVersion: "0.1.9",
          env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
          now: NOW,
        }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null without throwing when the cache JSON is corrupt or fields are missing", async () => {
    // Given: a corrupt cache, then a structurally wrong one
    const dir = await stateDir();
    try {
      await writeFile(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), "{not json", "utf-8");

      // When/Then: malformed input degrades to null, never an exception
      expect(() =>
        cachedUpdateNotice({ installedVersion: "0.1.9", env: { OMS_AUTO_UPDATE_STATE_DIR: dir }, now: NOW }),
      ).not.toThrow();
      expect(
        cachedUpdateNotice({ installedVersion: "0.1.9", env: { OMS_AUTO_UPDATE_STATE_DIR: dir }, now: NOW }),
      ).toBeNull();

      await seedCache(dir, { version: 1, channels: { stable: { latestVersion: 42 } } });
      expect(
        cachedUpdateNotice({ installedVersion: "0.1.9", env: { OMS_AUTO_UPDATE_STATE_DIR: dir }, now: NOW }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the cached version is not newer than the installed one", async () => {
    // Given: a fresh cache whose latest equals the installed version
    const dir = await stateDir();
    try {
      await seedCache(dir, freshStableCache("0.1.9"));

      // When/Then: an up-to-date install gets no nudge
      expect(
        cachedUpdateNotice({ installedVersion: "0.1.9", env: { OMS_AUTO_UPDATE_STATE_DIR: dir }, now: NOW }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let a fresh stable stamp make an older prerelease channel look fresh", async () => {
    // Given: a fresh stable stamp alongside a 30h-old prerelease stamp
    const dir = await stateDir();
    try {
      await seedCache(dir, {
        version: 1,
        channels: {
          stable: { latestVersion: "0.9.9", checkedAt: NOW - 60_000 },
          prerelease: { latestVersion: "0.9.9", checkedAt: NOW - 30 * 60 * 60 * 1000 },
        },
      });

      // When: a prerelease install reads the cache
      const notice = cachedUpdateNotice({
        installedVersion: "0.2.0-beta.1",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
      });

      // Then: the stale prerelease stamp governs, so no nudge
      expect(notice).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when either suppression env is set", async () => {
    // Given: a fresh cache with a newer version
    const dir = await stateDir();
    try {
      await seedCache(dir, freshStableCache("0.9.9"));

      // When/Then: both documented suppression switches silence the nudge
      expect(
        cachedUpdateNotice({
          installedVersion: "0.1.9",
          env: { OMS_AUTO_UPDATE_STATE_DIR: dir, OMS_UPDATE_NOTICE: "0" },
          now: NOW,
        }),
      ).toBeNull();
      expect(
        cachedUpdateNotice({
          installedVersion: "0.1.9",
          env: { OMS_AUTO_UPDATE_STATE_DIR: dir, OMS_NO_UPDATE_NOTICE: "1" },
          now: NOW,
        }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshUpdateNoticeCache", () => {
  it("writes the queried version under the installed channel stamp", async () => {
    // Given: an empty state dir and a registry runner answering 0.9.9
    const dir = await stateDir();
    try {
      // When: one bounded refresh runs
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => okCall("0.9.9"),
      });

      // Then: the cache records the version and the stamp for the stable channel only
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

  it("preserves the other channel's stamp when refreshing one channel", async () => {
    // Given: a cache holding a prerelease stamp from an earlier run
    const dir = await stateDir();
    try {
      const priorPrerelease = { latestVersion: "0.3.0-beta.2", checkedAt: NOW - 5_000 };
      await seedCache(dir, { version: 1, channels: { prerelease: priorPrerelease } });

      // When: a stable install refreshes
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => okCall("0.9.9"),
      });

      // Then: the untouched channel keeps its own stamp
      const cache: unknown = JSON.parse(
        await readFile(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), "utf-8"),
      );
      expect(cache).toEqual({
        version: 1,
        channels: {
          prerelease: priorPrerelease,
          stable: { latestVersion: "0.9.9", checkedAt: NOW },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails open and writes nothing when the registry query fails", async () => {
    // Given: a runner that reports a failed registry query
    const dir = await stateDir();
    try {
      // When: the refresh runs
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => ({ exitCode: 1, stdout: "", stderr: "offline" }),
      });

      // Then: no cache file is produced and no error escapes
      await expect(
        readFile(updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }), "utf-8"),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the cache untouched when another process holds the write lock", async () => {
    // Given: a stale cache and a lock file already held by another process
    const dir = await stateDir();
    try {
      const cachePath = updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir });
      await seedCache(dir, freshStableCache("0.5.0", NOW - 10_000));
      await writeFile(`${cachePath}.lock`, "", "utf-8");

      // When: this process refreshes while the lock is held
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => okCall("0.9.9"),
      });

      // Then: the loser skips the write instead of corrupting the cache
      const cache: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
      expect(cache).toEqual(freshStableCache("0.5.0", NOW - 10_000));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a lock left behind by a dead process once it is older than the TTL", async () => {
    // Given: a lock file whose mtime is two days old
    const dir = await stateDir();
    try {
      const cachePath = updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir });
      const lockPath = `${cachePath}.lock`;
      await writeFile(lockPath, "", "utf-8");
      const staleTime = new Date(Date.now() - 2 * DAY_MS);
      await utimes(lockPath, staleTime, staleTime);

      // When: a refresh runs
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => okCall("0.9.9"),
      });

      // Then: the orphan lock did not block the write
      const cache: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
      expect(cache).toEqual({
        version: 1,
        channels: { stable: { latestVersion: "0.9.9", checkedAt: NOW } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not query the registry when notices are suppressed", async () => {
    // Given: suppression env set and a runner that records calls
    const dir = await stateDir();
    const calls: string[] = [];
    try {
      // When: the refresh runs
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir, OMS_UPDATE_NOTICE: "0" },
        now: NOW,
        runner: (command, args) => {
          calls.push([command, ...args].join(" "));
          return okCall("0.9.9");
        },
      });

      // Then: the network seam was never touched
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes no stdout while reading the cache and refreshing", async () => {
    // Given: stdout capture around a cache read plus a refresh
    const dir = await stateDir();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      await seedCache(dir, freshStableCache("0.9.9"));

      // When: both surfaces run
      cachedUpdateNotice({ installedVersion: "0.1.9", env: { OMS_AUTO_UPDATE_STATE_DIR: dir }, now: NOW });
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
        now: NOW,
        runner: () => okCall("0.9.9"),
      });

      // Then: the JSON-RPC transport stream stayed untouched
      expect(chunks).toEqual([]);
    } finally {
      process.stdout.write = originalWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
