import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory } from "../kernel/contract/fs-private.js";

/**
 * The note write behind MCP `write`. Unlike the private contract store, a note is vault
 * content: its folder is created with the default mode, an overwrite keeps the note's
 * mode and a new note is 0644 under the umask.
 *
 * `expected` is what the judge saw: the previous content, `undefined` for a new note or
 * `null` for a note that existed but could not be read. The target is checked against it
 * again just before the rename, so a note changed or removed after judging is never
 * overwritten with a verdict about other bytes.
 */
export type NoteWriteResult = "written" | "changed" | "vanished";

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Where the target stands now relative to what the judge saw. */
async function drift(target: string, expected: string | undefined | null): Promise<NoteWriteResult | null> {
  if (expected === undefined) {
    try {
      await lstat(target);
      return "changed";
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }
  try {
    if (expected === null) {
      await lstat(target);
      return null;
    }
    return digest(await readFile(target, "utf8")) === digest(expected) ? null : "changed";
  } catch (error) {
    if (isEnoent(error)) return "vanished";
    throw error;
  }
}

export async function atomicWriteNote(target: string, content: string, expected: string | undefined | null): Promise<NoteWriteResult> {
  let mode = 0o644;
  if (expected !== undefined) {
    try {
      mode = (await lstat(target)).mode & 0o777;
    } catch (error) {
      if (isEnoent(error)) return "vanished";
      throw error;
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(content);
      // open() applies the umask; an overwrite restores the note's own mode exactly.
      if (expected !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const moved = await drift(target, expected);
    if (moved !== null) return moved;
    await rename(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
  // The note is published; a failed directory sync must not report the write as failed.
  await syncDirectory(dirname(target)).catch(() => undefined);
  return "written";
}
