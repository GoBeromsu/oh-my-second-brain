import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleCoreSemanticEngine, type AssembledEngine } from "../engine/assemble.js";
import { EngineSearchBackend, requiresEmbeddings } from "./engine-search-backend.js";
import type { SearchBackend } from "./search-backend.js";
import type { Reranker } from "../engine/retrieval/reranker.js";
import type { ScoredHit } from "../engine/types.js";
import type { McpEngineAdapter } from "../engine/mcp/facade.js";

const vaults: string[] = [];

afterEach(async () => {
  await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })));
});

async function fixtureVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-backend-"));
  vaults.push(vault);
  await writeFile(
    path.join(vault, "orbital-notes.md"),
    "# Orbital Telescope\nA telescope observes planets in orbit around distant stars.\n",
    "utf8",
  );
  await writeFile(
    path.join(vault, "recipe.md"),
    "# Recipe\nA telescope observes planets in orbit while a baker kneads bread dough.\n",
    "utf8",
  );
  return vault;
}

async function defaultLimitFixtureVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-backend-default-limit-"));
  vaults.push(vault);
  await Promise.all(
    Array.from({ length: 75 }, (_, index) => writeFile(
      path.join(vault, `common-${index}.md`),
      `# Common ${index}\ncommon retrieval fixture ${index}\n`,
      "utf8",
    )),
  );
  return vault;
}

async function collectionFixtureVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-backend-collections-"));
  vaults.push(vault);
  await mkdir(path.join(vault, "architecture"), { recursive: true });
  await mkdir(path.join(vault, "recipes"), { recursive: true });
  await writeFile(path.join(vault, "architecture", "system.md"), "# Architecture\nSystem design architecture.\n", "utf8");
  await writeFile(path.join(vault, "recipes", "system.md"), "# Recipe\nSystem design architecture.\n", "utf8");
  return vault;
}

async function collectionOrderingFixtureVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-backend-collection-ordering-"));
  vaults.push(vault);
  await mkdir(path.join(vault, "architecture"), { recursive: true });
  await mkdir(path.join(vault, "recipes"), { recursive: true });
  await writeFile(path.join(vault, "architecture", "match.md"), "# Architecture\ncollection scope ordering target\n", "utf8");
  await writeFile(path.join(vault, "recipes", "first.md"), "# Recipe\ncollection scope ordering target\n", "utf8");
  await writeFile(path.join(vault, "recipes", "second.md"), "# Recipe\ncollection scope ordering target\n", "utf8");
  return vault;
}

async function linkHeavyFacetVault(): Promise<string> {
  const vault = await mkdtemp(path.join(tmpdir(), "oms-search-backend-link-facets-"));
  vaults.push(vault);
  await mkdir(path.join(vault, "corpus"), { recursive: true });
  await mkdir(path.join(vault, "targets"), { recursive: true });
  const linkTargets = Array.from({ length: 611 }, (_, index) => `targets/link-${String(index).padStart(3, "0")}.md`);
  await Promise.all(linkTargets.map((target) => writeFile(
    path.join(vault, target),
    "# Link target\nresolved outgoing link only\n",
    "utf8",
  )));
  const links = linkTargets.map((target) => `[[${target}]]`).join(" ");
  await Promise.all(Array.from({ length: 165 }, (_, index) => writeFile(
    path.join(vault, "corpus", `match-${String(index).padStart(3, "0")}.md`),
    `# Match ${index}\nshared facet token\n${links}\n`,
    "utf8",
  )));
  return vault;
}

function expectFacetSummary(
  result: { readonly facets: readonly { readonly axis: string; readonly value: string; readonly count: number }[]; readonly receipt: { readonly warnings: readonly string[] } },
  total: number,
): void {
  expect(result.facets).toHaveLength(Math.min(20, total));
  const warning = result.receipt.warnings.find((entry) => entry.startsWith("Facets truncated:"));
  if (total <= 20) {
    expect(warning).toBeUndefined();
    return;
  }
  expect(warning).toBe(`Facets truncated: showing 20 of ${total} distinct values.`);
}
const CORPUS_MATCH_QUERY = {
  query: "shared facet token",
  collectionPath: "corpus",
} as const;

