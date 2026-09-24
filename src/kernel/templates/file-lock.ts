import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";


/** Shared cooperative writer lease. Installed old binaries do not coordinate through it. */
export const VAULT_PUBLICATION_LEASE = ".oms/.template-transactions/vault-lock/lease";
export async function atomicWrite(target: string, content: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Durability errors are not downgraded to a successful publication. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
    const owner = await open(join(lock, "owner.json"), "wx", 0o600);
    try {
      await owner.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
      await owner.sync();
    } finally {
      await owner.close();
    }
    await syncDirectory(lock);
    await syncDirectory(directory);
    return token;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  // A shared vault can carry another machine's PID. Absence in this process table
  // is not proof of abandonment; breaking an existing lease requires explicit recovery.
  return null;
}

export async function releaseTransactionLock(lock: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as TransactionLockOwner;
    if (owner.token !== token || owner.pid !== process.pid) return;
    const released = `${lock}.released.${token}`;
    await rename(lock, released);
    await rm(released, { recursive: true, force: true });
    await syncDirectory(dirname(lock));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // An already absent lock needs no release; other durability failures remain visible.
  }
}
