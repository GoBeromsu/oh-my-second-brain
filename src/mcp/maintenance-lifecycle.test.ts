import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { openEngineStoreCoreReadOnly } from "../kernel/engine/embed/store.js";

const cli = fileURLToPath(new URL("../../dist/cli/oms.js", import.meta.url));
let root: string; let vault: string; let cache: string;
const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-maintenance-mcp-")); vault = path.join(root, "vault"); cache = path.join(root, "cache");
  await mkdir(vault); await mkdir(path.join(root, "home")); await mkdir(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  await writeFile(path.join(vault, "note.md"), "# Note\noldmarker\n");
});
afterEach(async () => {
  for (const transport of transports) { if (transport.pid !== null) { try { process.kill(transport.pid, "SIGCONT"); } catch {} } }
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.allSettled(transports.splice(0).map(transport => transport.close()));
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});
function connection(maintenance = true) {
  const env = Object.fromEntries(Object.entries({ ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_CACHE_HOME: cache,
    OMS_UPDATE_NOTICE: "0", OMS_EMBEDDING_PROVIDER: undefined, OMS_EMBEDDING_MODEL: undefined }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "mcp", "--vault", vault, ...(maintenance ? ["--maintenance", "lexical"] : [])], env, stderr: "pipe" });
  transports.push(transport); let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "maintenance-lifecycle", version: "0.0.0" }); clients.push(client);
  return { client, transport, stderr: () => stderr };
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.find((item: { type: string }) => item.type === "text");
  if (text?.type !== "text") throw new Error("Missing MCP text payload");
  return JSON.parse(text.text) as Record<string, unknown>;
}
async function eventually(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("Maintenance did not reach the expected state before the deadline");
}
async function idle(client: Client) {
  await eventually(async () => ((await call(client, "doctor", { op: "status" })).maintenance as { phase?: string })?.phase === "idle");
}
function indexed(query: string) {
  const store = openEngineStoreCoreReadOnly(engineStorePath(vault));
  if (store === null) return [];
  try { return store.queryLex(query, 10).map(hit => hit.docPath); } finally { store.close(); }
}

describe("real MCP maintenance process lifecycle", () => {
  it("keeps a cold default query read-only and creates no maintenance owner", async () => {
    const selected = connection(false); await selected.client.connect(selected.transport);
    expect(await call(selected.client, "search", { op: "query", query: "oldmarker" })).toMatchObject({ available: true, totalCount: 1 });
    expect((await call(selected.client, "doctor", { op: "status" })).maintenance).toBeUndefined();
    await expect(readFile(engineStorePath(vault))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(vault)).toEqual(["note.md"]);
    expect(selected.stderr()).toBe("");
  });

  it("excludes another process and a paused-owner takeover, then recovers a crashed owner from Markdown", async () => {
    expect((await syncEngineStore({ vault, embed: false })).available).toBe(true);
    const first = connection(); await first.client.connect(first.transport); await idle(first.client);
    const second = connection(); await expect(second.client.connect(second.transport)).rejects.toThrow();
    expect(second.stderr()).toContain("OWNER_BUSY");
    const pid = first.transport.pid!; process.kill(pid, "SIGSTOP");
    try {
      const third = connection(); await expect(third.client.connect(third.transport)).rejects.toThrow();
      expect(third.stderr()).toContain("OWNER_BUSY");
    } finally { process.kill(pid, "SIGCONT"); }
    await idle(first.client);
    await writeFile(path.join(vault, "note.md"), "# Note\nexternalmarker\n");
    await eventually(async () => indexed("externalmarker").length === 1);
    expect(await call(first.client, "search", { op: "query", query: "externalmarker" })).toMatchObject({ available: true, totalCount: 1 });
    const write = await call(first.client, "write", { path: "created.md", content: "---\nsubject: observed\n---\nmanagedmarker\n" });
    expect(write.ok).toBe(true);
    await eventually(async () => indexed("managedmarker").length === 1);
    process.kill(pid, "SIGKILL");
    await eventually(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await writeFile(path.join(vault, "note.md"), "# Note\ncrashrecoverymarker\n");
    const next = connection(); await next.client.connect(next.transport); await idle(next.client);
    expect(indexed("crashrecoverymarker")).toEqual(["note.md"]);
    expect(await call(next.client, "doctor", { op: "status" })).toMatchObject({ maintenance: { mode: "lexical", phase: "idle", sqliteVersion: expect.any(String) } });
    await next.client.close();
    await eventually(async () => (await readdir(`${engineStorePath(vault)}.maintenance.owners`)).length === 0);
    expect(await readFile(path.join(vault, "note.md"), "utf8")).toBe("# Note\ncrashrecoverymarker\n");
  }, 30_000);
});