function searchBackendConformance(
  name: string,
  create: (vault: string) => { backend: SearchBackend; dispose(): Promise<void> },
): void {
  describe(`${name} SearchBackend conformance`, () => {
    it("returns the matching fixture document for a typed lexical search", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          searches: [{ type: "lex", query: "telescope planets orbit" }],
          limit: 1,
          intent: "astronomy notes",
        });

        expect(result.available).toBe(true);
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]).toMatchObject({
          path: "orbital-notes.md",
          evidence: { lexical: true, vector: false },
        });
      } finally {
        await dispose();
      }
    });

    it("returns the matching fixture document for a plain query", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({ query: "telescope planets orbit", limit: 5 });

        expect(result.available).toBe(true);
        expect(result.hits.map((hit) => hit.path)).toContain("orbital-notes.md");
      } finally {
        await dispose();
      }
    });

    it("honours limit", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({ query: "the", limit: 1 });
        expect(result.hits.length).toBeLessThanOrEqual(1);
      } finally {
        await dispose();
      }
    });

    it("defaults an options-free query to ten results", async () => {
      const vault = await defaultLimitFixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({ query: "common retrieval fixture" });

        expect(result.available).toBe(true);
        expect(result.hits).toHaveLength(10);
        expect(result.totalCount).toBe(75);
        expect(result.cursor).toBe("10");

        const all = await backend.search({
          query: "common retrieval fixture",
          limit: 75,
        });
        expect(all.available).toBe(true);
        if (!all.available) return;

        const page = await backend.search({
          query: "common retrieval fixture",
          cursor: result.cursor ?? undefined,
        });
        expect(page.available).toBe(true);
        expect(page.totalCount).toBe(75);
        expect(page.hits.map((hit) => hit.path)).toEqual(
          all.hits.slice(10, 20).map((hit) => hit.path),
        );
      } finally {
        await dispose();
      }
    });

    it("honours candidateLimit before result limiting", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({ query: "telescope planets orbit", candidateLimit: 1, limit: 5 });
        expect(result.hits).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it.each([
      ["fractional limit", { query: "telescope", limit: 1.5 }],
      ["non-finite limit", { query: "telescope", limit: Number.POSITIVE_INFINITY }],
      ["zero candidate limit", { query: "telescope", candidateLimit: 0 }],
      ["non-finite candidate limit", { query: "telescope", candidateLimit: Number.NaN }],
      ["non-finite score", { query: "telescope", minScore: Number.NEGATIVE_INFINITY }],
    ] as const)("rejects invalid query budget: %s", async (_case, request) => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        await expect(backend.search(request)).rejects.toThrow(/limit|finite|score/i);
      } finally {
        await dispose();
      }
    });

    it("filters results to the requested collections", async () => {
      const vault = await collectionFixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          searches: [{ type: "lex", query: "system design architecture" }],
          collections: ["architecture"],
        });

        expect(result.available).toBe(true);
        expect(result.hits).not.toHaveLength(0);
        expect(result.hits.map((hit) => hit.path)).toEqual(["architecture/system.md"]);
      } finally {
        await dispose();
      }
    });

    it("scopes candidates before candidateLimit can be consumed by another collection", async () => {
      const vault = await collectionOrderingFixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          searches: [{ type: "lex", query: "collection scope ordering target" }],
          collections: ["architecture"],
          candidateLimit: 1,
          limit: 1,
        });

        expect(result.available).toBe(true);
        expect(result.hits.map((hit) => hit.path)).toEqual(["architecture/match.md"]);
      } finally {
        await dispose();
      }
    });

    it("returns no hits rather than failing when nothing matches", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          searches: [{ type: "lex", query: "zzzzz-no-such-token-zzzzz" }],
        });

        // An empty result set is a valid answer. A backend that throws here
        // would force every caller to distinguish "no matches" from "broken".
        expect(result.available).toBe(true);
        expect(result.hits).toEqual([]);
      } finally {
        await dispose();
      }
    });

    it("serves an explicit empty query as a portable overview envelope", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({ query: "", limit: 1 });

        expect(result.available).toBe(true);
        expect(result.totalCount).toBe(2);
        expect(result.hits).toHaveLength(1);
        expect(result.cursor).toBe("1");
      } finally {
        await dispose();
      }
    });

    it.each([
      ["typed vec search", { searches: [{ type: "vec", query: "telescope planets orbit" }] }],
      ["vec shorthand", { searches: [{ type: "vec", query: "telescope planets orbit" }] }],
      ["hyde shorthand", { searches: [{ type: "hyde", query: "telescope planets orbit" }] }],
      ["vsearch mode", { query: "telescope planets orbit", mode: "vsearch" }],
    ] as const)(
      "reports actionable configuration guidance for an explicit vector strategy: %s",
      async (_strategy, request) => {
        const vault = await fixtureVault();
        const { backend, dispose } = create(vault);
        try {
          const result = await backend.search(request);

          // ADR-007 locks no-fake-fallback: an explicitly requested strategy that
          // cannot run must say so, not silently return lexical results dressed
          // up as vector ones. The reason has to name what to configure.
          expect(result.available).toBe(false);
          expect(result.reason ?? "").toMatch(/OMS_EMBEDDING_PROVIDER/);
          expect(result.reason ?? "").toMatch(/OMS_EMBEDDING_MODEL/);
        } finally {
          await dispose();
        }
      },
    );

    it("refuses a mode that contradicts explicit searches rather than dropping it", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        // The sixth spelling a red-team lane found: `mode: "vsearch"` was
        // honoured on the plain-query path but silently ignored when `searches`
        // was also supplied, so an explicit vector request came back as lexical
        // hits. Refusing contradictory input beats picking one signal - dropping
        // either one is how a caller ends up believing they got vector results.
        const contradictory = {
          mode: "vsearch",
          searches: [{ type: "lex", query: "telescope" }],
        } as unknown as Parameters<SearchBackend["search"]>[0];

        await expect(backend.search(contradictory)).rejects.toThrow(/contradictory/i);
      } finally {
        await dispose();
      }
    });

    it("decides on every explicit-strategy signal, not just the one it happens to read", () => {
      // Guards the decision point directly. Each signal below must be sufficient
      // on its own; a regression that inspects only `searches` passes the cases
      // above and fails here.
      expect(requiresEmbeddings({ searches: [{ type: "vec", query: "x" }] })).toBe(true);
      expect(requiresEmbeddings({ searches: [{ type: "hyde", query: "x" }] })).toBe(true);
      expect(requiresEmbeddings({ mode: "vsearch" })).toBe(true);
      expect(requiresEmbeddings({ vec: "x" })).toBe(true);
      expect(requiresEmbeddings({ hyde: "x" })).toBe(true);
      expect(requiresEmbeddings({
        strategy: { kind: "expand", profile: "qmd-v2.8.3" },
      })).toBe(true);
      // A lexical sub-search alongside an explicit vector mode still counts.
      expect(requiresEmbeddings({ mode: "vsearch", searches: [{ type: "lex", query: "x" }] })).toBe(true);
      // Nothing explicit: plain queries stay lexical and must NOT demand a model.
      expect(requiresEmbeddings({})).toBe(false);
      expect(requiresEmbeddings({ searches: [{ type: "lex", query: "x" }] })).toBe(false);
    });

    it("admits explicit expansion only after embedding capability is available", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          query: "telescope planets orbit",
          strategy: { kind: "expand", profile: "qmd-v2.8.3" },
        });

        expect(result.available).toBe(false);
        expect(result.reason ?? "").toMatch(/OMS_EMBEDDING_PROVIDER/);
        expect(result.reason ?? "").toMatch(/OMS_EMBEDDING_MODEL/);
        expect(result.reason ?? "").toMatch(/\.oms\/models\.json/);
        expect(result.reason ?? "").toMatch(/oms setup --models-default/);
        expect(result.receipt.requestedStrategy).toBe("expand");
      } finally {
        await dispose();
      }
    });



    it("rejects a request carrying both query and searches", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        // The XOR is expressed in the type, but a request parsed from JSON is
        // unchecked at runtime, so the backend has to enforce it too.
        const both = {
          query: "telescope",
          searches: [{ type: "lex", query: "telescope" }],
        } as unknown as Parameters<SearchBackend["search"]>[0];

        await expect(backend.search(both)).rejects.toThrow();
      } finally {
        await dispose();
      }
    });

    it("rejects a request carrying neither query nor searches", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const neither = {} as unknown as Parameters<SearchBackend["search"]>[0];
        await expect(backend.search(neither)).rejects.toThrow();
      } finally {
        await dispose();
      }
    });
  });
}

