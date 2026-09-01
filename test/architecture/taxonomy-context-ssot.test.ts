import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MODEL_CONTEXT_READERS = [
  new URL(
    "../../src/kernel/engine/retrieval/taxonomy-context.ts",
    import.meta.url,
  ),
] as const;
const FACADE = new URL("../../src/kernel/engine/mcp/facade.ts", import.meta.url);
const SCHEMA = new URL(
  "../../src/kernel/semantic/semantic-tool-schemas.ts",
  import.meta.url,
);

describe("taxonomy intent is the sole model-context source", () => {
  it("limits the raw taxonomy read prohibition to model-context readers", async () => {
    expect(MODEL_CONTEXT_READERS.length).toBeGreaterThan(0);
    for (const reader of MODEL_CONTEXT_READERS) {
      const source = await readFile(reader, "utf8");

      expect(source).toContain("loadResolvedTemplates");
      expect(source).not.toMatch(/from "node:fs(?:\/promises)?"/u);
      expect(source).not.toMatch(/from "yaml"|\bparseYaml\b/u);
      expect(source).not.toMatch(/\bwriteFile|\bmkdir|\brename|\brm\(/u);
    }
  });

  it("routes both expansion and reranking through the taxonomy projection", async () => {
    const source = await readFile(FACADE, "utf8");

    expect(source).toContain("loadTaxonomyIntentProjection(");
    expect(source).toContain("context: context.promptContext");
    expect(source).toContain("Vault folder intents:");
    expect(source).toContain("taxonomyIntents: taxonomyProjection?.matched");
  });

  it("does not advertise a parallel context field on the expansion strategy", async () => {
    const source = await readFile(SCHEMA, "utf8");
    const strategyStart = source.indexOf("strategy:");
    expect(strategyStart).toBeGreaterThanOrEqual(0);
    const strategyBlock = source.slice(strategyStart, strategyStart + 500);

    expect(strategyBlock).toContain('enum: ["qmd-v2.8.3"]');
    expect(strategyBlock).not.toMatch(/\b(?:context|contextFile|contextPath)\s*:/u);
  });
});
