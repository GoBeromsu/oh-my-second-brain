import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { VAULT_ID_PATTERN } from "../vault/settings.js";

/**
 * Per-vault state beside the contract store: `<root>/.<id>.state/` with `interview/`,
 * `evolution/` and `generations/`. It sits next to the `<id>` link, never under it or
 * inside a `.<id>.<seq>/` generation, and matches none of the names the seal collects
 * (generations, `.lock`, `.lock.stale-*`, `.link-tmp`, `index.json`), so a seal neither
 * lists nor removes it. Every component from `root` down is checked with lstat before
 * and after creation, and a file is opened with O_NOFOLLOW. Anything that is not what
 * it should be is refused with STATE_DIR_UNSAFE and left exactly as found.
 */

export const STATE_SUBDIRS = ["interview", "evolution", "generations"] as const;
export type StateSubdir = typeof STATE_SUBDIRS[number];

export type UnsafeKind =
  | "symlink"
  | "fifo"
  | "socket"
  | "block-device"
  | "character-device"
  | "file"
  | "directory"
  | "other"
  | "foreign-owner"
  | "shared-writable";

export class StateDirUnsafe extends Error {
  readonly code = "STATE_DIR_UNSAFE";

  constructor(readonly path: string, readonly kind: UnsafeKind) {
    super(`STATE_DIR_UNSAFE: ${path} is unsafe (${kind}); it was left untouched`);
    this.name = "StateDirUnsafe";
  }
}

export function stateDir(root: string, id: string): string {
  if (!VAULT_ID_PATTERN.test(id)) throw new TypeError("CONTRACT_VAULT_ID_INVALID: vault id is not a UUID");
  return join(root, `.${id}.state`);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function kindOf(info: Stats): UnsafeKind {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFIFO()) return "fifo";
  if (info.isSocket()) return "socket";
  if (info.isBlockDevice()) return "block-device";
  if (info.isCharacterDevice()) return "character-device";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

/** Owner and mode checks need POSIX ids; Windows reports neither meaningfully. */
function ownership(path: string, info: Stats): void {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") return;
  if (info.uid !== uid) throw new StateDirUnsafe(path, "foreign-owner");
  if ((info.mode & 0o022) !== 0) throw new StateDirUnsafe(path, "shared-writable");
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function checkDirectory(path: string, info: Stats): void {
  if (!info.isDirectory()) throw new StateDirUnsafe(path, kindOf(info));
  ownership(path, info);
}

/** `root`, then each component below it down to `target`. */
function chain(root: string, target: string): string[] {
  const parts = relative(root, target).split(sep).filter(part => part !== "");
  const out = [root];
  for (const part of parts) out.push(join(out[out.length - 1]!, part));
  return out;
}

async function checkChain(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const info = await statOrNull(path);
    if (info === null) throw new StateDirUnsafe(path, "other");
    checkDirectory(path, info);
  }
}

/**
 * Creates (0700) or verifies `<root>/.<id>.state/<subdir>/` and returns it. Every
 * component is lstat-checked first (not a symlink, a directory, owned by this user,
 * not group- or other-writable), created only when absent, and checked again after
 * creation because Node has no openat to walk by directory handle.
 */
export async function ensureStateDir(root: string, id: string, subdir: StateSubdir = "interview"): Promise<string> {
  const target = join(stateDir(root, id), subdir);
  const paths = chain(root, target);
  for (const [index, path] of paths.entries()) {
    const info = await statOrNull(path);
    if (info !== null) {
      checkDirectory(path, info);
      continue;
    }
    // Only the store root may need parents; everything below it is created one level at a time.
    try {
      if (index === 0) await mkdir(path, { recursive: true, mode: 0o700 });
      else await mkdir(path, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      // Created concurrently by another append: it gets the same checks as one found in place.
      const raced = await statOrNull(path);
      if (raced === null) throw new StateDirUnsafe(path, "other");
      checkDirectory(path, raced);
      continue;
    }
    await chmod(path, 0o700);
  }
  await checkChain(paths);
  return target;
}

/**
 * The same checks as ensureStateDir without creating anything: the directory path when
 * every component exists and is safe, null when one is missing.
 */
export async function existingStateDir(root: string, id: string, subdir: StateSubdir = "interview"): Promise<string | null> {
  const target = join(stateDir(root, id), subdir);
  for (const path of chain(root, target)) {
    const info = await statOrNull(path);
    if (info === null) return null;
    checkDirectory(path, info);
  }
  return target;
}

/** Refuses an existing entry that is not a regular file owned by this user; true when it exists. */
export async function checkStateFile(path: string): Promise<boolean> {
  const info = await statOrNull(path);
  if (info === null) return false;
  if (!info.isFile()) throw new StateDirUnsafe(path, kindOf(info));
  ownership(path, info);
  return true;
}

/**
 * Opens a state file without following a link and without blocking on a FIFO, then
 * confirms through the handle that it is a regular file. `flags` adds to O_NOFOLLOW and
 * O_NONBLOCK; a created file gets 0600. Null when absent and not created.
 */
export async function openStateFile(path: string, flags: number): Promise<FileHandle | null> {
  if (await checkStateFile(path) === false && (flags & constants.O_CREAT) === 0) return null;
  let handle: FileHandle;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    // Replaced between the lstat and the open: a link (ELOOP) or a FIFO without a reader (ENXIO).
    if (code === "ELOOP" || code === "EMLINK") throw new StateDirUnsafe(path, "symlink");
    if (code === "ENXIO") throw new StateDirUnsafe(path, "fifo");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new StateDirUnsafe(path, kindOf(info));
    ownership(path, info);
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
  return handle;
}
