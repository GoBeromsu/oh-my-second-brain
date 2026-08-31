import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { safeVaultNotePath } from "../capture/safe.js";
import { parseNote } from "../conventions/frontmatter.js";

function ensureInsideRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`${label} resolves outside the vault.`);
}

/** Reads only a confined vault note body; it never creates derived state. */
export async function lazyLoadNoteBody(vault: string, notePath: string): Promise<{ path: string; body: string }> {
  const root = path.resolve(vault);
  const rootRealPath = await realpath(root);
  const resolved = safeVaultNotePath(root, notePath);
  const realResolved = await realpath(resolved);
  ensureInsideRoot(rootRealPath, realResolved, `Vault note "${notePath}"`);
  const relative = path.relative(root, resolved);
  const raw = await readFile(resolved, "utf-8");
  return { path: relative.replace(/\\/g, "/"), body: parseNote(raw).body };
}
