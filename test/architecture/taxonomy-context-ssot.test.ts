import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CONTEXT_MODULE = new URL(
  "../../src/kernel/engine/retrieval/taxonomy-context.ts",
  import.meta.url,
);
const FACADE = new URL("../../src/kernel/engine/mcp/facade.ts", import.meta.url);
const SCHEMA = new URL(
  "../../src/kernel/semantic/semantic-tool-schemas.ts",
  import.meta.url,
);

describe("taxonomy intent is the sole model-context source", () => {
  it("reads only active .oms/taxonomy.yaml and owns no persistence API", async () => {
    const source = await readFile(CONTEXT_MODULE, "utf8");

    expect(source).toContain('path.join(vault, ".oms", "taxonomy.yaml")');
    expect(source).not.toContain('path.join(vault, "taxonomy.yaml")');
    expect(source).not.toMatch(/resolveBundledAssetPaths|global_context|context\.(?:json|ya?ml)/u);
    expect(source).not.toMatch(/\bwriteFile|\bmkdir|\brename|\brm\(/u);
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
