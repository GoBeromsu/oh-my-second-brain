/**
 * TEST-ONLY hash-projection embedding stub.
 *
 * This file MUST NOT be imported by any production (non-test) module.
 * It exists solely to allow test files to construct deterministic
 * EmbeddingProvider instances without a real GGUF model or API key.
 *
 * Import from test files (*.test.ts) only:
 *   import { createHashProjectionProvider } from "../embed/hash-stub.test-helper.js";
 */

import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../types.js";

/** Self-contained word tokeniser for hash projection. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Project `text` into a normalised `dimensions`-wide Float32Array via
 * SHA-1 bucket hashing.  Deterministic: same text → same vector.
 */
function hashProject(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (const token of tokenize(text)) {
    const digest = createHash("sha1").update(token).digest();
    const idx = (digest[0] ?? 0) % dimensions;
    const sign = (digest[1] ?? 0) % 2 === 0 ? 1 : -1;
    vector[idx] = (vector[idx] ?? 0) + sign;
  }
  // L2-normalise so cosine similarity = dot product
  let mag = 0;
  for (const v of vector) mag += v * v;
  if (mag === 0) return vector;
  const norm = Math.sqrt(mag);
  for (let i = 0; i < vector.length; i++) {
    vector[i] = (vector[i] ?? 0) / norm;
  }
  return vector;
}

/**
 * Create a deterministic hash-projection EmbeddingProvider.
 *
 * FOR TESTS ONLY. Produces a normalised Float32Array of the specified
 * `dimensions` (default 64). No GGUF model or API key required.
 */
export function createHashProjectionProvider(dimensions = 64): EmbeddingProvider {
  return {
    model: `hash-projection:dim=${dimensions}`,
    dimensions,
    embed(text: string): Promise<Float32Array> {
      return Promise.resolve(hashProject(text, dimensions));
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}
