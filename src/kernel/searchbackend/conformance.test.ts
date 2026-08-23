import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleCoreSemanticEngine, type AssembledEngine } from "../engine/assemble.js";
import { EngineSearchBackend } from "./engine-search-backend.js";
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

    it("reports unavailable with actionable guidance when an explicit vector search cannot run", async () => {
      const vault = await fixtureVault();
      const { backend, dispose } = create(vault);
      try {
        const result = await backend.search({
          searches: [{ type: "vec", query: "telescope planets orbit" }],
        });

        // ADR-007 locks no-fake-fallback: an explicitly requested strategy that
        // cannot run must say so, not silently return lexical results dressed
        // up as vector ones. The reason has to name what to configure.
        expect(result.available).toBe(false);
        expect(result.reason ?? "").toMatch(/OMS_EMBEDDING_PROVIDER/);
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

searchBackendConformance("in-repository engine", (vault) => {
  const engine: AssembledEngine = assembleCoreSemanticEngine({ vault });
  return {
    backend: new EngineSearchBackend(engine.adapter, vault),
    dispose: () => engine.dispose(),
  };
});
