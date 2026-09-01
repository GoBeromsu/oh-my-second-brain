import { createHash } from "node:crypto";
import type { EmbeddingIdentity } from "./store.js";

export const ENGINE_EMBED_META_VERSION = "oms-embed-meta-v3";
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The five model-shape fields and immutable artifact identity are part of the
 * fingerprint, so a runtime, model, revision, or model binary change cannot
 * silently reuse vectors produced by another configuration.
 */
export interface EmbeddingShapeIdentity {
  readonly dimensions: number;
  readonly contextLength: number;
  readonly mrlDim: number;
  readonly normalization: string;
  readonly prefixScheme: string;
}

export interface EmbeddingModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly revision: string;
  readonly sha256: string;
}

function assertNonblank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error(`Embedding identity ${field} is required.`);
  }
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
  assertNonblank(input.normalization, "normalization");
  assertNonblank(input.prefixScheme, "prefixScheme");
}

function assertModel(input: EmbeddingModelIdentity): void {
  assertNonblank(input.provider, "provider");
  assertNonblank(input.model, "model");
  assertNonblank(input.revision, "revision");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    throw new Error("Embedding identity sha256 must be lowercase 64-character hexadecimal.");
  }
}

export function fingerprintEmbeddingIdentity(input: EmbeddingModelIdentity & EmbeddingShapeIdentity): string {
  assertModel(input);
  assertShape(input);
  const raw = [
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
  ].join("\u0000");
  return createHash("sha256").update(raw).digest("hex");
}

export function validateEmbeddingIdentity(identity: EmbeddingIdentity): void {
  const { fingerprint, ...input } = identity;
  assertModel(input);
  assertShape(input);
  if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) {
    throw new Error("Embedding identity fingerprint must be lowercase 64-character hexadecimal.");
  }
  if (fingerprint !== fingerprintEmbeddingIdentity(input)) {
    throw new Error("Embedding identity fingerprint does not match its fields.");
  }
}

export function makeEmbeddingIdentity(input: EmbeddingModelIdentity & EmbeddingShapeIdentity): EmbeddingIdentity {
  assertModel(input);
  assertShape(input);
  const identity: EmbeddingIdentity = {
    provider: input.provider,
    model: input.model,
    revision: input.revision,
    sha256: input.sha256,
    dimensions: input.dimensions,
    contextLength: input.contextLength,
    mrlDim: input.mrlDim,
    normalization: input.normalization,
    prefixScheme: input.prefixScheme,
    fingerprint: fingerprintEmbeddingIdentity(input),
  };
  validateEmbeddingIdentity(identity);
  return identity;
}
