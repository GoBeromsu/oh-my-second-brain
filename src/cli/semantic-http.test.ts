import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncEngineStore } from "../kernel/engine/embed/sync.js";
import { startSemanticHttpServer, type SemanticHttpServer } from "./semantic-http.js";

let tmpVault: string | undefined;
let httpServer: SemanticHttpServer | undefined;

afterEach(async () => {
  if (httpServer) {
    await httpServer.close();
    httpServer = undefined;
  }
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

async function writeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-http-semantic-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
---
# Agent Retrieval

Agent retrieval works over direct HTTP query transport.
`,
    "utf-8",
  );
  return vault;
}

async function jsonFetch(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected object JSON response.");
  }
  return parsed as Record<string, unknown>;
}

describe("semantic HTTP transport", () => {
  it("serves engine-backed health, lexical query/search, and MCP tool-list endpoints", async () => {
    tmpVault = await writeVault();
    // Model-less: a lex-only sync populates the engine FTS index (no vectors).
    await syncEngineStore({ vault: tmpVault, embed: false });
    httpServer = await startSemanticHttpServer({ vault: tmpVault, port: 0 });

    const healthResponse = await fetch(`${httpServer.url}/health`);
    expect(healthResponse.ok).toBe(true);
    await expect(healthResponse.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        storage: "oms-native-json",
      }),
    );

    const query = await jsonFetch(`${httpServer.url}/query`, {
      lex: "agent retrieval",
      collection: "obsidian",
      limit: 1,
    });
    const hits = query["hits"];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toEqual([expect.objectContaining({ path: "references/Agent Retrieval.md" })]);

    const search = await jsonFetch(`${httpServer.url}/search`, {
      lex: "agent retrieval",
      collection: "obsidian",
      limit: 1,
    });
    expect(search).toEqual(expect.objectContaining({ available: true }));

    const tools = await jsonFetch(`${httpServer.url}/mcp`, {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    });
    expect(tools).toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: "tools",
        result: expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: "oms_semantic_query" })]),
        }),
      }),
    );
  });
});
