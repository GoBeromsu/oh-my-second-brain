import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTransactionLock, atomicWrite, releaseTransactionLock } from "./file-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly directory: string; readonly lock: string }> {
  const root = await mkdtemp(join(tmpdir(), "oms-file-lock-"));
  const directory = join(root, "transactions");
  return { root, directory, lock: join(directory, "lock") };
}

describe("template file lock", () => {
  it("allows one exclusive owner and blocks competing callers until release", async () => {
    const item = await fixture();
    roots.push(item.root);
    const results = await Promise.all([
      acquireTransactionLock(item.directory, item.lock),
      acquireTransactionLock(item.directory, item.lock),
    ]);
    const acquired = results.filter((token): token is string => token !== null);
    expect(acquired).toHaveLength(1);
    expect(results.filter(token => token === null)).toHaveLength(1);

    const token = acquired[0]!;
    await releaseTransactionLock(item.lock, token);
    const next = await acquireTransactionLock(item.directory, item.lock);
    expect(next).toEqual(expect.any(String));
    await releaseTransactionLock(item.lock, next!);
    await expect(readdir(item.directory)).resolves.toEqual([]);
  });

  it("does not release a lock for a wrong token", async () => {
    const item = await fixture();
    roots.push(item.root);
    const token = await acquireTransactionLock(item.directory, item.lock);
    expect(token).toEqual(expect.any(String));

    await releaseTransactionLock(item.lock, "wrong-token");
    await expect(readFile(join(item.lock, "owner.json"), "utf8")).resolves.toContain(token!);
    await expect(acquireTransactionLock(item.directory, item.lock)).resolves.toBeNull();

    await releaseTransactionLock(item.lock, token!);
    await expect(readdir(item.directory)).resolves.toEqual([]);
  });

  it("takes over a lock whose owner is dead", async () => {
    const item = await fixture();
    roots.push(item.root);
    await mkdir(item.lock, { recursive: true, mode: 0o700 });
    await writeFile(join(item.lock, "owner.json"), JSON.stringify({ pid: 12345, token: "dead-owner" }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("owner is gone"), { code: "ESRCH" });
    });
    try {
      const token = await acquireTransactionLock(item.directory, item.lock);
      expect(token).toEqual(expect.any(String));
      await expect(readFile(join(item.lock, "owner.json"), "utf8")).resolves.toContain(token!);
      await releaseTransactionLock(item.lock, token!);
    } finally {
      kill.mockRestore();
    }
  });

  it("fails closed when lock ownership is malformed", async () => {
    const item = await fixture();
    roots.push(item.root);
    await mkdir(item.lock, { recursive: true, mode: 0o700 });
    await writeFile(join(item.lock, "owner.json"), "{malformed");

    await expect(acquireTransactionLock(item.directory, item.lock)).resolves.toBeNull();
    await expect(readFile(join(item.lock, "owner.json"), "utf8")).resolves.toBe("{malformed");
    await expect(readdir(item.directory)).resolves.toEqual(["lock"]);
  });

  it("publishes atomic writes and cleans up each temporary file", async () => {
    const item = await fixture();
    roots.push(item.root);
    const target = join(item.root, "nested", "payload.txt");

    await atomicWrite(target, "first");
    await expect(readFile(target, "utf8")).resolves.toBe("first");
    await expect(readdir(dirname(target))).resolves.toEqual(["payload.txt"]);

    await Promise.all([atomicWrite(target, "second"), atomicWrite(target, "third")]);
    await expect(readFile(target, "utf8")).resolves.toMatch(/^(second|third)$/);
    await expect(readdir(dirname(target))).resolves.toEqual(["payload.txt"]);
  });
});
