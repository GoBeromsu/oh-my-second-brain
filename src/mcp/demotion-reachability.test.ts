import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

function expectAdvertisedArguments(tool: Tool, args: Record<string, unknown>): void {
  const schema = tool.inputSchema as {
    oneOf?: { properties?: Record<string, unknown>; required?: string[] }[];
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const branches = schema.oneOf ?? [schema];
  const branch = branches.find((candidate) => {
    const properties = candidate.properties ?? {};
    return Object.entries(args).every(([key, value]) => {
      const property = properties[key] as { const?: unknown; type?: string; items?: { type?: string } } | undefined;
      if (!property) return false;
      if (property.const !== undefined) return property.const === value;
      if (property.type === "array") return Array.isArray(value) && (property.items?.type !== "string" || value.every((item) => typeof item === "string"));
      return property.type === undefined || typeof value === property.type;
    }) && (candidate.required ?? []).every((key) => key in args);
  });
  expect(branch, `${tool.name} must advertise ${JSON.stringify(args)}`).toBeDefined();
}

describe("MCP detail-tool demotion", () => {
  it("keeps every demoted implementation reachable behind the five-tool surface", async () => {
    const client = new Client({ name: "demotion-test", version: "0" });
    const vault = await mkdtemp(path.join(tmpdir(), "oms-demotion-"));
    await cp(fixtureVault, vault, { recursive: true });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [distCli, "mcp", "--vault", vault], cwd: repoRoot, stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      const call = (name: string, arguments_: Record<string, unknown>) => {
        const tool = tools.get(name);
        expect(tool).toBeDefined();
        expectAdvertisedArguments(tool!, arguments_);
        return client.callTool({ name, arguments: arguments_ });
      };
      const demoted = ["oms_retrieve_by_axis", "oms_retrieve_context", "oms_lazy_load_note", "oms_list_concepts", "oms_semantic_query", "oms_semantic_collections", "oms_semantic_contexts", "oms_semantic_status", "oms_get_document", "oms_multi_get_documents", "oms_link_suggest", "oms_link_apply", "oms_graph_status", "oms_vault_audit", "oms_validate_contract", "oms_graph_build", "oms_semantic_cleanup", "oms_sync_embeddings", "query", "get", "multi_get", "status"];
      expect(names).not.toEqual(expect.arrayContaining(demoted));
      expect(payload(await call("oms_status", {})).derivedState).toBeDefined();
      expect(payload(await call("oms_doctor", { op: "audit", folder: "references" })).scannedNotes).toBeTypeOf("number");
      expect(payload(await call("oms_doctor", { op: "validate", notePath: "references/clean-architecture.md" })).valid).toBe(true);
      expect(payload(await call("oms_doctor", { op: "build-graph" })).notes).toBeTypeOf("number");
      expect(payload(await call("oms_search", { op: "concepts" })).concepts).toBeInstanceOf(Array);
      expect(payload(await call("oms_search", { op: "axis", folder: "references" })).hits).toBeInstanceOf(Array);
      expect(payload(await call("oms_search", { op: "context", folder: "references", useCache: false })).hits).toBeInstanceOf(Array);
      expect(payload(await call("oms_search", { op: "lazy-load", notePath: "references/clean-architecture.md" })).body).toBeTypeOf("string");
      expect(payload(await call("oms_search", { op: "get-document", target: "references/clean-architecture.md" })).documents).toBeInstanceOf(Array);
      expect(payload(await call("oms_search", { op: "multi-get-documents", targets: ["references/clean-architecture.md"] })).documents).toBeInstanceOf(Array);
      const suggested = payload(await call("oms_link", { op: "suggest", notePath: "references/clean-architecture.md" }));
      expect(suggested.baseContentHash).toBeTypeOf("string");
      const apply = await call("oms_link", { op: "apply", notePath: "references/clean-architecture.md", baseContentHash: "0".repeat(64), candidateIds: [] });
      expect(apply.content[0]?.type).toBe("text");
      for (const op of ["semantic-query", "semantic-collections", "semantic-contexts", "semantic-status"]) {
        const result = await call("oms_search", { op, ...(op === "semantic-query" ? { query: "architecture" } : {}) });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available|collections|contexts/,
        );
      }
      for (const op of ["semantic-cleanup", "sync-embeddings"]) {
        const result = await call("oms_doctor", { op });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
          /OMS_EMBEDDING_PROVIDER|available/,
        );
      }
      await expect(client.listResourceTemplates()).rejects.toThrow(/Method not found/);
    } finally { await client.close(); await rm(vault, { recursive: true, force: true }); }
  }, 120_000);
});
