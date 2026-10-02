import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMSMcpServer } from "../../../mcp/server.js";
import { assembleLiveLexicalEngine } from "../assemble.js";
import { syncEngineStore } from "./sync.js";

const observed = vi.hoisted(() => ({ paths: [] as string[] }));
function noteRead(filename: unknown): void {
  if (typeof filename === "string" && filename.endsWith(".md")) observed.paths.push(filename);
}
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => { noteRead(args[0]); return original.readFile(...args); },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const read = handle.readFile.bind(handle);
      handle.readFile = (...readArgs: Parameters<typeof handle.readFile>) => { noteRead(args[0]); return read(...readArgs); };
      return handle;
    },
  };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: (...args: Parameters<typeof original.readFileSync>) => { noteRead(args[0]); return original.readFileSync(...args); } };
});

let directory: string;
let vault: string;
let dbPath: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oms-live-reads-"));
  vault = path.join(directory, "vault");
  dbPath = path.join(directory, "index.sqlite");
  await mkdir(vault);
  for (const name of ["alpha", "beta", "gamma"]) await writeFile(path.join(vault, `${name}.md`), `# ${name}\n${name} uniquemarker\n`);
  await syncEngineStore({ vault, dbPath, embed: false });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

/** Also counts opened-handle reads, not just fs.readFile wrappers. */
describe("end-to-end live lexical body reads without a persisted node cache", () => {
  it("keeps MCP cold→warm→edited requests complete while reading only the changed or displayed note", async () => {
    vi.stubEnv("XDG_CACHE_HOME", path.join(directory, "cache"));
    await syncEngineStore({ vault, embed: false });
    const server = createOMSMcpServer({ vault, source: "explicit" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "live-body-read-count", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const search = async (query: string) => {
      const response = await client.callTool({ name: "search", arguments: { op: "query", query } });
      const block = response.content[0];
      if (block?.type !== "text") throw new Error("Missing search response");
      return JSON.parse(block.text) as Record<string, unknown>;
    };
    const unrelatedReads = () => observed.paths.filter(filename => ["beta.md", "gamma.md"].some(name => filename === path.join(vault, name)));
    try {
      observed.paths.length = 0;
      expect(await search("alpha")).toMatchObject({ available: true, totalCount: 1 });
      expect(new Set(unrelatedReads())).toEqual(new Set([path.join(vault, "beta.md"), path.join(vault, "gamma.md")]));
      observed.paths.length = 0;
      expect(await search("alpha")).toMatchObject({ available: true, totalCount: 1 });
      expect(unrelatedReads()).toEqual([]);
      expect(observed.paths).toEqual([path.join(vault, "alpha.md")]);
      await writeFile(path.join(vault, "alpha.md"), "# Updated\nlivemarker\n");
      observed.paths.length = 0;
      expect(await search("livemarker")).toMatchObject({ available: true, totalCount: 1 });
      expect(unrelatedReads()).toEqual([]);
      expect(observed.paths).toEqual([path.join(vault, "alpha.md"), path.join(vault, "alpha.md")]);
    } finally { await client.close(); await server.close(); }
  });

  it("does not reread unchanged note bodies for facets on warm and edited queries", async () => {
    const engine = assembleLiveLexicalEngine({ vault, dbPath });
    try {
      await engine.adapter.semanticQuery({ query: "alpha" });
      observed.paths.length = 0;
      expect(await engine.adapter.semanticQuery({ query: "alpha" })).toMatchObject({ available: true });
      expect(observed.paths.filter(filename => filename === path.join(vault, "beta.md") || filename === path.join(vault, "gamma.md"))).toEqual([]);
      await writeFile(path.join(vault, "alpha.md"), "# Updated\nlivemarker\n");
      observed.paths.length = 0;
      expect(await engine.adapter.semanticQuery({ query: "livemarker" })).toMatchObject({ available: true, totalCount: 1 });
      expect(observed.paths.filter(filename => filename === path.join(vault, "beta.md") || filename === path.join(vault, "gamma.md"))).toEqual([]);
    } finally { await engine.dispose(); }
  });
});
