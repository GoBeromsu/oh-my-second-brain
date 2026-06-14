import { describe, expect, it } from "vitest";
import {
  createSemanticEmbeddingProvider,
  projectEmbeddingVector,
} from "./semantic-embedding-provider.js";
import { SQLITE_VECTOR_DIMENSIONS } from "./semantic-embedding-hash.js";

describe("semantic embedding provider", () => {
  it("projects external model embeddings into the sqlite-vec store dimensions", () => {
    const projected = projectEmbeddingVector([1, 2, 3, 4, 5]);

    expect(projected).toBeInstanceOf(Float32Array);
    expect(projected).toHaveLength(SQLITE_VECTOR_DIMENSIONS);
    expect(projected.some((value) => value !== 0)).toBe(true);
  });

  it("uses deterministic hash embeddings when no GGUF model path is configured", async () => {
    const provider = await createSemanticEmbeddingProvider({});
    const vector = await provider.embed("Agent retrieval uses semantic search.");

    expect(provider.model).toBe("oms-sqlite-vec-hash-v1");
    expect(vector).toHaveLength(SQLITE_VECTOR_DIMENSIONS);
  });
});
