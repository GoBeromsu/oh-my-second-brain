import { digestBytes, type Digest } from "../conventions/canonical.js";
import type { ContractView } from "./types.js";

/**
 * The contract revision a write and its gap records name: the one place it is computed,
 * so every consumer switches together when the revision moves to the sealed manifest
 * digest. Today it is the digest of the sealed contract as read from the store; an open
 * or unreadable contract has no revision.
 */
export function contractRevision(view: ContractView): Digest | null {
  return view.state === "sealed" ? digestBytes(JSON.stringify(view.contract)) : null;
}
