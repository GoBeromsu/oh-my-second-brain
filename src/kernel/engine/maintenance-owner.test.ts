import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { acquireMaintenanceOwner, type MaintenanceOwner } from "./maintenance-owner.js";

let root: string;
let vault: string;
let dbPath: string;
const owners: MaintenanceOwner[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "oms-owner-test-"));
  vault = path.join(root, "vault"); mkdirSync(vault);
  dbPath = path.join(root, "cache", "engine.sqlite");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await stopped;
    }
  }
  for (const owner of owners.splice(0)) owner.release();
  rmSync(root, { recursive: true, force: true });
});
function acquire(deps = {}) { const owner = acquireMaintenanceOwner(vault, dbPath, deps); owners.push(owner); return owner; }

describe("non-expiring maintenance ownership", () => {
  it("owns a distinct external lock without creating the engine or holding its writer lock", () => {
    const owner = acquire();
    expect(owner.isCurrent()).toBe(true);
    expect(() => readFileSync(dbPath)).toThrow();
    expect(() => readFileSync(`${dbPath}.lock`)).toThrow();
    expect(() => acquire()).toThrow("OWNER_BUSY");
    owner.release(); owner.release();
    expect(owner.isCurrent()).toBe(false);
    expect(acquire().isCurrent()).toBe(true);
  });

  it.each(["EPERM", "unknown", "reused-pid"])("does not steal ownership for %s liveness", kind => {
    const owner = acquire();
    expect(() => acquire({ isPidAlive: () => { if (kind === "reused-pid") return true; throw Object.assign(new Error(kind), { code: kind }); } })).toThrow("OWNER_BUSY");
    expect(owner.isCurrent()).toBe(true);
  });

  it("recovers a proven-dead record and an old release cannot delete its successor", () => {
    const old = acquire();
    const next = acquire({ isPidAlive: () => false });
    expect(old.isCurrent()).toBe(false);
    old.release();
    expect(next.isCurrent()).toBe(true);
  });

  it.each(["corrupt", "unsupported", "replaced", "missing"])("fails closed on %s ownership", kind => {
    const owner = acquire();
    const original = readFileSync(owner.lockPath);
    if (kind === "missing") rmSync(owner.lockPath);
    else if (kind === "replaced") {
      writeFileSync(`${owner.lockPath}.other`, original);
      renameSync(`${owner.lockPath}.other`, owner.lockPath);
    } else writeFileSync(owner.lockPath, kind === "corrupt" ? "{" : JSON.stringify({ version: 2, pid: process.pid, token: "x" }));
    expect(owner.isCurrent()).toBe(false);
    if (kind === "corrupt" || kind === "unsupported") expect(() => acquire({ isPidAlive: () => false })).toThrow("OWNER_UNSAFE");
    owner.release();
    if (kind !== "missing") expect(readFileSync(owner.lockPath).length).toBeGreaterThan(0);
  });

  it("refuses ownership inside the vault and symlink ownership files", () => {
    expect(() => acquireMaintenanceOwner(vault, path.join(vault, "index.sqlite"))).toThrow("inside the vault");
    mkdirSync(path.dirname(dbPath));
    writeFileSync(path.join(root, "target"), "untouched");
    mkdirSync(`${dbPath}.maintenance.owners`);
    symlinkSync(path.join(root, "target"), path.join(`${dbPath}.maintenance.owners`, `${randomUUID()}.json`));
    expect(() => acquire()).toThrow();
    expect(readFileSync(path.join(root, "target"), "utf8")).toBe("untouched");
  });

  it("refuses takeover of a suspended process and recovers only after its exit", async () => {
    mkdirSync(path.dirname(dbPath));
    mkdirSync(`${dbPath}.maintenance.owners`);
    const token = randomUUID();
    const lockPath = path.join(`${dbPath}.maintenance.owners`, `${token}.json`);
    const script = `import {writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
      writeFileSync(process.argv[1],JSON.stringify({version:1,pid:process.pid,token:process.argv[2]}),{flag:'wx'});
      console.log('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath, token], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("owner fixture exited early"))); });
    child.kill("SIGSTOP");
    expect(() => acquire()).toThrow("OWNER_BUSY");
    child.kill("SIGCONT");
    expect(() => acquire()).toThrow("OWNER_BUSY");
    const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await stopped;
    expect(acquire().isCurrent()).toBe(true);
  });

  it("publishes before enumeration so an interleaved reclaimer cannot displace a live candidate", () => {
    const directory = `${dbPath}.maintenance.owners`; mkdirSync(directory, { recursive: true });
    const token = randomUUID();
    writeFileSync(path.join(directory, `${token}.json`), JSON.stringify({ version: 1, pid: 999999, token }));
    const alive = (pid: number) => pid === process.pid;
    const first = acquire({ isPidAlive: alive, afterPublish: () => {
      expect(() => acquire({ isPidAlive: alive })).toThrow("OWNER_BUSY");
    } });
    expect(first.isCurrent()).toBe(true);
    expect(readdirSync(directory)).toEqual([path.basename(first.lockPath)]);
    expect(() => acquire({ isPidAlive: alive })).toThrow("OWNER_BUSY");
    expect(first.isCurrent()).toBe(true);
  });

  it("cleans only never-reused dead records and abandoned candidate files", () => {
    const directory = `${dbPath}.maintenance.owners`; mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 100; index++) {
      const token = randomUUID();
      writeFileSync(path.join(directory, `${token}.json`), JSON.stringify({ version: 1, pid: 999999, token }));
      writeFileSync(path.join(directory, `.claim-999999-${token}.tmp`), "incomplete");
    }
    const owner = acquire({ isPidAlive: (pid: number) => pid === process.pid });
    expect(readdirSync(directory)).toEqual([path.basename(owner.lockPath)]);
  });

  it("refuses unknown entries and a symlink ownership directory", () => {
    const directory = `${dbPath}.maintenance.owners`; mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "unknown"), "unknown");
    expect(() => acquire()).toThrow("OWNER_UNSAFE");
    expect(readdirSync(directory)).toEqual(["unknown"]);
    rmSync(directory, { recursive: true }); mkdirSync(path.join(root, "other"));
    symlinkSync(path.join(root, "other"), directory);
    expect(() => acquire()).toThrow("real directory");
  });
});
