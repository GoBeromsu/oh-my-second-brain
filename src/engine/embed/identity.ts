import { createHash } from "node:crypto";
import { ENGINE_EMBED_META_VERSION, type EmbeddingIdentity } from "./store.js";

export function fingerprintEmbeddingIdentity(input: {
  provider: string;
  model: string;
  dimensions: number;
}): string {
  const raw = [ENGINE_EMBED_META_VERSION, input.provider, input.model, String(input.dimensions)].join("\u0000");
  return createHash("sha256").update(raw).digest("hex");
}

export function makeEmbeddingIdentity(input: {
  provider: string;
  model: string;
  dimensions: number;
}): EmbeddingIdentity {
  return {
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    fingerprint: fingerprintEmbeddingIdentity(input),
  };
}

export function embeddingIdentityEqual(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions &&
    a.fingerprint === b.fingerprint
  );
}
