import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dispatch, applyProvenanceBoost } from "../kernel/engine/retrieval/dispatcher.js";
import type { DispatcherDeps } from "../kernel/engine/retrieval/dispatcher.js";
import type { EmbeddingProvider, ScoredHit, VectorStore } from "../kernel/engine/types.js";
import { createOMSMcpServer } from "../mcp/server.js";
import { isSemanticCliCommand, runSemanticCli } from "./semantic.js";

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

async function writeVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-cli-semantic-"));
  await mkdir(path.join(vault, "references"), { recursive: true });
  await writeFile(
    path.join(vault, "references", "Agent Retrieval.md"),
    `---
title: Agent Retrieval
---
# Agent Retrieval

Agent retrieval uses native OMS semantic search.
`,
    "utf-8",
  );
  return vault;
}

function jsonOutput(output: readonly string[]): Record<string, unknown> {
  const raw = output.at(-1);
  if (!raw) throw new Error("Expected JSON output.");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object output.");
  }
  return parsed;
}

describe("semantic CLI", () => {
  it("ships the released additive provenance baseline and keeps k-scale on the RRF scale", async () => {
    const authored: ScoredHit = { docPath: "authored.md", chunkOrdinal: 0, score: 1 };
    const lexical = Array.from({ length: 10 }, (_, index) => ({
      docPath: index === 0 ? "shared.md" : index === 9 ? authored.docPath : `other-${index}.md`,
      chunkOrdinal: 0,
      score: 10 - index,
    }));
    const shared: ScoredHit = { docPath: "shared.md", chunkOrdinal: 0, score: 1 };
    const store: VectorStore = {
      upsert: vi.fn(),
      queryLex: vi.fn().mockReturnValue(lexical),
      queryVec: vi.fn().mockReturnValue([shared]),
      close: vi.fn(),
    };
    const embed: EmbeddingProvider = {
      model: "test",
      dimensions: 1,
      embed: vi.fn().mockResolvedValue(new Float32Array([1])),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const deps: DispatcherDeps = {
      store,
      embed,
      provenanceMap: (docPath) => docPath === authored.docPath ? "authored" : "external-raw",
    };

    const subQueries = [{ type: "lex" as const, query: "q" }, { type: "vec" as const, query: "q" }];

    expect(applyProvenanceBoost(1, "authored")).toBeCloseTo(1.02, 10);
    expect(applyProvenanceBoost(1, "curated")).toBeCloseTo(1.01, 10);
    expect(applyProvenanceBoost(1, "external-raw")).toBe(1);

    // Shipped default: the released additive baseline adds the raw boost to the
    // fused RRF score. The constant is large relative to RRF spacing, which is
    // exactly the behaviour C040 is preregistered to measure - so it must stay
    // observable rather than silently replaced by an unmeasured policy.
    const baseline = await dispatch(subQueries, deps);
    const baselineAuthored = baseline.find((result) => result.docPath === authored.docPath);
    expect(baselineAuthored?.score).toBeCloseTo(1 / 70 + 0.02, 10);
    expect(baseline.find((result) => result.docPath === shared.docPath)?.score)
      .toBeCloseTo(1 / 61 + 1 / 61, 10);

    // Preregistered experiment arm: k-scale keeps the boost on the RRF scale, so
    // a single low-ranked authored hit cannot overtake a doubly-retrieved note.
    const kScale = await dispatch(subQueries, { ...deps, policy: "boost-k-scale" });
    expect(kScale[0]?.docPath).toBe(shared.docPath);
    expect(kScale.find((result) => result.docPath === authored.docPath)?.score).toBeLessThan(
      kScale[0]?.score ?? 0,
    );
  });

  it("runs a lex-only sync and lexical search through the native engine", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    // Model-less: --no-embed performs a lexical-only sync (no vectors fabricated).
    const syncCode = await runSemanticCli({
      argv: ["semantic", "sync", "--collection", "obsidian", "--no-embed"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(syncCode).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, storage: "oms-native-json" }));

    const searchCode = await runSemanticCli({
      argv: ["semantic", "search", "--lex", "agent retrieval", "-c", "obsidian", "-n", "1"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(searchCode).toBe(0);
    const search = jsonOutput(output);
    const hits = search["hits"];
    expect(Array.isArray(hits)).toBe(true);
    const hit = Array.isArray(hits) ? hits[0] : undefined;
    if (typeof hit !== "object" || hit === null || Array.isArray(hit)) throw new Error("Expected hit object.");
    expect(hit).toEqual(expect.objectContaining({ path: "references/Agent Retrieval.md" }));

    output.length = 0;
    const plainSearchCode = await runSemanticCli({
      argv: ["semantic", "search", "agent retrieval", "-c", "obsidian", "-n", "1"],
      vault: tmpVault,
      write: (message) => output.push(message),
    });
    expect(plainSearchCode).toBe(0);
    const plainSearch = jsonOutput(output);
    expect(plainSearch).toEqual(expect.objectContaining({
      available: true,
      receipt: expect.objectContaining({ usedChannels: ["lex"], approximated: false }),
    }));
    const plainHits = plainSearch["hits"];
    expect(Array.isArray(plainHits)).toBe(true);
    if (!Array.isArray(plainHits)) throw new Error("Expected plain lexical hit array.");
    expect(plainHits[0]).toEqual(expect.objectContaining({ path: "references/Agent Retrieval.md" }));
  });

  it("lists the engine collection and contexts", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];

    expect(
      await runSemanticCli({
        argv: ["collection", "list"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual({
      collections: [expect.objectContaining({ name: "default" })],
    });

    expect(
      await runSemanticCli({
        argv: ["context", "list"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true, contexts: expect.any(Array) }));

    expect(
      await runSemanticCli({
        argv: ["semantic", "cleanup"],
        vault: tmpVault,
        write: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: true }));
  });

  it("dispatches canonical nested query, status, get, multi-get, and vsearch commands", async () => {
    tmpVault = await writeVault();
    const output: string[] = [];
    const write = (message: string) => output.push(message);

    expect(
      await runSemanticCli({
        argv: ["semantic", "sync", "--collection", "obsidian", "--no-embed"],
        vault: tmpVault,
        write,
      }),
    ).toBe(0);

    for (const [argv, expectedCode] of [
      [["semantic", "query", "agent retrieval", "--lex", "agent retrieval"], 0],
      [["semantic", "status"], 0],
      [["semantic", "get", "references/Agent Retrieval.md"], 0],
      [["semantic", "multi-get", "references/Agent Retrieval.md"], 0],
      [["semantic", "vsearch", "agent retrieval"], 1],
    ] as const) {
      output.length = 0;
      expect(await runSemanticCli({ argv, vault: tmpVault, write })).toBe(expectedCode);
      expect(jsonOutput(output)).toEqual(expect.objectContaining({ available: expect.any(Boolean) }));
    }

    expect(isSemanticCliCommand("search")).toBe(true);
    for (const alias of ["query", "vsearch", "get", "multi-get", "status"]) {
      expect(isSemanticCliCommand(alias)).toBe(false);
    }
  });

  it("applies reranking on the MCP ephemeral lexical fallback", async () => {
    tmpVault = await writeVault();
    await writeFile(
      path.join(tmpVault, "references", "Second Retrieval.md"),
      "# Second Retrieval\n\nAgent retrieval appears in this note too.\n",
      "utf-8",
    );
    const rerank = vi.fn(async (_query: string, hits: ScoredHit[]) =>
      [...hits].reverse().map((hit, index) => ({ ...hit, score: hits.length - index })),
    );
    const server = createOMSMcpServer({
      vault: tmpVault,
      source: "explicit",
      reranker: { rerank },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "oms-cli-semantic-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "oms_search",
        arguments: {
          op: "query",
          query: "agent retrieval",
          lex: "agent retrieval",
          candidateLimit: 10,
          limit: 2,
          rerank: true,
        },
      });
      const payload = JSON.parse(response.content[0]?.type === "text" ? response.content[0].text : "{}") as {
        hits?: { path: string }[];
      };
      expect(rerank).toHaveBeenCalledWith("agent retrieval", expect.any(Array));
      const candidates = rerank.mock.calls[0]?.[1] ?? [];
      expect(payload.hits?.map((hit) => hit.path)).toEqual(
        [...candidates].reverse().slice(0, 2).map((hit) => hit.docPath),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps CLI read commands from creating an index", async () => {
    tmpVault = await writeVault();
    const commands = [
      ["semantic", "status"],
      ["semantic", "query", "agent retrieval", "--lex", "agent retrieval"],
      ["semantic", "search", "agent retrieval"],
      ["semantic", "vsearch", "agent retrieval"],
      ["semantic", "get", "references/Agent Retrieval.md"],
      ["semantic", "multi-get", "references/Agent Retrieval.md"],
    ] as const;

    for (const argv of commands) {
      const output: string[] = [];
      await runSemanticCli({ argv, vault: tmpVault, write: (message) => output.push(message) });
      expect(output).not.toHaveLength(0);
    }

    expect(await readdir(tmpVault)).toEqual(["references"]);
  });
});
