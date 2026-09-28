import { cpSync, renameSync } from "node:fs";
import path from "node:path";

/**
 * Copies the committed ko-vault fixture to `dest` and renames the one NFD note.
 *
 * Git stores every fixture path NFC because a committed NFD path shows up as untracked
 * on macOS checkouts (`core.precomposeunicode=true`). The copy restores the NFD spelling
 * so the vault really holds both normalizations. Shared by the e2e suite and the bench.
 */

export const KO_VAULT_SOURCE = path.join(import.meta.dirname, "ko-vault");

/** Vault-relative path of the note materialized with an NFD filename (NFC string). */
export const NFD_NOTE = "지식/낙상 위험 평가.md";

/** A note whose filename stays NFC. */
export const NFC_NOTE = "Resources/낙상판정기준.md";

export function materializeKoVault(dest) {
  cpSync(KO_VAULT_SOURCE, dest, { recursive: true });
  const dir = path.join(dest, path.dirname(NFD_NOTE));
  renameSync(path.join(dir, path.basename(NFD_NOTE).normalize("NFC")), path.join(dir, path.basename(NFD_NOTE).normalize("NFD")));
  return dest;
}
