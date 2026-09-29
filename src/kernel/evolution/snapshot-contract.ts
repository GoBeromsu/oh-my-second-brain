import { join } from "node:path";
import type { Digest } from "../conventions/canonical.js";
import { digestHex, isDigest } from "../contract/digest.js";
import { readVerifiedDirectory } from "../contract/generation-snapshot.js";
import { existingStateDir } from "../contract/state-dir.js";
import { readContractDirectory, type DeclinedSet } from "../contract/store.js";
import type { VaultContract } from "../contract/types.js";

/**
 * A sealed generation read back from its snapshot (never from a retained store directory),
 * projected to the current axes-only form. Read-only: an absent snapshot is `missing`, and
 * bytes that fail their manifest digest or the strict contract schema are `corrupt`.
 * It lives here, not beside the snapshot writer, because the store imports that writer.
 */
export type SnapshotContract =
  | { readonly state: "ok"; readonly contract: VaultContract; readonly declined: DeclinedSet; readonly digest: Digest }
  | { readonly state: "missing" }
  | { readonly state: "corrupt" };

export async function readSnapshotContract(root: string, vaultId: string, digest: string): Promise<SnapshotContract> {
  if (!isDigest(digest)) return { state: "corrupt" };
  const generations = await existingStateDir(root, vaultId, "generations");
  if (generations === null) return { state: "missing" };
  const directory = join(generations, digestHex(digest));
  const verified = await readVerifiedDirectory(directory, digest);
  if (verified.state !== "ok") return verified;
  const read = await readContractDirectory(directory);
  if (read.state !== "ok" || read.digest !== digest) return { state: "corrupt" };
  return { state: "ok", contract: read.contract, declined: read.declined, digest };
}
