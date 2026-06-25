import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public package entrypoint", () => {
  it("exports the native engine semantic surface without qmd backend names", () => {
    expect(api.assembleEngine).toBeTypeOf("function");
    expect(api.assembleCoreSemanticEngine).toBeTypeOf("function");
    expect(api.retrieveMorningContext).toBeTypeOf("function");
    expect("queryQmd" in api).toBe(false);
    expect("syncQmdEmbeddingStore" in api).toBe(false);
    expect("querySemanticStore" in api).toBe(false);
    expect("syncSemanticEmbeddingStore" in api).toBe(false);
  });
});
