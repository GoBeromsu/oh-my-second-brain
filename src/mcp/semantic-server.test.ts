import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("Oh My Second Brain MCP semantic stdio server", () => {
  it("runs typed semantic search and document rehydration through read-only MCP tools", async () => {
    // The clean swap routes oms_sync_embeddings / oms_semantic_query through the
    // native engine, which REQUIRES an explicitly configured embedding provider
    // (ADR-007). With OMS_EMBEDDING_PROVIDER + OMS_EMBEDDING_MODEL set we assert
    // real engine results end-to-end through stdio; without them we assert the
    // loud guard — a positive routing proof, since the legacy src/search hash
    // path would have returned available:true instead.
    const embeddingProvider = process.env["OMS_EMBEDDING_PROVIDER"];
    const embeddingModel = process.env["OMS_EMBEDDING_MODEL"];
    const hasModel =
      typeof embeddingProvider === "string" && embeddingProvider.length > 0 &&
      typeof embeddingModel === "string" && embeddingModel.length > 0;
    const tmpVault = await mkdtemp(path.join(tmpdir(), "oms-mcp-semantic-"));
    await mkdir(path.join(tmpVault, "references"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "references", "Agent Retrieval.md"),
      `---
title: Agent Retrieval
tags:
  - agent-graph
---
Agent retrieval follows [[Graph Index]] and preserves semantic evidence through OMS retrieve.
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
Index note for graph neighborhoods and semantic lookup.
`,
      "utf-8",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp", "--vault", tmpVault],
      cwd: repoRoot,
      stderr: "pipe",
      // StdioClientTransport sandboxes the child env to a safe default subset,
      // so the canonical embedding config must be forwarded for the engine path.
      ...(hasModel
        ? {
            env: {
              ...getDefaultEnvironment(),
              OMS_EMBEDDING_PROVIDER: embeddingProvider!,
              OMS_EMBEDDING_MODEL: embeddingModel!,
            },
          }
        : {}),
    });
    const client = new Client({ name: "oms-test-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      await client.callTool({
        name: "oms_doctor",
        arguments: { op: "sync-embeddings", embed: false },
      });
      const retrieve = textPayload(
        await client.callTool({
          name: "oms_search",
          arguments: { op: "context",
            property: "tags",
            value: "agent-graph",
            query: "fallback retrieve query",
            limit: 1,
            maxNeighbors: 5,
            useCache: false,
            semanticEnabled: true,
            semanticCollection: "obsidian",
            semanticLimit: 3,
            semanticMode: "query",
            semanticIntent: "route semantic evidence through oms retrieve",
            semanticLex: "exact semantic retrieval affordances",
            semanticVec: "semantic notes about retrieval integration",
            semanticHyde: "A note explaining how OMS semantic search is available from retrieve.",
            semanticMinScore: 0.01,
          },
        }),
      );
      // The Agent Retrieval note surfaces via the graph leg (axis tags=agent-graph)
      // regardless of model: with a model the semantic leg also ranks it; without
      // one the semantic leg degrades (sync loud-guards) and graph carries it.
      const retrieveHits = retrieve.hits as Array<Record<string, unknown>>;
      expect(retrieveHits.some((h) => h.path === "references/Agent Retrieval.md")).toBe(true);
      const docid = "references/Agent Retrieval.md";

      const syncRaw = await client.callTool({
        name: "oms_doctor",
        arguments: { op: "sync-embeddings", collection: "obsidian", ensureCollection: true, force: true, index: "brain" },
      });
      const queryCall = {
        name: "oms_search",
        arguments: { op: "query", query: "intent: qmd compatible MCP search\nlex: agent retr", collection: "obsidian", limit: 1 },
      };
      if (hasModel) {
        // Real engine path: sync builds the native store, query retrieves from it.
        // (The engine returns index=opts.index verbatim, not the vault-joined
        // path the legacy store resolved — so we assert availability, not index.)
        const sync = textPayload(syncRaw);
        expect(sync).toEqual(expect.objectContaining({ available: true }));
        const directQuery = textPayload(await client.callTool(queryCall));
        expect((directQuery.hits as Array<Record<string, unknown>>)[0]).toEqual(
          expect.objectContaining({ path: "references/Agent Retrieval.md" }),
        );
      } else {
        // Model-free path. Two different contracts apply here and the test
        // asserts both, because collapsing them is how ADR-007 gets eroded.
        //
        // Sync REQUIRES embeddings, so it must fail loudly and name what to
        // configure. A plain query does NOT: since the SearchBackend seam was
        // wired into production it expands to lexical only, so it returns real
        // hits rather than failing. Before that wiring this assertion read
        // `expect(queryRaw.isError).toBe(true)` - it encoded the pre-seam
        // hybrid behaviour, and the seam landing is what changed it.
        expect(syncRaw.isError).toBe(true);
        const syncText = syncRaw.content[0]?.type === "text" ? syncRaw.content[0].text : "";
        // Each element is asserted separately rather than as one alternation. An
        // `A|B` pattern passes when only A appears, so it would have accepted a
        // refusal naming half the contract; AC-10 requires the exact environment
        // pair, the vault contract file, and the command that installs a model.
        expect(syncText).toMatch(/OMS_EMBEDDING_PROVIDER/);
        expect(syncText).toMatch(/OMS_EMBEDDING_MODEL/);
        expect(syncText).toMatch(/\.oms\/models\.json/);
        expect(syncText).toMatch(/oms setup --models-default/);

        const plainQuery = textPayload(await client.callTool(queryCall));
        expect(plainQuery.available).toBe(true);
        expect((plainQuery.hits as Array<Record<string, unknown>>).length).toBeGreaterThan(0);

        // An EXPLICIT vector request still fails loudly. Lexical expansion is a
        // default for callers who did not choose a strategy, never a substitute
        // for one that was asked for and cannot run.
        const explicitVec = await client.callTool({
          name: "oms_search",
          arguments: {
            op: "query",
            searches: [{ type: "vec", query: "agent retrieval" }],
            collection: "obsidian",
            limit: 1,
          },
        });
        const vecText = explicitVec.content[0]?.type === "text" ? explicitVec.content[0].text : "";
        expect(vecText).toMatch(/OMS_EMBEDDING_PROVIDER/);
        expect(vecText).toMatch(/OMS_EMBEDDING_MODEL/);
        expect(vecText).toMatch(/\.oms\/models\.json/);
        expect(vecText).toMatch(/oms setup --models-default/);
        // The remedy must be the embed one. Naming the rerank or generate pair here
        // would send an agent to install a model that cannot serve a vector request.
        expect(vecText).not.toMatch(/OMS_RERANK_PROVIDER|OMS_GENERATE_PROVIDER/);

        const lexOnlyQuery = textPayload(
          await client.callTool({
            name: "oms_search",
            arguments: { op: "query", query: "", lex: "agent retrieval", collection: "obsidian", limit: 1 },
          }),
        );
        expect((lexOnlyQuery.hits as Array<Record<string, unknown>>)[0]).toEqual(
          expect.objectContaining({ path: "references/Agent Retrieval.md" }),
        );
      }

      await expect(client.listResourceTemplates()).rejects.toThrow(/Method not found/);

      const single = textPayload(
        await client.callTool({
          name: "oms_search",
          arguments: { op: "get-document", target: `${docid}:1:20`, collection: "obsidian", fullPath: true },
        }),
      );
      const batch = textPayload(
        await client.callTool({
          name: "oms_search",
          arguments: { op: "multi-get-documents", targets: ["references/*.md", docid], lineLimit: 40, maxBytes: 2048 },
        }),
      );
      expect((single.documents as Array<Record<string, unknown>>)[0]).toEqual(
        expect.objectContaining({ path: path.join(tmpVault, "references", "Agent Retrieval.md") }),
      );
      expect((batch.documents as Array<Record<string, unknown>>).map((doc) => doc.path)).toEqual([
        "references/Agent Retrieval.md",
        "references/Graph Index.md",
      ]);
    } finally {
      await client.close();
      await rm(tmpVault, { recursive: true, force: true });
    }
  }, 120_000);
});
