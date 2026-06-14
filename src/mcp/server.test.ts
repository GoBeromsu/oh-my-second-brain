import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("Oh My Second Brain MCP stdio server", () => {
  it("exposes read/status tools and validates a fixture note", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", fixtureVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual([
        "oms_graph_status",
        "oms_graph_build",
        "oms_list_concepts",
        "oms_retrieve_by_axis",
        "oms_retrieve_context",
        "oms_sync_embeddings",
        "oms_semantic_query",
        "oms_semantic_status",
        "oms_semantic_collections",
        "oms_semantic_contexts",
        "oms_semantic_cleanup",
        "oms_get_document",
        "query",
        "status",
        "get",
        "multi_get",
        "oms_multi_get_documents",
        "oms_lazy_load_note",
        "oms_validate_contract",
        "oms_capture_prepare",
        "oms_capture_commit",
      ]);
      const commitTool = tools.tools.find((tool) => tool.name === "oms_capture_commit");
      expect(commitTool?.annotations?.readOnlyHint).toBe(false);
      expect(commitTool?.annotations?.destructiveHint).toBe(false);
      const retrieveTool = tools.tools.find((tool) => tool.name === "oms_retrieve_context");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("semanticMinScore");
      expect(JSON.stringify(retrieveTool?.inputSchema)).toContain("semanticStorage");
      expect(retrieveTool?.annotations?.readOnlyHint).toBe(false);
      const semanticStatusTool = tools.tools.find((tool) => tool.name === "oms_semantic_status");
      expect(JSON.stringify(semanticStatusTool?.inputSchema)).toContain("storage");
      const semanticQueryTool = tools.tools.find((tool) => tool.name === "oms_semantic_query");
      expect(JSON.stringify(semanticQueryTool?.inputSchema)).toContain("modelPath");
      const getTool = tools.tools.find((tool) => tool.name === "oms_get_document");
      expect(getTool?.annotations?.readOnlyHint).toBe(true);
      expect(getTool?.annotations?.destructiveHint).toBe(false);

      const status = await client.callTool({ name: "oms_graph_status", arguments: {} });
      const parsedStatus = textPayload(status);
      expect(parsedStatus.writeTools).toBe(
        "capture-commit-gated-by-vault-confinement-and-contract-validation",
      );
      expect(parsedStatus.counts.concepts).toBeGreaterThan(0);
      const derivedState = parsedStatus.derivedState as Record<string, unknown>;
      const staleness = derivedState.staleness as Record<string, unknown>;
      expect(staleness.graphStale).toBe(true);

      const validation = await client.callTool({
        name: "oms_validate_contract",
        arguments: { notePath: "references/clean-architecture.md" },
      });
      const parsedValidation = textPayload(validation);
      expect(parsedValidation.valid).toBe(true);
      expect(parsedValidation.concept).toBe("literature");
    } finally {
      await client.close();
    }
  });

  it("retrieves live graph context without requiring a warm cache or semantic backend", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-retrieve-"));
    await mkdir(path.join(tmpVault, "references"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "references", "Agent Retrieval.md"),
      `---
title: Agent Retrieval
tags:
  - agent-graph
---
Agent retrieval follows [[Graph Index]].
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Graph Index.md"),
      `---
title: Graph Index
tags:
  - agent-graph
---
Index note.
`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpVault, "references", "Malformed.md"),
      `---
title: [broken
---
Malformed frontmatter must not block retrieve.
`,
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const result = textPayload(
        await client.callTool({
          name: "oms_retrieve_context",
          arguments: {
            property: "tags",
            value: "agent-graph",
            query: "agent retrieval graph",
            limit: 1,
            maxNeighbors: 5,
            useCache: false,
            semanticEnabled: false,
          },
        }),
      );

      expect(result.mode).toBe("oms-local-graph-semantic-fusion");
      const providers = result.providers as Record<string, unknown>;
      expect(providers.graph).toBe("headless-scan");
      expect(providers.semantic).toEqual({ available: false, reason: "disabled" });
      const hits = result.hits as Array<Record<string, unknown>>;
      expect(hits.map((hit) => hit.source)).toEqual(["oms-seed", "oms-neighbor"]);
      expect(hits.map((hit) => hit.path)).toContain("references/Graph Index.md");
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("reports invalid local .oms instead of falling back to bundled defaults", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-invalid-"));
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "taxonomy.yaml"), "not: [valid", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("disabled-invalid-ontology");

      const commit = await client.callTool({
        name: "oms_capture_commit",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          mode: "create",
        },
      });
      expect(commit.isError).toBe(true);
      expect(commit.content[0]?.type === "text" ? commit.content[0].text : "").toContain(
        "Oh My Second Brain MCP error",
      );
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("does not treat cache-only .oms as a broken local ontology", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-cache-only-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      expect(textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} })).ontologySource).toBe(
        "bundled",
      );

      await client.callTool({ name: "oms_graph_build", arguments: {} });

      expect(textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} })).ontologySource).toBe(
        "bundled",
      );
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });

  it("treats a non-directory .oms path as invalid instead of using bundled defaults", async () => {
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-file-"));
    await writeFile(path.join(tmpVault, ".oms"), "not a directory", "utf-8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const status = textPayload(await client.callTool({ name: "oms_graph_status", arguments: {} }));
      expect(status.ontologySource).toBe("vault-invalid");
      expect(status.writeTools).toBe("disabled-invalid-ontology");

      const commit = await client.callTool({
        name: "oms_capture_commit",
        arguments: {
          notePath: "references/unsafe.md",
          frontmatter: {
            title: "Should not write",
            "source-url": "https://example.com/should-not-write",
          },
          body: "Should not write.",
          mode: "create",
        },
      });
      expect(commit.isError).toBe(true);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  });
});
