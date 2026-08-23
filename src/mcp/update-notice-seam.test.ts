import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const registryCalls: string[] = [];

vi.mock("../kernel/update/update.js", async () => {
  const actual = await vi.importActual<typeof import("../kernel/update/update.js")>("../kernel/update/update.js");
  return {
    ...actual,
    resolveLatestVersion: async (options: { readonly packageName: string }) => {
      registryCalls.push(options.packageName);
      return { ok: true as const, version: "99.0.0" };
    },
  };
});

const { cachedUpdateNotice, refreshUpdateNoticeCache, updateNoticeCachePath } = await import(
  "./update-notice.js"
);

afterEach(() => {
  registryCalls.length = 0;
});

describe("update notice network seam", () => {
  it("reads the cache without touching the registry seam", async () => {
    // Given: a fresh cache holding a newer version
    const dir = await mkdtemp(path.join(tmpdir(), "oms-notice-seam-"));
    try {
      await writeFile(
        updateNoticeCachePath({ OMS_AUTO_UPDATE_STATE_DIR: dir }),
        JSON.stringify({
          version: 1,
          channels: { stable: { latestVersion: "99.0.0", checkedAt: Date.now() } },
        }),
        "utf-8",
      );

      // When: the boot-time cache read runs
      const notice = cachedUpdateNotice({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
      });

      // Then: a nudge is produced and the registry was never queried
      expect(notice).toContain("99.0.0");
      expect(registryCalls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queries the registry seam exactly once per refresh", async () => {
    // Given: an empty state dir
    const dir = await mkdtemp(path.join(tmpdir(), "oms-notice-seam-refresh-"));
    try {
      // When: the background refresh runs
      await refreshUpdateNoticeCache({
        installedVersion: "0.1.9",
        env: { OMS_AUTO_UPDATE_STATE_DIR: dir },
      });

      // Then: the registry was queried once, for the shipped package
      expect(registryCalls).toEqual(["oh-my-second-brain"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
