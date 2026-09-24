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

  it("never steals a shared lease using only a dead local PID", async () => {
    const item = await fixture();
    roots.push(item.root);
    await mkdir(item.lock, { recursive: true, mode: 0o700 });
    const ownerBytes = JSON.stringify({ pid: 12345, token: "remote-owner" });
    await writeFile(join(item.lock, "owner.json"), ownerBytes);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("owner is gone"), { code: "ESRCH" });
    });
    try {
      const token = await acquireTransactionLock(item.directory, item.lock);
      expect(token).toBeNull();
      expect(kill).not.toHaveBeenCalled();
      await expect(readFile(join(item.lock, "owner.json"), "utf8")).resolves.toBe(ownerBytes);
      await expect(readdir(item.directory)).resolves.toEqual(["lock"]);
      await expect(readdir(item.lock)).resolves.toEqual(["owner.json"]);
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
    await expect(releaseTransactionLock(item.lock, "unverifiable-owner")).rejects.toThrow();
    await expect(readFile(join(item.lock, "owner.json"), "utf8")).resolves.toBe("{malformed");
    await expect(readdir(item.directory)).resolves.toEqual(["lock"]);
  });

  it("treats an already absent lease as released without creating anything", async () => {
    const item = await fixture();
    roots.push(item.root);
    await expect(releaseTransactionLock(item.lock, "absent-owner")).resolves.toBeUndefined();
    expect(await readdir(item.root)).toEqual([]);
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

  it("preserves a directory target and cleans staged bytes when publication fails", async () => {
    const item = await fixture();
    roots.push(item.root);
    const target = join(item.root, "existing-directory");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "user bytes");
    await expect(atomicWrite(target, "replacement")).rejects.toThrow();
    await expect(readFile(join(target, "keep.txt"), "utf8")).resolves.toBe("user bytes");
    await expect(readdir(item.root)).resolves.toEqual(["existing-directory"]);
  });
});
