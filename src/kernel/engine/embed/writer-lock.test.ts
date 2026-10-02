import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireEngineStoreWriterLock } from "./sync.js";

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: vi.fn(original.renameSync), readFileSync: vi.fn(original.readFileSync) };
});
let root: string;
let dbPath: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), "oms-writer-lock-")); dbPath = path.join(root, "engine.sqlite"); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("blocks a third writer during the legacy stale-reclaimer pathname gap", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const lockPath = `${dbPath}.lock`;
  fs.writeFileSync(lockPath, "999999999\ndead owner\n");
  const successor = `${process.pid}\nlive successor\n`;
  let thirdRelease: (() => void) | undefined;
  let thirdError: unknown;
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    // Deterministic stale-read schedule: the fixed pathname was observed dead,
    // then changed to a live successor before the old rename-based recovery.
    fs.writeFileSync(lockPath, successor);
    original.renameSync(from, to);
    expect(fs.existsSync(lockPath)).toBe(false);
    try { thirdRelease = acquireEngineStoreWriterLock(dbPath); }
    catch (error) { thirdError = error; }
  });
  try {
    expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/lock|already in progress/i);
    expect(thirdRelease).toBeUndefined();
    expect(thirdError).toBeInstanceOf(Error);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(successor);
  } finally { thirdRelease?.(); }
});

it("releases unique ownership after a legacy live owner blocks acquisition", () => {
  fs.writeFileSync(`${dbPath}.lock`, `${process.pid}\nlegacy owner\n`);
  expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/already in progress|lock/i);
  fs.writeFileSync(`${dbPath}.lock`, "999999999\ndead owner\n");
  const release = acquireEngineStoreWriterLock(dbPath);
  expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/already in progress|lock/i);
  release(); release();
  const next = acquireEngineStoreWriterLock(dbPath);
  next();
});

it("fails closed on an unsafe ownership directory without touching a legacy lock", () => {
  const directory = `${dbPath}.writer.owners`;
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "unknown-file"), "do not treat this as a dead owner");
  fs.writeFileSync(`${dbPath}.lock`, "999999999\ndead owner\n");
  expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/writer lock unavailable.*MAINTENANCE_OWNER_UNSAFE/);
  expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe("999999999\ndead owner\n");
});

it.each(["", "not-a-pid\n", "0\n", "-1\n", "999999999999999999999999\n"])("refuses legacy owner %j without reclaiming it", contents => {
  fs.writeFileSync(`${dbPath}.lock`, contents);
  expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/invalid owner PID/);
  expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(contents);
  expect(fs.readdirSync(`${dbPath}.writer.owners`)).toEqual([]);
});

it("fails on an unreadable legacy owner instead of moving/restoring it forever", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const lockPath = `${dbPath}.lock`;
  fs.writeFileSync(lockPath, "999999999\ndead owner\n");
  vi.mocked(fs.readFileSync).mockImplementation((filename, options) => {
    if (filename === lockPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original.readFileSync(filename, options);
  });
  try {
    expect(() => acquireEngineStoreWriterLock(dbPath)).toThrow(/owner is unreadable; no stale recovery/);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(original.readFileSync(lockPath, "utf8")).toBe("999999999\ndead owner\n");
    expect(fs.readdirSync(`${dbPath}.writer.owners`)).toEqual([]);
  } finally { vi.mocked(fs.readFileSync).mockImplementation(original.readFileSync); }
});

it("retries a legacy lock released between the failed claim and owner read", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const lockPath = `${dbPath}.lock`;
  fs.writeFileSync(lockPath, "999999999\ndead owner\n");
  let released = false;
  vi.mocked(fs.readFileSync).mockImplementation((filename, options) => {
    if (filename === lockPath && !released) {
      released = true; fs.unlinkSync(lockPath);
      throw Object.assign(new Error("already released"), { code: "ENOENT" });
    }
    return original.readFileSync(filename, options);
  });
  try { const release = acquireEngineStoreWriterLock(dbPath); release(); }
  finally { vi.mocked(fs.readFileSync).mockImplementation(original.readFileSync); }
  expect(fs.existsSync(lockPath)).toBe(false);
  expect(fs.readdirSync(`${dbPath}.writer.owners`)).toEqual([]);
});
