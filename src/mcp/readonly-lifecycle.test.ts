import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { engineStorePath } from "../kernel/engine/paths.js";

it.each([
  [false, "EOF"], [false, "SIGINT"], [false, "SIGTERM"],
  [true, "EOF"], [true, "SIGINT"], [true, "SIGTERM"],
] as const)("disposes completed MCP disk scratch (maintenance=%s, shutdown=%s)", async (maintenance, signal) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oms-readonly-eof-")));
  const vault = path.join(root, "vault"); const temporary = path.join(root, "temporary");
  const home = path.join(root, "home"); const cache = path.join(root, "cache");
  for (const directory of [vault, temporary, home, cache]) await mkdir(directory);
  const content = "# Note\nreadonlymarker\n";
  await writeFile(path.join(vault, "note.md"), content);
  if (maintenance) {
    const dbPath = engineStorePath(vault, { env: { XDG_CACHE_HOME: cache }, homeDir: home });
    expect((await syncEngineStore({ vault, dbPath, embed: false })).available).toBe(true);
  }
  const preload = path.join(root, "force-spill.mjs");
  // Exercise real transport/process disposal without a >128 MiB unit fixture.
  // This changes only the existing private memory budget in the test child.
  const liveModule = new URL("../../dist/kernel/engine/embed/live-lexical.js", import.meta.url).href;
  await writeFile(preload, `import { LiveLexicalSession } from ${JSON.stringify(liveModule)};
    const prepare = LiveLexicalSession.prototype.prepare;
    LiveLexicalSession.prototype.prepare = function (...args) { this.maxMemoryBytes = 1; return prepare.apply(this, args); };\n`);
  const cli = fileURLToPath(new URL("../../dist/cli/oms.js", import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, cli, "serve", "mcp", "--vault", vault, ...(maintenance ? ["--maintenance", "lexical"] : [])],
    env: { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: cache, TMPDIR: temporary, PATH: process.env.PATH ?? "", OMS_UPDATE_NOTICE: "0" }, stderr: "pipe" });
  const client = new Client({ name: "readonly-eof-test", version: "0.0.0" });
  const closed = new Promise<void>(resolve => { client.onclose = resolve; });
  let stderr = ""; transport.stderr?.on("data", data => { stderr += String(data); });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "search", arguments: { op: "query", query: "readonlymarker", limit: 10 } });
    const text = response.content.find((item: { type: string }) => item.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Missing search result");
    expect(JSON.parse(text.text)).toMatchObject({ available: true, totalCount: 1, receipt: { indexDrift: false } });
    expect((await readdir(temporary)).filter(name => name.startsWith("oms-live-lexical-"))).toHaveLength(1);
    if (signal === "EOF") await client.close();
    else { process.kill(transport.pid!, signal); await closed; }
    expect(await readdir(temporary)).toEqual([]);
    if (!maintenance) expect(await readdir(cache)).toEqual([]);
    else {
      const dbPath = engineStorePath(vault, { env: { XDG_CACHE_HOME: cache }, homeDir: home });
      expect(await readdir(`${dbPath}.maintenance.owners`)).toEqual([]);
    }
    expect(await readdir(vault)).toEqual(["note.md"]);
    expect(await readFile(path.join(vault, "note.md"), "utf8")).toBe(content);
    expect(stderr).toBe("");
  } finally {
    await client.close(); await transport.close(); await rm(root, { recursive: true, force: true });
  }
}, 15_000);
