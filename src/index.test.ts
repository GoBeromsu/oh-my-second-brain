import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public package entrypoint", () => {
  it("exports OMS semantic search names without qmd backend names", () => {
    expect(api.querySemanticStore).toBeTypeOf("function");
    expect(api.syncSemanticEmbeddingStore).toBeTypeOf("function");
    expect("queryQmd" in api).toBe(false);
    expect("syncQmdEmbeddingStore" in api).toBe(false);
  });
});
