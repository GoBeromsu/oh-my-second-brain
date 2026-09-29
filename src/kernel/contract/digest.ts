import { digestBytes, type Digest } from "../conventions/canonical.js";

/**
 * The one contract digest: sha256 over the exact `manifest.json` bytes of a generation.
 * The lineage `digest`, a snapshot directory name (without `sha256:`), and a seal's
 * `expectedParentDigest` are all this value; none of them depends on the generation seq.
 */
export function manifestDigestOf(manifestBytes: string | Uint8Array): Digest {
  return digestBytes(manifestBytes);
}

/** The parent of a seal when `<id>` links nothing (absent or invalid). */
export const NO_DIGEST = "none";
export type ContractDigest = Digest | typeof NO_DIGEST;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

export function isContractDigest(value: unknown): value is ContractDigest {
  return value === NO_DIGEST || isDigest(value);
}

/** The 64 hex characters a snapshot directory is named by. */
export function digestHex(digest: Digest): string {
  return digest.slice("sha256:".length);
}
