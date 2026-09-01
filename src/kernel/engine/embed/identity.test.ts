import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENGINE_EMBED_META_VERSION,
  fingerprintEmbeddingIdentity,
  makeEmbeddingIdentity,
  validateEmbeddingIdentity,
} from "./identity.js";

const input = {
  provider: "gguf",
  model: "embedding.gguf",
  revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
  sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
  dimensions: 768,
  contextLength: 2048,
  mrlDim: 0,
  normalization: "l2",
  prefixScheme: "embeddinggemma-v1",
};

describe("embedding identity v3", () => {
  it("requires an immutable revision and lowercase SHA-256", () => {
    expect(() => makeEmbeddingIdentity({ ...input, revision: "" })).toThrow(/revision/);
    expect(() => makeEmbeddingIdentity({ ...input, sha256: input.sha256.toUpperCase() })).toThrow(/sha256/);
  });

  it("fingerprints all fields with NUL separators", () => {
    const expected = createHash("sha256").update([
      ENGINE_EMBED_META_VERSION,
      input.provider,
      input.model,
      input.revision,
      input.sha256,
      String(input.dimensions),
      String(input.contextLength),
      String(input.mrlDim),
      input.normalization,
      input.prefixScheme,
    ].join("\u0000")).digest("hex");

    expect(fingerprintEmbeddingIdentity(input)).toBe(expected);
    expect(fingerprintEmbeddingIdentity({ ...input, sha256: "a".repeat(64) })).not.toBe(expected);
  });

  it("rejects an identity whose fingerprint does not match its fields", () => {
    const identity = makeEmbeddingIdentity(input);
    expect(() => validateEmbeddingIdentity({ ...identity, revision: "other-revision" })).toThrow(/does not match/);
  });
});
