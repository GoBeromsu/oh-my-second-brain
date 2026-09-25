import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

/** mkdir honours the umask, so the private mode is applied explicitly afterwards. */
export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writePrivate(target: string, content: Uint8Array | string): Promise<void> {
  await atomicWrite(target, content);
  await chmod(target, 0o600);
}
