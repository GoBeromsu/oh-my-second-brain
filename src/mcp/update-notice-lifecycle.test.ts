import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunnerCall } from "../kernel/update/update.js";
import {
  __resetUpdateNoticeRefreshLockForTests,
  cancelUpdateNoticeRefresh,
  scheduleUpdateNoticeRefresh,
  updateNoticeCachePath,
} from "./update-notice.js";

// Preserve the real default runner while retaining its actual child handles for
// timeout-safe teardown. No runner or registry response is injected into OMS.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

interface OwnedChild {
  readonly child: ChildProcess;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const owned = new Map<ChildProcess, OwnedChild>();
let root = "";
let env: Record<string, string>;
const cli = fileURLToPath(new URL("../../dist/cli/oms.js", import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const marker = (name: string): string => path.join(root, name);

function own(child: ChildProcess): OwnedChild {
  const previous = owned.get(child);
  if (previous !== undefined) return previous;
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  const entry = { child, closed };
  owned.set(child, entry);
  return entry;
}

function defaultChildren(): OwnedChild[] {
  return vi.mocked(childProcess.execFile).mock.results
    .filter(result => result.type === "return")
    .map(result => own(result.value as ChildProcess));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fakePid(): number {
  return (JSON.parse(readFileSync(marker("started.json"), "utf8")) as { pid: number }).pid;
}

// This hook is independent of each test body's finally. Vitest timeouts do not
// cancel async bodies, so cleanup must own resources before the first await.
afterEach(async () => {
  const cancelling = cancelUpdateNoticeRefresh();
  defaultChildren();
  if (root && existsSync(marker("started.json"))) {
    const pid = fakePid();
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const { child } of owned.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await cancelling;
  await Promise.all([...owned.values()].map(entry => entry.closed));
  if (root && existsSync(marker("started.json"))) {
    const pid = fakePid();
    await eventually(() => !alive(pid), "test-owned npm to exit");
  }
  owned.clear();
  __resetUpdateNoticeRefreshLockForTests();
  vi.unstubAllEnvs();
  vi.mocked(childProcess.execFile).mockClear();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-notice-lifecycle-")));
  for (const name of ["bin", "home", "cache", "notice", "runtime", "temporary", "vault"]) mkdirSync(marker(name));
  const fake = marker("fake-npm.cjs");
  writeFileSync(fake, `const fs = require("node:fs");
const path = require("node:path");
const root = process.env.OMS_NOTICE_TEST_ROOT;
const marker = name => path.join(root, name);
// Announce readiness only after TERM can no longer end this fixture. Shutdown
// must actually use the owned-child hard kill, including after abort.
process.on("SIGTERM", () => {});
fs.writeFileSync(marker("started.json"), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
const behavior = fs.existsSync(marker("behavior")) ? fs.readFileSync(marker("behavior"), "utf8") : "hold";
if (behavior === "nonzero") { process.stdout.write(JSON.stringify("0.22.0")); process.exitCode = 7; }
else if (behavior === "oversized") { process.stdout.write(" ".repeat(80 * 1024) + JSON.stringify("0.22.0")); }
else {
// A release marker controls completion; the watchdog only bounds a broken test.
const watchdog = setTimeout(() => process.exit(99), 20000);
const poll = setInterval(() => {
  if (!fs.existsSync(root)) process.exit(98);
  if (!fs.existsSync(marker("release"))) return;
  clearInterval(poll); clearTimeout(watchdog);
  fs.writeFileSync(marker("finished"), "finished");
  process.stdout.write(JSON.stringify("0.22.0"));
}, 20);
}
`);
  const npm = path.join(marker("bin"), "npm");
  writeFileSync(npm, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`);
  chmodSync(npm, 0o755);
  env = {
    PATH: marker("bin"), HOME: marker("home"), USERPROFILE: marker("home"),
    XDG_CONFIG_HOME: marker("home"), XDG_DATA_HOME: marker("home"), XDG_STATE_HOME: marker("home"),
    XDG_CACHE_HOME: marker("cache"), OMS_RUNTIME_ROOT: marker("runtime"), TMPDIR: marker("temporary"),
    OMS_AUTO_UPDATE_STATE_DIR: marker("notice"), OMS_NOTICE_TEST_ROOT: root,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  for (const name of ["OMS_UPDATE_NOTICE", "OMS_NO_UPDATE_NOTICE", "OMS_UPDATE_LATEST_VERSION"]) vi.stubEnv(name, undefined);
});

describe("default MCP update refresh lifecycle", () => {
  it("returns and serves the event loop while npm waits, then publishes only its completed result", async () => {
    let settled = false;
    let timerSawPending = false;
    const tick = new Promise<void>(resolve => setTimeout(() => { timerSawPending = !settled; resolve(); }, 0));
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0", timeoutMs: 10_000 });
    expect(scheduled).not.toBeNull();
    defaultChildren();
    void scheduled!.then(() => { settled = true; });
    await tick;
    expect(timerSawPending).toBe(true);
    await eventually(() => existsSync(marker("started.json")), "fake npm to start");
    expect(alive(fakePid())).toBe(true);
    expect(settled).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
    expect(JSON.parse(readFileSync(marker("started.json"), "utf8")).args)
      .toEqual(["view", "oh-my-second-brain@latest", "version", "--json"]);
    writeFileSync(marker("release"), "release");
    await scheduled;
    expect(alive(fakePid())).toBe(false);
    expect(JSON.parse(readFileSync(updateNoticeCachePath(), "utf8")).channels.stable.latestVersion).toBe("0.22.0");
  }, 15_000);

  it("kills and reaps npm at its request deadline without publishing a cache", async () => {
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0", timeoutMs: 100 });
    const children = defaultChildren();
    expect(children).toHaveLength(1);
    const pid = children[0]!.child.pid!;
    await scheduled;
    expect(alive(pid)).toBe(false);
    expect(existsSync(marker("finished"))).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
  });

  it("cancels an active default child idempotently and cannot publish a late result", async () => {
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0", timeoutMs: 10_000 });
    defaultChildren();
    await eventually(() => existsSync(marker("started.json")), "fake npm to start");
    const pid = fakePid();
    expect(alive(pid)).toBe(true);
    await Promise.all([cancelUpdateNoticeRefresh(), cancelUpdateNoticeRefresh()]);
    expect(alive(pid)).toBe(false);
    writeFileSync(marker("release"), "too late");
    await scheduled;
    await cancelUpdateNoticeRefresh();
    expect(existsSync(marker("finished"))).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
  }, 15_000);

  it("fails open when npm cannot spawn without creating a cache", async () => {
    vi.stubEnv("PATH", marker("missing-bin"));
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0" });
    const children = defaultChildren();
    expect(children).toHaveLength(1);
    await expect(scheduled).resolves.toBeUndefined();
    expect(children[0]!.child.pid).toBeUndefined();
    expect(existsSync(marker("started.json"))).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
  });

  it.each(["nonzero", "oversized"])("reaps a %s default query without accepting its version output", async behavior => {
    writeFileSync(marker("behavior"), behavior);
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0" });
    const children = defaultChildren();
    expect(children).toHaveLength(1);
    await expect(scheduled).resolves.toBeUndefined();
    expect(alive(children[0]!.child.pid!)).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
  });

  it("does not await a caller-owned deferred runner, but suppresses its cancelled late result", async () => {
    let finish!: (value: UpdateRunnerCall) => void;
    const deferred = new Promise<UpdateRunnerCall>(resolve => { finish = resolve; });
    let settled = false;
    const scheduled = scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0", runner: () => deferred });
    void scheduled!.then(() => { settled = true; });
    await cancelUpdateNoticeRefresh();
    expect(settled).toBe(false);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    finish({ exitCode: 0, stdout: '"0.22.0"', stderr: "" });
    await scheduled;
    expect(existsSync(updateNoticeCachePath())).toBe(false);
  });

  it.each(["fresh", "suppressed"])("spawns nothing for a %s notice", async kind => {
    if (kind === "fresh") writeFileSync(updateNoticeCachePath(), JSON.stringify({ version: 1, channels: { stable: { latestVersion: "0.22.0", checkedAt: Date.now() } } }));
    else vi.stubEnv("OMS_UPDATE_NOTICE", "0");
    expect(scheduleUpdateNoticeRefresh({ installedVersion: "0.21.0" })).toBeNull();
    await cancelUpdateNoticeRefresh();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(existsSync(marker("started.json"))).toBe(false);
  });

  it("shuts down cleanly when stdin ends before initialization", async () => {
    const child = childProcess.spawn(process.execPath, [cli, "serve", "mcp", "--vault", marker("vault")], {
      cwd: root, env, stdio: "pipe",
    });
    const { closed } = own(child);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(alive(child.pid!)).toBe(false);
    if (existsSync(marker("started.json"))) expect(alive(fakePid())).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
    expect(stderr).toBe("");
  }, 15_000);

  it.each(["EOF", "SIGINT", "SIGTERM"] as const)("initializes with npm still pending and reaps it on %s", async signal => {
    const child = childProcess.spawn(process.execPath, [cli, "serve", "mcp", "--vault", marker("vault")], {
      cwd: root, env, stdio: "pipe",
    });
    const { closed } = own(child);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const initialized = new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try { resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>); }
        catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.once("close", () => reject(new Error(`MCP closed before initialization: ${stderr}`)));
    });
    void initialized.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notice-lifecycle", version: "0.0.0" } } })}\n`);
    await eventually(() => existsSync(marker("started.json")), "MCP's fake npm to start");
    const npmPid = fakePid();
    expect(await initialized).toMatchObject({ id: 1, result: { serverInfo: { name: "oms" } } });
    expect(alive(npmPid)).toBe(true);
    expect(existsSync(marker("finished"))).toBe(false);
    if (signal === "EOF") child.stdin.end();
    else child.kill(signal);
    expect(await closed).toEqual({ code: signal === "EOF" ? 0 : signal === "SIGINT" ? 130 : 143, signal: null });
    expect(alive(child.pid!)).toBe(false);
    expect(alive(npmPid)).toBe(false);
    expect(existsSync(updateNoticeCachePath())).toBe(false);
    expect(stderr).toBe("");
  }, 15_000);
});
