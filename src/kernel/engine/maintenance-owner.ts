import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { assertExternalCachePath, assertExternalDatabasePath } from "./paths.js";

export interface MaintenanceOwner {
  /** Unique immutable record, never a shared path that a successor replaces. */
  readonly lockPath: string;
  isCurrent(): boolean;
  release(): void;
}

export interface MaintenanceOwnerDeps {
  /** Unknown/throwing liveness always blocks, as does a reused PID. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Deterministic test seam after publication and before contender enumeration. */
  readonly afterPublish?: () => void;
}

interface OwnerRecord { readonly text: string; readonly pid: number; readonly token: string; readonly stat: BigIntStats }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_OWNER_FILES = 4096;

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readOwner(filename: string): OwnerRecord {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 4096n || before.nlink !== 1n) throw new Error("MAINTENANCE_OWNER_UNSAFE: invalid ownership file.");
    const text = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(filename, { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(after, current) || current.isSymbolicLink()) throw new Error("MAINTENANCE_OWNER_CHANGED: ownership file changed while reading.");
    let record: unknown;
    try { record = JSON.parse(text); } catch { throw new Error("MAINTENANCE_OWNER_UNSAFE: corrupt ownership file; do not remove it while its owner may be running."); }
    if (record === null || typeof record !== "object" || !("version" in record) || record.version !== 1
      || !("pid" in record) || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
      || !("token" in record) || typeof record.token !== "string" || !UUID.test(record.token)
      || path.basename(filename) !== `${record.token}.json`) throw new Error("MAINTENANCE_OWNER_UNSAFE: unsupported ownership record.");
    return { text, pid: record.pid as number, token: record.token, stat: after };
  } finally { closeSync(fd); }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (code(error) === "ESRCH") return false; throw error; }
}

function knownDead(pid: number, deps: MaintenanceOwnerDeps): boolean {
  try { return (deps.isPidAlive ?? isPidAlive)(pid) === false; } catch { return false; }
}

/**
 * Cooperative ownership within one host/PID namespace, without live-owner stealing.
 * Publish a unique immutable record BEFORE enumeration. Any live contender
 * causes refusal. Concurrent arrivals may both refuse; neither may steal.
 * Dead records have never-reused names, so reclamation cannot move a successor.
 * This does not fence external directory/record tampering.
 */
export function acquireProcessOwner(directory: string, deps: MaintenanceOwnerDeps = {}): MaintenanceOwner {
  mkdirSync(directory, { recursive: true });
  const directoryIdentity = lstatSync(directory, { bigint: true });
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) throw new Error("MAINTENANCE_OWNER_UNSAFE: ownership directory must be a real directory.");
  const token = randomUUID();
  const lockPath = path.join(directory, `${token}.json`);
  const temporary = path.join(directory, `.claim-${process.pid}-${token}.tmp`);
  const text = JSON.stringify({ version: 1, pid: process.pid, token });
  let fd: number | undefined;
  let claimed: OwnerRecord | undefined;
  const current = (): boolean => {
    try {
      const dir = lstatSync(directory, { bigint: true });
      const now = readOwner(lockPath);
      return claimed !== undefined && dir.dev === directoryIdentity.dev && dir.ino === directoryIdentity.ino
        && !dir.isSymbolicLink() && now.text === text && sameIdentity(claimed.stat, now.stat);
    } catch { return false; }
  };
  const removeOwn = (): void => { if (current()) unlinkSync(lockPath); };
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, lockPath); unlinkSync(temporary);
    claimed = readOwner(lockPath);
    deps.afterPublish?.();
    const names = readdirSync(directory);
    if (names.length > MAX_OWNER_FILES) throw new Error("MAINTENANCE_OWNER_UNSAFE: too many ownership records; inspect stopped processes before recovery.");
    for (const name of names) {
      if (name === `${token}.json`) continue;
      const filename = path.join(directory, name);
      const pending = /^\.claim-([1-9][0-9]*)-([a-f0-9-]{36})\.tmp$/u.exec(name);
      if (pending !== null) {
        if (!UUID.test(pending[2]!)) throw new Error("MAINTENANCE_OWNER_UNSAFE: invalid pending token.");
        let info;
        try { info = lstatSync(filename); } catch (error) { if (code(error) === "ENOENT") continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("MAINTENANCE_OWNER_UNSAFE: invalid pending record.");
        // A not-yet-published claimant must still enumerate us before success.
        // Crash leftovers are unique to that dead process and are safe to prune.
        if (knownDead(Number(pending[1]), deps)) {
          try { unlinkSync(filename); } catch (error) { if (code(error) !== "ENOENT") throw error; }
        }
        continue;
      }
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) throw new Error("MAINTENANCE_OWNER_UNSAFE: unknown ownership entry.");
      let previous: OwnerRecord;
      try { previous = readOwner(filename); } catch (error) { if (code(error) === "ENOENT") continue; throw error; }
      if (!knownDead(previous.pid, deps)) throw new Error("MAINTENANCE_OWNER_BUSY: another live or unprobeable process owns this vault; paused owners are not replaced.");
      // No cooperative successor ever writes this UUID path. Competing cleaners
      // can only observe ENOENT; there is no shared check-then-rename path.
      try { unlinkSync(filename); } catch (error) { if (code(error) !== "ENOENT") throw error; }
    }
    if (!current()) throw new Error("MAINTENANCE_OWNER_CHANGED: ownership changed during acquisition.");
    let released = false;
    return {
      lockPath,
      isCurrent: () => !released && current(),
      release() { if (released) return; released = true; removeOwn(); },
    };
  } catch (error) { removeOwn(); throw error; }
  finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
}

/** Maintenance and short database writers use distinct ownership directories. */
export function acquireMaintenanceOwner(vault: string, dbPath: string, deps: MaintenanceOwnerDeps = {}): MaintenanceOwner {
  assertExternalDatabasePath(vault, dbPath);
  return acquireProcessOwner(assertExternalCachePath(vault, `${dbPath}.maintenance.owners`), deps);
}
