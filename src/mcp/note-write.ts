import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory } from "../kernel/contract/fs-private.js";

/**
 * The note write behind MCP `write`. Unlike the private contract store, a note is vault
 * content: its folder is created with the default mode, an overwrite keeps the note's
 * mode and a new note is 0644 under the umask.
 *
 * `expected` is what the judge saw: the previous content, `undefined` for a new note or
 * `null` for a note that existed but could not be read. The target is checked against it
 * again just before publishing, so a note changed or removed after judging is not
 * overwritten with a verdict about other bytes.
 *
 * A new note is published with link(), which fails with EEXIST instead of replacing a
 * note that appeared after the last check, so a concurrent writer is never clobbered.
 * When the filesystem cannot hard-link (EPERM, ENOTSUP, EXDEV, ENOSYS), the note falls
 * back to a final lstat and rename(); a note created between that lstat and the rename
 * is then replaced. An overwrite always uses the digest check and rename(): there is no
 * compare-and-swap for a path, so a change landing between the check and the rename is
 * replaced. Both windows are the few syscalls between the check and the publish.
 *
 * A new note is first written to `<note>.<pid>.<uuid>.tmp` beside it. A crash between
 * link() and the removal of that temporary leaves it behind as a second hard link to the
 * published note; nothing sweeps it, so it stays until removed by hand.
 */
export type NoteWriteResult = "written" | "changed" | "vanished";

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

const NO_HARD_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

export interface NoteWriteDeps {
  readonly link: (existing: string, created: string) => Promise<void>;
  /** Runs after the last drift check, just before publishing; tests use it to race the write. */
  readonly beforePublish: () => Promise<void>;
}

function noteWriteDeps(overrides: Partial<NoteWriteDeps>): NoteWriteDeps {
  return { link, beforePublish: async () => undefined, ...overrides };
}

/** Publishes a new note without replacing one that appeared meanwhile; null once published. */
async function publishNew(temporary: string, target: string, deps: NoteWriteDeps): Promise<NoteWriteResult | null> {
  try {
    await deps.link(temporary, target);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") return "changed";
    if (code === undefined || !NO_HARD_LINK.has(code)) throw error;
  }
  const moved = await drift(target, undefined);
  if (moved !== null) return moved;
  await rename(temporary, target);
  return null;
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

export async function atomicWriteNote(target: string, content: string, expected: string | undefined | null, overrides: Partial<NoteWriteDeps> = {}): Promise<NoteWriteResult> {
  const deps = noteWriteDeps(overrides);
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
    await deps.beforePublish();
    if (expected === undefined) {
      const raced = await publishNew(temporary, target, deps);
      if (raced !== null) return raced;
    } else await rename(temporary, target);
  } finally {
    // After link() the temporary is a second name for the note; after rename() it is gone.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  // The note is published; a failed directory sync must not report the write as failed.
  await syncDirectory(dirname(target)).catch(() => undefined);
  return "written";
}
