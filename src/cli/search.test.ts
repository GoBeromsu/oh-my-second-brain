import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { sessions: unknown[]; queries: unknown[]; syncs: unknown[] } = {
  sessions: [],
  queries: [],
  syncs: [],
};

vi.mock("./engine-session.js", () => ({
  runEngineSession: async (_vault: string, session: unknown, fn: (adapter: Record<string, unknown>) => Promise<unknown>) => {
    calls.sessions.push(session);
    return fn({
      semanticQuery: async (options: unknown) => {
        calls.queries.push(options);
        return { available: true, hits: [] };
      },
      syncEmbeddings: async (options: unknown) => {
        calls.syncs.push(options);
        return { available: true };
      },
      semanticStatus: async () => ({ available: true }),
      cleanup: async () => ({ available: true }),
      listCollections: () => ({ available: true, collections: [{ name: "default" }] }),
      listContexts: async () => ({ available: true, contexts: [] }),
      getDocument: async () => ({ available: true, document: {} }),
      multiGetDocuments: async () => ({ available: true, documents: [] }),
    });
  },
}));

import { isSearchCliCommand, runSearchCli, TOP_LEVEL_COMMANDS } from "./search.js";

beforeEach(() => {
  calls.sessions.length = 0;
  calls.queries.length = 0;
  calls.syncs.length = 0;
});

function cli(argv: readonly string[]): Promise<number> {
  return runSearchCli({ argv, vault: "/vault", write: vi.fn(), writeError: vi.fn() });
}

describe("search CLI", () => {
  it("exposes only the approved top-level commands", () => {
    expect([...TOP_LEVEL_COMMANDS]).toEqual(["search", "index", "doc", "embed", "serve"]);
    for (const command of TOP_LEVEL_COMMANDS) expect(isSearchCliCommand(command)).toBe(true);
    for (const retired of ["semantic", "query", "vsearch", "http", "collection", "context", "cleanup"]) {
      expect(isSearchCliCommand(retired)).toBe(false);
    }
  });

  it("runs plain search lexically and preserves explicit expand and rerank", async () => {
    expect(await cli(["search", "plain query"])).toBe(0);
    expect(calls.queries[0]).toEqual(expect.objectContaining({ query: "plain query", mode: "query", lex: undefined }));

    expect(await cli(["search", "expanded", "--expand", "--max-queries", "2", "--rerank"])).toBe(0);
    expect(calls.queries[1]).toEqual(expect.objectContaining({
      query: "expanded",
      rerank: true,
      strategy: { kind: "expand", profile: "qmd-v2.8.3", maxQueries: 2 },
    }));
  });

  it("pins top-level embed and index sync to their respective embedding modes", async () => {
    expect(await cli(["embed"])).toBe(0);
    expect(await cli(["index", "sync"])).toBe(0);
    expect(calls.sessions).toEqual([
      { write: true, embed: true },
      { write: true, embed: false },
    ]);
    expect(calls.syncs).toEqual([
      expect.objectContaining({ embed: true }),
      expect.objectContaining({ embed: false }),
    ]);
  });

  it("routes index status, cleanup, collections, contexts and document reads", async () => {
    for (const argv of [
      ["index", "status"],
      ["index", "cleanup"],
      ["index", "collections"],
      ["index", "contexts"],
      ["doc", "get", "note.md"],
      ["doc", "multi-get", "one.md", "two.md"],
    ]) expect(await cli(argv)).toBe(0);
  });

  it("rejects retired semantic routes and index embed", async () => {
    for (const argv of [["semantic", "search", "q"], ["index", "embed"], ["http"]]) {
      expect(await cli(argv)).toBe(1);
    }
  });
});
