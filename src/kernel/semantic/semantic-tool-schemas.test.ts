import { describe, expect, it } from "vitest";
import { retrieveContextSemanticInputProperties } from "./semantic-retrieve-schema.js";
import { semanticMcpTools } from "./semantic-tool-schemas.js";

describe("semantic query MCP schema", () => {
  it("advertises the one closed expansion profile and independent reranking", () => {
    const tool = semanticMcpTools.find(({ name }) => name === "oms_semantic_query");
    expect(tool).toBeDefined();
    const properties = tool?.inputSchema.properties as Record<string, unknown>;

    expect(properties["strategy"]).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["expand"] },
        profile: { type: "string", enum: ["qmd-v2.8.3"] },
        maxQueries: { type: "integer", minimum: 1, maximum: 32 },
      },
      required: ["kind", "profile"],
      additionalProperties: false,
    });
    expect(properties["rerank"]).toEqual({ type: "boolean" });
    expect(properties["limit"]).toEqual({ type: "integer", minimum: 0 });
    expect(properties["candidateLimit"]).toEqual({ type: "integer", minimum: 1 });
  });

  it("keeps query required while strategy remains optional", () => {
    const tool = semanticMcpTools.find(({ name }) => name === "oms_semantic_query");

    expect(tool?.inputSchema.required).toEqual(["query"]);
    expect(tool?.inputSchema.properties).not.toHaveProperty("expandContextFile");
    expect(tool?.inputSchema.properties).not.toHaveProperty("qmdContext");
  });

  it("does not expose query expansion on retrieve-context", () => {
    expect(retrieveContextSemanticInputProperties).not.toHaveProperty("semanticStrategy");
    expect(retrieveContextSemanticInputProperties.semanticLimit).toEqual({
      type: "integer",
      minimum: 0,
    });
    expect(retrieveContextSemanticInputProperties.semanticCandidateLimit).toEqual({
      type: "integer",
      minimum: 1,
    });
  });
});
