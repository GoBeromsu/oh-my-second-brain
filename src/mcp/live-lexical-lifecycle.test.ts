import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMSMcpServer } from "./server.js";

const lifecycle = vi.hoisted(() => ({ revision: 1, created: [] as number[], loaded: [] as number[], disposed: [] as number[], sessions: new Set<unknown>() }));
vi.mock("../kernel/engine/assemble.js", async importOriginal => {
  const original = await importOriginal<typeof import("../kernel/engine/assemble.js")>();
  return {
    ...original,
    assembleLiveLexicalEngine(config: Parameters<typeof original.assembleLiveLexicalEngine>[0], session: Parameters<typeof original.assembleLiveLexicalEngine>[1]) {
      lifecycle.sessions.add(session);
      if (config.reranker !== undefined) return original.assembleLiveLexicalEngine(config, session);
      const revision = lifecycle.revision;
      lifecycle.created.push(revision);
      return original.assembleLiveLexicalEngine({
        ...config,
        rerankerFactory: () => {
          lifecycle.loaded.push(revision);
          return { rerank: async (_query, hits) => hits, dispose: async () => { lifecycle.disposed.push(revision); } };
        },
      }, session);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  lifecycle.created.length = lifecycle.loaded.length = lifecycle.disposed.length = 0;
  lifecycle.sessions.clear(); lifecycle.revision = 1;
});
async function connected(reranker?: Parameters<typeof createOMSMcpServer>[0]["reranker"]) {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-live-model-lifetime-")); roots.push(vault);
  await writeFile(path.join(vault, "note.md"), "# Note\nneedle\n");
  const server = createOMSMcpServer({ vault, source: "explicit", reranker });
  const client = new Client({ name: "live-model-lifecycle", version: "0.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  return { client, server };
}
async function query(client: Client, rerank = false) {
  const result = await client.callTool({ name: "search", arguments: { op: "query", query: "needle", rerank } });
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("missing text response");
  expect(JSON.parse(block.text)).toMatchObject({ available: true, totalCount: 1 });
}

describe("MCP live lexical model lifetime", () => {
  it("reuses only the lexical session while resolving and disposing models per request", async () => {
    const { client, server } = await connected();
    try {
      await query(client, true);
      lifecycle.revision = 2;
      await query(client, true);
      lifecycle.revision = 3;
      await query(client);
      expect(lifecycle.created).toEqual([1, 2, 3]);
      expect(lifecycle.loaded).toEqual([1, 2]);
      expect(lifecycle.disposed).toEqual([1, 2]);
      expect(lifecycle.sessions.size).toBe(1);
      expect(lifecycle.sessions.has(undefined)).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it("never disposes the caller's injected reranker", async () => {
    const dispose = vi.fn(async () => undefined);
    const { client, server } = await connected({ rerank: async (_query, hits) => hits, dispose });
    try { await query(client, true); }
    finally { await client.close(); await server.close(); }
    expect(dispose).not.toHaveBeenCalled();
  });
});
