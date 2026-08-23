import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("MCP detail-tool demotion", () => {
  it("keeps every demoted implementation reachable behind the five-tool surface", async () => {
    const client = new Client({ name: "demotion-test", version: "0" });
    const vault = await mkdtemp(path.join(tmpdir(), "oms-demotion-"));
    await cp(fixtureVault, vault, { recursive: true });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [distCli, "mcp", "--vault", vault], cwd: repoRoot, stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      const demoted = ["oms_retrieve_by_axis", "oms_retrieve_context", "oms_lazy_load_note", "oms_list_concepts", "oms_semantic_query", "oms_semantic_collections", "oms_semantic_contexts", "oms_semantic_status", "oms_get_document", "oms_multi_get_documents", "oms_link_suggest", "oms_link_apply", "oms_graph_status", "oms_vault_audit", "oms_validate_contract", "oms_graph_build", "oms_semantic_cleanup", "oms_sync_embeddings", "query", "get", "multi_get", "status"];
      expect(names).not.toEqual(expect.arrayContaining(demoted));
      expect(payload(await client.callTool({ name: "oms_status", arguments: {} })).derivedState).toBeDefined();
      expect(payload(await client.callTool({ name: "oms_doctor", arguments: { op: "audit", folder: "references" } })).scannedNotes).toBeTypeOf("number");
      expect(payload(await client.callTool({ name: "oms_doctor", arguments: { op: "validate", notePath: "references/clean-architecture.md" } })).valid).toBe(true);
      expect(payload(await client.callTool({ name: "oms_doctor", arguments: { op: "build-graph" } })).notes).toBeTypeOf("number");
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "concepts" } })).concepts).toBeInstanceOf(Array);
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "axis", folder: "references" } })).hits).toBeInstanceOf(Array);
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "context", folder: "references", useCache: false } })).hits).toBeInstanceOf(Array);
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "lazy-load", notePath: "references/clean-architecture.md" } })).body).toBeTypeOf("string");
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "get-document", target: "references/clean-architecture.md" } })).documents).toBeInstanceOf(Array);
      expect(payload(await client.callTool({ name: "oms_search", arguments: { op: "multi-get-documents", targets: ["references/clean-architecture.md"] } })).documents).toBeInstanceOf(Array);
      const suggested = payload(await client.callTool({ name: "oms_link", arguments: { op: "suggest", notePath: "references/clean-architecture.md" } }));
      expect(suggested.baseContentHash).toBeTypeOf("string");
      const apply = await client.callTool({ name: "oms_link", arguments: { op: "apply", notePath: "references/clean-architecture.md", baseContentHash: "0".repeat(64), candidateIds: [] } });
      expect(apply.content[0]?.type).toBe("text");
      for (const op of ["semantic-query", "semantic-collections", "semantic-contexts", "semantic-status"]) {
        const result = await client.callTool({ name: "oms_search", arguments: { op, query: "architecture" } });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available|collections|contexts/,
        );
      }
      for (const op of ["semantic-cleanup", "sync-embeddings"]) {
        const result = await client.callTool({ name: "oms_doctor", arguments: { op } });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available/,
        );
      }
      await expect(client.listResourceTemplates()).rejects.toThrow(/Method not found/);
    } finally { await client.close(); await rm(vault, { recursive: true, force: true }); }
  }, 120_000);
});
