import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMSMcpServer } from "./server.js";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";

let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root !== undefined) await rm(root, { recursive: true, force: true }); });
it("opens added and renamed live hits by returned path, docid, and hash-prefixed docid", async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-live-open-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  await writeFile(path.join(vault, "old.md"), "# Old\noldnote\n");
  await syncEngineStore({ vault, embed: false });
  await writeFile(path.join(vault, "new.md"), "# New\njourneymarker\n");
  const server = createOMSMcpServer({ vault, source: "explicit" });
  const client = new Client({ name: "live-open-journey", version: "0.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "search", arguments: args });
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Missing response");
    return JSON.parse(block.text) as Record<string, unknown>;
  };
  try {
    for (const filename of ["new.md", "renamed.md"]) {
      if (filename === "renamed.md") await rename(path.join(vault, "new.md"), path.join(vault, filename));
      const result = await call({ op: "query", query: "journeymarker" });
      expect(result).toMatchObject({ available: true, totalCount: 1 });
      const [hit] = result.hits as Array<{ path: string; docid: string }>;
      expect(hit).toMatchObject({ path: filename, docid: filename });
      for (const target of [hit!.path, hit!.docid, `#${hit!.docid}`]) {
        expect(await call({ op: "get-document", target })).toMatchObject({
          available: true, documents: [{ path: filename, content: expect.stringContaining("journeymarker") }],
        });
      }
      expect(await call({ op: "get-document", targets: [`#${hit!.docid}`] })).toMatchObject({
        available: true, documents: [{ path: filename }],
      });
    }
  } finally { await client.close(); await server.close(); }
});