describe("EngineSearchBackend collection envelope", () => {
  it("merges facets and receipts instead of dropping metadata", async () => {
    const adapter = {
      semanticQuery: vi.fn(async ({ collectionPath }: { readonly collectionPath?: string }) => {
        const path = collectionPath ?? "all";
        const score = path === "first" ? 0.4 : 0.9;
        return {
          available: true as const,
          hits: [{
            docid: `${path}.md`,
            score,
            uri: `vault://${path}.md`,
            path: `${path}.md`,
            snippet: "",
            evidence: { lexical: true, vector: false },
          }],
          totalCount: 1,
          facets: [{
            axis: "folder" as const,
            value: path,
            count: 1,
            intent: `${path} intent`,
          }],
          cursor: null,
          intent: "adapter intent",
          receipt: {
            usedChannels: [path === "first" ? "lex" as const : "vec" as const],
            approximated: path !== "first",
            indexDrift: path === "first",
          },
        };
      }),
    } as unknown as McpEngineAdapter;
    const backend = new EngineSearchBackend(adapter, "/vault");

    const result = await backend.search({
      query: "query",
      collections: ["first", "second"],
      limit: 1,
      intent: "request intent",
    });

    expect(result).toMatchObject({
      available: true,
      totalCount: 2,
      cursor: "1",
      intent: "request intent",
      facets: [
        { axis: "folder", value: "first", count: 1, intent: "first intent" },
        { axis: "folder", value: "second", count: 1, intent: "second intent" },
      ],
      receipt: {
        usedChannels: ["lex", "vec"],
        approximated: true,
        indexDrift: true,
      },
    });
    if (result.available) expect(result.hits).toHaveLength(1);
  });

  it("deduplicates document hits before global cursor paging", async () => {
    const adapter = {
      semanticQuery: vi.fn(async ({ collectionPath }: { readonly collectionPath?: string }) => ({
        available: true as const,
        hits: [{
          docid: "shared.md",
          score: collectionPath === "first" ? 0.4 : 0.9,
          uri: "vault://shared.md",
          path: "shared.md",
          snippet: "",
          evidence: {
            lexical: collectionPath === "first",
            vector: collectionPath !== "first",
          },
        }],
        totalCount: 1,
        facets: [],
        cursor: null,
        receipt: { usedChannels: ["lex" as const], approximated: false, indexDrift: false },
      })),
    } as unknown as McpEngineAdapter;
    const backend = new EngineSearchBackend(adapter, "/vault");

    const result = await backend.search({
      query: "query",
      collections: ["first", "second"],
      limit: 1,
    });

    expect(result).toMatchObject({
      available: true,
      totalCount: 1,
      cursor: null,
      hits: [{
        path: "shared.md",
        score: 0.9,
        evidence: { lexical: true, vector: true },
      }],
    });
  });
});

