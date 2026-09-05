import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { writeMorningVaultFixture } from "../kernel/search/morning-test-fixtures.js";

const calls: { sessions: unknown[]; queries: unknown[] } = { sessions: [], queries: [] };

vi.mock("./engine-session.js", () => ({
  runEngineSession: async (_vault: string, session: unknown, fn: (adapter: Record<string, unknown>) => Promise<unknown>) => {
    calls.sessions.push(session);
    return fn({
      semanticQuery: async (options: unknown) => {
        calls.queries.push(options);
        return { available: true, hits: [] };
      },
      semanticStatus: () => ({ available: true }),
      getDocument: async () => ({ available: true, documents: [] }),
      multiGetDocuments: async () => ({ available: true, documents: [] }),
    });
  },
}));

import { runSearchCommand } from "./search.js";

beforeEach(() => {
  calls.sessions.length = 0;
  calls.queries.length = 0;
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("search family", () => {
  it("runs a plain query lexically and preserves expansion and reranking", async () => {
    await runSearchCommand(["query", "plain query", "--vault", "/vault"]);
    expect(process.exitCode).toBe(0);
    expect(calls.queries[0]).toEqual(expect.objectContaining({
      query: "plain query",
      mode: "query",
      lex: undefined,
    }));

    await runSearchCommand([
      "query", "expanded", "--expand", "--max-queries", "2", "--rerank",
      "--vault", "/vault",
    ]);
    expect(calls.queries[1]).toEqual(expect.objectContaining({
      query: "expanded",
      rerank: true,
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 2 },
    }));
  });

  it("accepts all public query modes and rejects retired leaves", async () => {
    for (const mode of ["query", "search", "vsearch"]) {
      await runSearchCommand(["query", "needle", "--mode", mode, "--vault", "/vault"]);
      expect(process.exitCode).toBe(0);
    }
    for (const retired of ["semantic", "doc", "serve"]) {
      await runSearchCommand([retired, "--vault", "/vault"]);
      expect(process.exitCode).toBe(1);
    }
  });

  it("keeps explicit typed channels and rejects a missing query", async () => {
    await runSearchCommand(["query", "--vec", "vector text", "--vault", "/vault"]);
    expect(process.exitCode).toBe(0);
    expect(calls.queries[0]).toEqual(expect.objectContaining({ vec: "vector text" }));

    await runSearchCommand(["query", "--vault", "/vault"]);
    expect(process.exitCode).toBe(1);
  });

  it("routes context through the real morning-context retrieval", async () => {
    const vault = await writeMorningVaultFixture();
    try {
      await runSearchCommand([
        "context", "--query", "Agent Retrieval", "--limit", "2", "--vault", vault,
      ]);
      expect(process.exitCode).toBe(0);
      const receipt = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
      expect(receipt).toMatchObject({
        mode: "oms-local-graph-semantic-fusion",
        graph: { mode: "axis-seed-local-neighborhood" },
      });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
