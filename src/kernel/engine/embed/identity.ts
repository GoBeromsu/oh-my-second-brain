import { createHash } from "node:crypto";
import { ENGINE_EMBED_META_VERSION, type EmbeddingIdentity } from "./store.js";

/**
 * The five model-shape fields are part of the fingerprint.  Provider/model
 * remain explicit labels as well, so changing either the runtime or model
 * cannot silently reuse vectors produced by another configuration.
 */
export interface EmbeddingShapeIdentity {
  readonly dimensions: number;
  readonly contextLength: number;
  readonly mrlDim: number;
  readonly normalization: string;
  readonly prefixScheme: string;
}

function assertShape(input: EmbeddingShapeIdentity): void {
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error("Embedding identity dimensions must be a positive integer.");
  }
  if (!Number.isInteger(input.contextLength) || input.contextLength <= 0) {
    throw new Error("Embedding identity contextLength must be a positive integer.");
  }
  if (!Number.isInteger(input.mrlDim) || input.mrlDim < 0) {
    throw new Error("Embedding identity mrlDim must be a non-negative integer.");
  }
  if (typeof input.normalization !== "string" || input.normalization.trim() === "") {
    throw new Error("Embedding identity normalization is required.");
  }
  if (typeof input.prefixScheme !== "string" || input.prefixScheme.trim() === "") {
    throw new Error("Embedding identity prefixScheme is required.");
  }
}

export function fingerprintEmbeddingIdentity(input: {
  provider: string;
  model: string;
} & EmbeddingShapeIdentity): string {
  assertShape(input);
  const raw = [
    ENGINE_EMBED_META_VERSION,
    input.provider,
    input.model,
    String(input.dimensions),
    String(input.contextLength),
    String(input.mrlDim),
    input.normalization,
    input.prefixScheme,
  ].join("\u0000");
  return createHash("sha256").update(raw).digest("hex");
}

export function makeEmbeddingIdentity(input: {
  provider: string;
  model: string;
} & EmbeddingShapeIdentity): EmbeddingIdentity {
  assertShape(input);
  return {
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    contextLength: input.contextLength,
    mrlDim: input.mrlDim,
    normalization: input.normalization,
    prefixScheme: input.prefixScheme,
    fingerprint: fingerprintEmbeddingIdentity(input),
  };
}