describe("EngineSearchBackend merged facet summary", () => {
  it("caps merged collection facets after combining complete child inputs", async () => {
    const childFacets = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      axis: "link" as const,
      value: `${prefix}-${String(index).padStart(3, "0")}`,
      count: 1,
      intent: `Link axis: ${prefix}-${index}`,
    }));
    const shared = {
      axis: "folder" as const,
      value: "shared",
      count: 4,
      intent: "Folder axis: shared",
    };
    const adapter = {
      semanticQuery: vi.fn(async ({ collectionPath, limit }: { readonly collectionPath?: string; readonly limit?: number }) => {
        expect(limit).toBeUndefined();
        const prefix = collectionPath ?? "missing";
        return {
          available: true as const,
          hits: [{
            docid: `${prefix}.md`,
            score: prefix === "zeta" ? 0.2 : 0.8,
            uri: `vault://${prefix}.md`,
            path: `${prefix}.md`,
            snippet: "",
            evidence: { lexical: true, vector: false },
          }],
          totalCount: 1,
          facets: [shared, ...childFacets(prefix, 21)],
          cursor: null,
          receipt: {
            usedChannels: ["lex" as const],
            approximated: false,
            indexDrift: false,
            warnings: [`${prefix} warning`],
          },
        };
      }),
    } as unknown as McpEngineAdapter;
    const backend = new EngineSearchBackend(adapter, "/vault");
    const forward = await backend.search({ query: "query", collections: ["alpha", "zeta"], limit: 1 });
    const reverse = await backend.search({ query: "query", collections: ["zeta", "alpha"], limit: 1 });

    expect(adapter.semanticQuery).toHaveBeenCalledTimes(4);
    expect(forward).toMatchObject({ available: true, totalCount: 2, cursor: "1" });
    expect(forward.facets).toHaveLength(20);
    expect(forward.facets[0]).toMatchObject({ axis: "folder", value: "shared", count: 8 });
    expect(forward.receipt.warnings).toEqual([
      "alpha warning",
      "zeta warning",
      "Facets truncated: showing 20 of 43 distinct values.",
    ]);
    expect(reverse.facets).toEqual(forward.facets);
    expect(reverse.receipt.warnings).toEqual(forward.receipt.warnings);
    expect(reverse).toMatchObject({ totalCount: 2, cursor: "1", hits: forward.hits });
  });
});

