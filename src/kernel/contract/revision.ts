import { digestBytes, type Digest } from "../conventions/canonical.js";
import type { ContractView } from "./types.js";

/**
 * The contract revision a write and its gap records name: the one place it is computed.
 * A contract read from the store is named by the manifest digest of its generation, the
 * same digest the lineage records. A sealed view built in memory has no generation, so it
 * falls back to the digest of the contract itself; an open or unreadable contract has no
 * revision.
 */
export function contractRevision(view: ContractView): Digest | null {
  if (view.state !== "sealed") return null;
  return view.revision ?? digestBytes(JSON.stringify(view.contract));
}
