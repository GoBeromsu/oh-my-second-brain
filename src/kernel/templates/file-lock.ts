import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWrite(target: string, content: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface TransactionLockOwner {
  readonly pid: number;
  readonly token: string;
}

export async function acquireTransactionLock(directory: string, lock: string): Promise<string | null> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  let owner: TransactionLockOwner;
  try {
    const parsed = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string") return null;
    owner = parsed;
  } catch {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
    return null;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return null;
  }
  try {
    await writeFile(join(lock, "takeover"), `${process.pid}\n${token}\n`, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOENT")) return null;
    throw error;
  }
  try {
    const claimed = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (claimed.pid !== owner.pid || claimed.token !== owner.token) return null;
  } catch {
    return null;
  }
  const stale = `${lock}.stale.${token}`;
  try {
    await rename(lock, stale);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST")) return null;
    throw error;
  }
  await rm(stale, { recursive: true, force: true });
  return acquireTransactionLock(directory, lock);
}

export async function releaseTransactionLock(lock: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (owner.token !== token || owner.pid !== process.pid) return;
    const released = `${lock}.released.${token}`;
    await rename(lock, released);
    await rm(released, { recursive: true, force: true });
  } catch {
    // A missing or replaced lock is never removed by a non-owner.
  }
}
