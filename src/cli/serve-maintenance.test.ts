import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runServeHttp, type ServeHttpServer } from "./serve-http.js";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { openEngineStoreCoreReadOnly } from "../kernel/engine/embed/store.js";

const cli = fileURLToPath(new URL("../../dist/cli/oms.js", import.meta.url));
let root: string; let vault: string; let modelCacheDir: string;
const servers: ServeHttpServer[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-http-maintenance-")); vault = path.join(root, "vault"); modelCacheDir = path.join(root, "models");
  await mkdir(vault); await mkdir(modelCacheDir); vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  await writeFile(path.join(vault, "a.md"), "oldmarker\n");
});
afterEach(async () => { await Promise.allSettled(servers.splice(0).map(server => server.close())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function start(maintenance?: "lexical" | "full") {
  const server = await runServeHttp({ vault, source: "explicit", maintenance, port: 0, modelCacheDir, modelEnv: {} }); servers.push(server); return server;
}
async function health(server: ServeHttpServer) { return await (await fetch(`${server.url}/health`)).json() as { maintenance?: { phase: string; mode: string; sqliteVersion: string } }; }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error("HTTP maintenance did not catch up");
}

describe("HTTP automatic maintenance opt-in", () => {
  it("does not create an index or owner by default", async () => {
    const server = await start(); expect((await health(server)).maintenance).toBeUndefined();
    await expect(readFile(engineStorePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await (await fetch(`${server.url}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "oldmarker" }) })).json();
    expect(result).toMatchObject({ available: true });
    expect(await readdir(vault)).toEqual(["a.md"]);
  });
  it("reports lifecycle status and refreshes saved notes through the existing server", async () => {
    expect((await syncEngineStore({ vault, embed: false })).available).toBe(true);
    const server = await start("lexical"); await until(async () => (await health(server)).maintenance?.phase === "idle");
    expect((await health(server)).maintenance).toMatchObject({ mode: "lexical", sqliteVersion: expect.any(String) });
    await writeFile(path.join(vault, "a.md"), "freshmarker\n");
    await until(async () => {
      const result = await (await fetch(`${server.url}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "freshmarker" }) })).json() as { totalCount: number };
      return result.totalCount === 1;
    });
    await server.close(); servers.splice(servers.indexOf(server), 1);
    expect(await readdir(`${engineStorePath(vault)}.maintenance.owners`)).toEqual([]);
  });
  it("fails startup for absent index, unverified target, or uninitialized full mode", async () => {
    await expect(start("lexical")).rejects.toThrow("INDEX_UNAVAILABLE");
    await syncEngineStore({ vault, embed: false });
    await expect(runServeHttp({ vault, source: "cwd", maintenance: "lexical", port: 0, modelCacheDir, modelEnv: {} })).rejects.toThrow("TARGET_UNVERIFIED");
    await expect(start("full")).rejects.toThrow();
    expect(await readdir(`${engineStorePath(vault)}.maintenance.owners`)).toEqual([]);
  });
  it("rejects a noncanonical index with maintenance enabled", async () => {
    await expect(runServeHttp({ vault, source: "explicit", maintenance: "lexical", index: path.join(root, "other.sqlite"), port: 0 })).rejects.toThrow("canonical");
  });
  it("cancels maintenance immediately and bounds incomplete HTTP body draining", async () => {
    await syncEngineStore({ vault, embed: false });
    const server = await start("lexical"); await until(async () => (await health(server)).maintenance?.phase === "idle");
    const incomplete = request(new URL("/search", server.url), { method: "POST", headers: { "content-type": "application/json", "content-length": "9999" } });
    incomplete.on("error", () => undefined);
    const connected = new Promise<void>(resolve => incomplete.once("socket", socket => socket.once("connect", () => resolve())));
    incomplete.write('{"query":'); await connected;
    await new Promise(resolve => setTimeout(resolve, 50));
    let finished = false;
    const stopped = server.close().then(() => { finished = true; });
    try {
      await writeFile(path.join(vault, "a.md"), "afterclosemarker\n");
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      expect(await readdir(`${engineStorePath(vault)}.maintenance.owners`)).toEqual([]);
      const store = openEngineStoreCoreReadOnly(engineStorePath(vault))!;
      try { expect(store.queryLex("afterclosemarker", 10)).toEqual([]); } finally { store.close(); }
      await stopped;
      expect(finished).toBe(true);
      await expect(server.close()).resolves.toBeUndefined();
    } finally { incomplete.destroy(); }
  }, 10_000);
});

describe("serve maintenance flag", () => {
  it.each(["mcp", "http"])("documents explicit %s opt-in", leaf => {
    expect(execFileSync(process.execPath, [cli, "serve", leaf, "--help"], { encoding: "utf8" })).toContain("--maintenance <lexical|full>");
  });
  it.each([["mcp", "--maintenance"], ["http", "--maintenance"], ["mcp", "--maintenance", "true"], ["http", "--maintenance", "true"], ["mcp", "--maintenance", "lexical", "--maintenance", "full"], ["http", "--maintenance", "lexical", "--maintenance", "full"]])("refuses invalid maintenance arguments %j", args => {
    expect(() => execFileSync(process.execPath, [cli, "serve", ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, OMS_UPDATE_NOTICE: "0" } })).toThrow();
  });
});
