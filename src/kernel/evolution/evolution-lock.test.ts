import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEvolutionEvents } from "./events.js";
import { reclaimEvolutionLock, withEvolutionLock, type LockDeps, type LockOwner } from "./evolution-lock.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-lock-")));
  root = join(base, "home", ".oms", "vaults");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const directory = (): string => join(root, `.${ID}.state`, "evolution");
const lockPath = (): string => join(directory(), "lock");
const NOW = 1_000_000_000;
const deps = (overrides: Partial<LockDeps> = {}): Partial<LockDeps> => ({ now: () => NOW, pid: 4242, host: "here", isPidAlive: () => true, ...overrides });

async function placeLock(owner: LockOwner | string): Promise<string> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const text = typeof owner === "string" ? owner : JSON.stringify(owner);
  await writeFile(lockPath(), text, { mode: 0o600 });
  return text;
}

describe("withEvolutionLock", () => {
  it("holds a private lock with its owner during the action and removes it after", async () => {
    const seen = await withEvolutionLock(root, ID, async () => {
      expect((await stat(lockPath())).mode & 0o777).toBe(0o600);
      return JSON.parse(await readFile(lockPath(), "utf8")) as unknown;
    }, deps());
    expect(seen).toEqual({ pid: 4242, host: "here", startedAt: NOW });
    await expect(stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the lock when the action throws", async () => {
    await expect(withEvolutionLock(root, ID, async () => { throw new Error("boom"); }, deps())).rejects.toThrow("boom");
    await expect(stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a live lock as busy and leaves it", async () => {
    const text = await placeLock({ pid: 7, host: "here", startedAt: NOW - 1000 });
    let ran = false;
    await expect(withEvolutionLock(root, ID, async () => { ran = true; }, deps())).rejects.toThrow(/^EVOLUTION_LOCK_BUSY:/);
    expect(ran).toBe(false);
    expect(await readFile(lockPath(), "utf8")).toBe(text);
  });

  it("reports a lock from a fresh foreign host as busy", async () => {
    await placeLock({ pid: 7, host: "elsewhere", startedAt: NOW - 1000 });
    await expect(withEvolutionLock(root, ID, async () => undefined, deps({ isPidAlive: () => false }))).rejects.toThrow(/^EVOLUTION_LOCK_BUSY:/);
  });

  it("reports a dead owner on this host as stale and points at the reclaim op", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW - 1000 });
    await expect(withEvolutionLock(root, ID, async () => undefined, deps({ isPidAlive: () => false }))).rejects.toThrow(/^EVOLUTION_LOCK_STALE:.*oms doctor reclaim-evolution-lock/);
    expect(await stat(lockPath())).toBeTruthy();
  });

  it("reports an old foreign lock as stale", async () => {
    await placeLock({ pid: 7, host: "elsewhere", startedAt: NOW - 11 * 60 * 1000 });
    await expect(withEvolutionLock(root, ID, async () => undefined, deps())).rejects.toThrow(/^EVOLUTION_LOCK_STALE:/);
  });

  it("refuses a lock replaced by a symlink or a directory", async () => {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    await writeFile(join(base, "target"), "{}");
    await symlink(join(base, "target"), lockPath());
    await expect(withEvolutionLock(root, ID, async () => undefined, deps())).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await rm(lockPath());
    await mkdir(lockPath());
    await expect(withEvolutionLock(root, ID, async () => undefined, deps())).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
  });

  it("does not remove a lock another process put in place during the action", async () => {
    const foreign = JSON.stringify({ pid: 9, host: "elsewhere", startedAt: NOW });
    await withEvolutionLock(root, ID, async () => {
      await rm(lockPath());
      await writeFile(lockPath(), foreign, { mode: 0o600 });
    }, deps());
    expect(await readFile(lockPath(), "utf8")).toBe(foreign);
  });
});

describe("reclaimEvolutionLock", () => {
  const approve = async (): Promise<"approve"> => "approve";

  it("is refused off a TTY before anything is read", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW });
    await expect(reclaimEvolutionLock(root, ID, { interactive: false, confirm: approve, deps: deps() })).rejects.toThrow(/^EVOLUTION_RECLAIM_REQUIRES_TTY:/);
    expect(await stat(lockPath())).toBeTruthy();
  });

  it("reports nothing to remove when there is no lock", async () => {
    let asked = false;
    const result = await reclaimEvolutionLock(root, ID, { interactive: true, confirm: async () => { asked = true; return "approve"; }, deps: deps() });
    expect(result).toEqual({ removedOwner: null, removed: false, decision: "approve" });
    expect(asked).toBe(false);
    await expect(stat(directory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses while the owner is alive on this host", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW });
    await expect(reclaimEvolutionLock(root, ID, { interactive: true, confirm: approve, deps: deps() })).rejects.toThrow(/^EVOLUTION_LOCK_HELD:/);
  });

  it("leaves the lock when the owner does not approve", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW });
    await expect(reclaimEvolutionLock(root, ID, { interactive: true, confirm: async () => "reject", deps: deps({ isPidAlive: () => false }) })).rejects.toThrow(/^EVOLUTION_RECLAIM_DECLINED:/);
    expect(await stat(lockPath())).toBeTruthy();
  });

  it("leaves a lock that changed while the owner was asked", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW });
    const changed = JSON.stringify({ pid: 8, host: "here", startedAt: NOW + 1 });
    const confirm = async (): Promise<"approve"> => {
      await writeFile(lockPath(), changed);
      return "approve";
    };
    await expect(reclaimEvolutionLock(root, ID, { interactive: true, confirm, deps: deps({ isPidAlive: () => false }) })).rejects.toThrow(/^EVOLUTION_LOCK_CHANGED:/);
    expect(await readFile(lockPath(), "utf8")).toBe(changed);
  });

  it("removes an approved lock, shows its owner and records the reclaim", async () => {
    const owner = { pid: 7, host: "elsewhere", startedAt: NOW - 5 };
    await placeLock(owner);
    let shown: LockOwner | null = null;
    const result = await reclaimEvolutionLock(root, ID, { interactive: true, confirm: async seen => { shown = seen; return "approve"; }, deps: deps() });
    expect(shown).toEqual(owner);
    expect(result).toEqual({ removedOwner: owner, removed: true, decision: "approve" });
    await expect(stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
    const events = (await readEvolutionEvents(root, ID)).events;
    expect(events).toEqual([{ kind: "lock.reclaimed", at: NOW, detail: { owner } }]);
  });

  it("removes an unparseable lock with an unknown owner", async () => {
    await placeLock("not json");
    const result = await reclaimEvolutionLock(root, ID, { interactive: true, confirm: approve, deps: deps() });
    expect(result).toEqual({ removedOwner: null, removed: true, decision: "approve" });
  });

  it("then lets the next step take the lock", async () => {
    await placeLock({ pid: 7, host: "here", startedAt: NOW });
    await reclaimEvolutionLock(root, ID, { interactive: true, confirm: approve, deps: deps({ isPidAlive: () => false }) });
    expect(await withEvolutionLock(root, ID, async () => "ran", deps())).toBe("ran");
  });
});
