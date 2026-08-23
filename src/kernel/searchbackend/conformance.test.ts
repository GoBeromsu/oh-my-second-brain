import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleCoreSemanticEngine, type AssembledEngine } from "../engine/assemble.js";
import { EngineSearchBackend, requiresEmbeddings } from "./engine-search-backend.js";
import type { SearchBackend } from "./search-backend.js";

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
    "# Recipe\nKnead bread dough before baking.\n",
    "utf8",
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
      // A lexical sub-search alongside an explicit vector mode still counts.
      expect(requiresEmbeddings({ mode: "vsearch", searches: [{ type: "lex", query: "x" }] })).toBe(true);
      // Nothing explicit: plain queries stay lexical and must NOT demand a model.
      expect(requiresEmbeddings({})).toBe(false);
      expect(requiresEmbeddings({ searches: [{ type: "lex", query: "x" }] })).toBe(false);
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

searchBackendConformance("in-repository engine", (vault) => {
  const engine: AssembledEngine = assembleCoreSemanticEngine({ vault });
  return {
    backend: new EngineSearchBackend(engine.adapter, vault),
    dispose: () => engine.dispose(),
  };
});