searchBackendConformance("in-repository engine", (vault) => {
  const engine: AssembledEngine = assembleCoreSemanticEngine({ vault });
  return {
    backend: new EngineSearchBackend(engine.adapter, vault),
    dispose: () => engine.dispose(),
  };
});

describe("EngineSearchBackend reranking", () => {
  it("applies default limit and minScore at the engine boundary", async () => {
    const candidates = [-1, ...Array.from({ length: 11 }, (_, index) => index)].map((score) => ({
      docid: `score-${score}.md`,
      score,
      uri: `vault://score-${score}.md`,
      path: `score-${score}.md`,
      snippet: "",
      evidence: { lexical: true, vector: false },
    }));
    const adapter = {
      semanticQuery: async ({ limit, minScore }: { readonly limit?: number; readonly minScore?: number }) => ({
        available: true as const,
        hits: candidates
          .filter((candidate) => minScore === undefined || candidate.score >= minScore)
          .slice(0, limit),
      }),
    };
    const backend = new EngineSearchBackend(adapter as never, "/vault");

    const result = await backend.search({ query: "default boundary behavior" });

    expect(result).toMatchObject({ available: true });
    expect(result.hits).toHaveLength(10);
    expect(result.hits.map((hit) => hit.score)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("passes the real query to a configured reranker and returns its changed ordering", async () => {
    const vault = await fixtureVault();
    const rerank = vi.fn(async (_query: string, hits: ScoredHit[]) =>
      [...hits].reverse().map((hit, index) => ({ ...hit, score: hits.length - index })),
    );
    const reranker: Reranker = { rerank };
    const engine = assembleCoreSemanticEngine({ vault, reranker });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const result = await backend.search({
        query: "telescope planets orbit",
        candidateLimit: 10,
        rerank: true,
      });

      expect(result.available).toBe(true);
      expect(rerank).toHaveBeenCalledTimes(1);
      expect(rerank).toHaveBeenCalledWith(
        "telescope planets orbit",
        expect.any(Array),
      );
      const candidates = rerank.mock.calls[0]![1]!;
      expect(candidates.length).toBeGreaterThan(1);
      expect(result.hits.map((hit) => hit.path)).toEqual(
        candidates.map((hit) => hit.docPath).reverse(),
      );

      await backend.search({ query: "telescope planets orbit", rerank: false });
      expect(rerank).toHaveBeenCalledTimes(1);
    } finally {
      await engine.dispose();
    }
  });

  it("derives a reranker query from typed searches", async () => {
    const vault = await fixtureVault();
    const rerank = vi.fn(async (_query: string, hits: ScoredHit[]) =>
      [...hits].reverse().map((hit, index) => ({ ...hit, score: hits.length - index })),
    );
    const engine = assembleCoreSemanticEngine({ vault, reranker: { rerank } });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const result = await backend.search({
        searches: [{ type: "lex", query: "telescope planets orbit" }],
        candidateLimit: 10,
        rerank: true,
      });

      expect(result.available).toBe(true);
      expect(rerank).toHaveBeenCalledWith("telescope planets orbit", expect.any(Array));
    } finally {
      await engine.dispose();
    }
  });
});
describe("EngineSearchBackend high-cardinality facet summary", () => {
  it("returns five hits, the full count, and 20 of 612 facets", async () => {
    const vault = await linkHeavyFacetVault();
    const engine = assembleCoreSemanticEngine({ vault });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const result = await backend.search({ ...CORPUS_MATCH_QUERY, limit: 5 });
      expect(result).toMatchObject({ available: true, totalCount: 165, cursor: "5" });
      expect(result.hits).toHaveLength(5);
      expect(result.hits.every((hit) => hit.path.startsWith("corpus/"))).toBe(true);
      expectFacetSummary(result, 612);
      expect(result.facets.filter((facet) => facet.axis === "folder")).toEqual([
        { axis: "folder", value: "corpus", count: 165, intent: "Folder axis: corpus" },
      ]);
      expect(result.facets.filter((facet) => facet.axis === "link")).toHaveLength(19);
      expect(result.facets.every((facet) => facet.count === 165)).toBe(true);
    } finally {
      await engine.dispose();
    }
  });

  it("keeps the same facet summary when the omitted limit defaults to ten hits", async () => {
    const vault = await linkHeavyFacetVault();
    const engine = assembleCoreSemanticEngine({ vault });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const result = await backend.search(CORPUS_MATCH_QUERY);
      expect(result).toMatchObject({ available: true, totalCount: 165, cursor: "10" });
      expect(result.hits).toHaveLength(10);
      expect(result.hits.every((hit) => hit.path.startsWith("corpus/"))).toBe(true);
      expectFacetSummary(result, 612);
    } finally {
      await engine.dispose();
    }
  });

  it("preserves deep hit paging, zero limits, and the full ordered stream", async () => {
    const vault = await linkHeavyFacetVault();
    const engine = assembleCoreSemanticEngine({ vault });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const all = await backend.search({ ...CORPUS_MATCH_QUERY, limit: 75 });
      const deep = await backend.search({ ...CORPUS_MATCH_QUERY, limit: 10, cursor: "60" });
      const emptyPage = await backend.search({ ...CORPUS_MATCH_QUERY, limit: 0 });
      expect(all).toMatchObject({ available: true, totalCount: 165, cursor: "75" });
      expect(all.hits).toHaveLength(75);
      expect(all.hits.every((hit) => hit.path.startsWith("corpus/"))).toBe(true);
      expect(deep).toMatchObject({ totalCount: 165, cursor: "70" });
      expect(deep.hits.map((hit) => hit.path)).toEqual(all.hits.slice(60, 70).map((hit) => hit.path));
      expect(emptyPage).toMatchObject({ totalCount: 165, cursor: "0", hits: [] });
      expectFacetSummary(all, 612);
      expect(deep.facets).toEqual(all.facets);
      expect(emptyPage.facets).toEqual(all.facets);
      expect(deep.receipt.warnings).toEqual(all.receipt.warnings);

      const pages = [];
      let cursor: string | null | undefined;
      do {
        const page = await backend.search({
          ...CORPUS_MATCH_QUERY,
          limit: 50,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });
        pages.push(...page.hits.map((hit) => hit.path));
        cursor = page.cursor;
      } while (cursor !== null && cursor !== undefined);
      expect(pages).toHaveLength(165);
      expect(pages.slice(0, 75)).toEqual(all.hits.map((hit) => hit.path));
    } finally {
      await engine.dispose();
    }
  });

  it("bounds axis and overview query facets without changing their result counts", async () => {
    const vault = await linkHeavyFacetVault();
    const engine = assembleCoreSemanticEngine({ vault });
    const backend = new EngineSearchBackend(engine.adapter, vault);
    try {
      const axis = await backend.search({
        query: "shared facet token",
        axes: { folder: "corpus" },
        limit: 5,
      });
      const overview = await backend.search({ query: "", limit: 5 });
      expect(axis).toMatchObject({ available: true, totalCount: 165, cursor: "5" });
      expect(axis.hits).toHaveLength(5);
      expectFacetSummary(axis, 612);
      expect(overview).toMatchObject({ available: true, totalCount: 776, cursor: "5" });
      expectFacetSummary(overview, 613);
      expect(overview.facets.some((facet) => facet.axis === "folder" && facet.value === "targets")).toBe(true);
    } finally {
      await engine.dispose();
    }
  });
});
