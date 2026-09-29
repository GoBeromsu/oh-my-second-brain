import { constants } from "node:fs";
import { open, rename, rm, symlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensureStateDir, existingStateDir, checkStateFile, openStateFile } from "../contract/state-dir.js";
import { lockIsStale, pidAlive } from "../contract/store.js";
import type { HumanDecision } from "./decision.js";
import { appendEvolutionEvent } from "./events.js";

/**
 * The evolution lock: `<root>/.<id>.state/evolution/lock`, created with
 * O_CREAT|O_EXCL|O_NOFOLLOW (0600) and holding `{pid, host, startedAt}`. It serializes
 * the evolution loop (request state, verdicts, the seal-gate) for one vault and is always
 * taken before the seal lock, never after it.
 *
 * A lock whose owner is gone (same host, dead pid) or that is older than the seal lock's
 * stale age is reported with EVOLUTION_LOCK_STALE and never taken over silently: only
 * `oms doctor reclaim-evolution-lock`, on a TTY and with the owner's approval, removes it.
 * An existing entry that is not a regular file is refused with STATE_DIR_UNSAFE.
 */

export const EVOLUTION_LOCK_FILE = "lock";
const MAX_OWNER_BYTES = 4096;

export interface LockDeps {
  readonly now: () => number;
  readonly pid: number;
  readonly host: string;
  readonly isPidAlive: (pid: number) => boolean;
}

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
}

function lockDeps(overrides: Partial<LockDeps>): LockDeps {
  return { now: Date.now, pid: process.pid, host: hostname(), isPidAlive: pidAlive, ...overrides };
}

class EvolutionLockError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EvolutionLockError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

async function createLock(path: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function readLockText(path: string): Promise<string | null> {
  const handle = await openStateFile(path, constants.O_RDONLY);
  if (handle === null) return null;
  try {
    if ((await handle.stat()).size > MAX_OWNER_BYTES) return "";
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseOwner(text: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const owner = value as Record<string, unknown>;
    if (typeof owner.pid !== "number" || typeof owner.host !== "string" || typeof owner.startedAt !== "number") return null;
    return { pid: owner.pid, host: owner.host, startedAt: owner.startedAt };
  } catch {
    return null;
  }
}

/**
 * Runs `action` holding the evolution lock and removes the lock afterwards, but only
 * while it still holds what this call wrote.
 */
export async function withEvolutionLock<T>(root: string, vaultId: string, action: () => Promise<T>, overrides: Partial<LockDeps> = {}): Promise<T> {
  const deps = lockDeps(overrides);
  const directory = await ensureStateDir(root, vaultId, "evolution");
  const path = join(directory, EVOLUTION_LOCK_FILE);
  const text = JSON.stringify({ pid: deps.pid, host: deps.host, startedAt: deps.now() });
  await checkStateFile(path);
  // The holder may release between a failed create and the check; try once more then.
  if (!await createLock(path, text) && (await checkStateFile(path) || !await createLock(path, text))) {
    if (await lockIsStale(path, { ...deps, fs: { rename, symlink, rm } })) {
      throw new EvolutionLockError("EVOLUTION_LOCK_STALE", `a stale evolution lock remains at ${path}; run \`oms doctor reclaim-evolution-lock\` in a terminal to remove it`);
    }
    throw new EvolutionLockError("EVOLUTION_LOCK_BUSY", "another evolution step is in progress for this vault; try again later");
  }
  try {
    return await action();
  } finally {
    if (await readLockText(path) === text) await rm(path, { force: true });
  }
}

export interface ReclaimOptions {
  /** True only on a TTY. */
  readonly interactive: boolean;
  /** Asks the owner; shown the lock's owner (null when it does not parse). */
  readonly confirm: (owner: LockOwner | null) => Promise<HumanDecision>;
  readonly deps?: Partial<LockDeps>;
}

export interface ReclaimResult {
  /** The owner of the removed lock; null when there was no lock or its owner did not parse. */
  readonly removedOwner: LockOwner | null;
  readonly removed: boolean;
  readonly decision: HumanDecision;
}

/**
 * The owner-approved removal of an evolution lock. Refused off a TTY
 * (EVOLUTION_RECLAIM_REQUIRES_TTY) and while the owner is alive on this host
 * (EVOLUTION_LOCK_HELD). The lock is removed only when it still holds what was shown.
 */
export async function reclaimEvolutionLock(root: string, vaultId: string, options: ReclaimOptions): Promise<ReclaimResult> {
  if (!options.interactive) throw new EvolutionLockError("EVOLUTION_RECLAIM_REQUIRES_TTY", "reclaiming the evolution lock needs the owner at a terminal; run `oms doctor reclaim-evolution-lock` in one");
  const deps = lockDeps(options.deps ?? {});
  const directory = await existingStateDir(root, vaultId, "evolution");
  const path = directory === null ? null : join(directory, EVOLUTION_LOCK_FILE);
  const shown = path === null ? null : await readLockText(path);
  if (path === null || shown === null) return { removedOwner: null, removed: false, decision: "approve" };
  const owner = parseOwner(shown);
  if (owner !== null && owner.host === deps.host && deps.isPidAlive(owner.pid)) {
    throw new EvolutionLockError("EVOLUTION_LOCK_HELD", `process ${owner.pid} on this host still holds the evolution lock; let it finish`);
  }
  const decision = await options.confirm(owner);
  if (decision !== "approve") throw new EvolutionLockError("EVOLUTION_RECLAIM_DECLINED", "the owner did not approve; the lock was left in place");
  if (await readLockText(path) !== shown) throw new EvolutionLockError("EVOLUTION_LOCK_CHANGED", "the lock changed while you were asked; nothing was removed, run the command again");
  await rm(path, { force: true });
  await appendEvolutionEvent(root, vaultId, { kind: "lock.reclaimed", at: deps.now(), detail: { owner } });
  return { removedOwner: owner, removed: true, decision };
}
