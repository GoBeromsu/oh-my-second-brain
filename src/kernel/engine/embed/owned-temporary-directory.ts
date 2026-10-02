import { lstatSync, mkdtempSync, realpathSync, rmSync, type BigIntStats } from "node:fs";
import path from "node:path";

export interface OwnedTemporaryDirectory {
  readonly path: string;
  assertOwned(): void;
  /** Best-effort cleanup of one direct child; false means cleanup was skipped or failed. */
  removeFile(filename: string): boolean;
  dispose(): void;
}

function usableIdentity(info: BigIntStats): boolean {
  return info.isDirectory() && !info.isSymbolicLink()
    && typeof info.dev === "bigint" && info.dev > 0n
    && typeof info.ino === "bigint" && info.ino > 0n;
}

/**
 * Detect observed pathname replacement before reuse/cleanup. These separate
 * filesystem observations are not an atomic boundary against ongoing same-user
 * tampering. Never follow or search for a relocated directory; prefer residue.
 */
export function createOwnedTemporaryDirectory(temporaryRoot: string, prefix: string): OwnedTemporaryDirectory {
  const directory = mkdtempSync(path.join(realpathSync(temporaryRoot), prefix));
  let warned = false;
  const warnResidue = () => {
    if (warned) return;
    warned = true;
    // A cleanup/diagnostic failure must never replace the original operation error.
    try { console.warn(`OMS_TEMP_CLEANUP_SKIPPED: temporary residue may remain at ${JSON.stringify(directory)}; owned cleanup could not be completed.`); }
    catch { /* Best-effort diagnostic only. */ }
  };
  const ownershipError = () => new Error("Temporary directory ownership could not be verified; retry with a new session.");
  let identity: BigIntStats;
  try {
    identity = lstatSync(directory, { bigint: true });
    if (!usableIdentity(identity) || realpathSync(directory) !== directory) throw ownershipError();
  } catch (error) {
    warnResidue();
    // Creation never established ownership, so even failure cleanup is unsafe.
    throw error;
  }
  let lostOwnership = false;
  let disposed = false;
  const ownsDirectory = () => {
    if (lostOwnership || disposed) return false;
    try {
      const current = lstatSync(directory, { bigint: true });
      if (usableIdentity(current) && current.dev === identity.dev && current.ino === identity.ino
        && realpathSync(directory) === directory) return true;
    } catch { /* Missing or unverifiable paths never authorize cleanup or reuse. */ }
    lostOwnership = true;
    return false;
  };
  return {
    path: directory,
    assertOwned() {
      if (ownsDirectory()) return;
      warnResidue();
      throw ownershipError();
    },
    removeFile(filename) {
      if (disposed) return true;
      if (path.dirname(filename) !== directory || !ownsDirectory()) { warnResidue(); return false; }
      try { rmSync(filename, { force: true }); return true; }
      catch { warnResidue(); return false; }
    },
    dispose() {
      if (disposed) return;
      if (!ownsDirectory()) { warnResidue(); return; }
      try { rmSync(directory, { recursive: true, force: true }); disposed = true; }
      catch { warnResidue(); }
    },
  };
}
