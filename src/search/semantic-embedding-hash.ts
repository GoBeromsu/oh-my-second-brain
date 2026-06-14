import { createHash } from "node:crypto";
import { tokenize } from "./semantic-token.js";

export const SQLITE_VECTOR_DIMENSIONS = 64;

function tokenBucket(token: string): { readonly index: number; readonly sign: number } {
  const digest = createHash("sha1").update(token).digest();
  const first = digest[0] ?? 0;
  const second = digest[1] ?? 0;
  return { index: first % SQLITE_VECTOR_DIMENSIONS, sign: second % 2 === 0 ? 1 : -1 };
}

export function hashEmbedding(text: string): Float32Array {
  const vector = new Float32Array(SQLITE_VECTOR_DIMENSIONS);
  for (const token of tokenize(text)) {
    const bucket = tokenBucket(token);
    vector[bucket.index] = (vector[bucket.index] ?? 0) + bucket.sign;
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  if (magnitude === 0) return vector;
  const divisor = Math.sqrt(magnitude);
  for (let index = 0; index < vector.length; index++) {
    vector[index] = (vector[index] ?? 0) / divisor;
  }
  return vector;
}

export function vectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
