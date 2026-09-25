import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodePoints } from "../conventions/canonical.js";
import { managedSourceExclusionMatcher } from "../conventions/note-exclude.js";
import { mapWithConcurrency, walkVaultMarkdown } from "../conventions/vault-walk.js";
import { judgeContent } from "./judge-write.js";
import { storeRoot } from "./store.js";
import { resolveSealState } from "./vault-id.js";
import type { ViolationKind } from "./types.js";

/**
 * Re-judges every existing note against the sealed contract. Read-only. Output carries
 * vault-relative paths and `{field, kind}` only: never a value, a vault id or a store path.
 */

const READ_CONCURRENCY = 16;

export interface AuditFinding {
  readonly path: string;
  readonly field: string;
  readonly kind: ViolationKind;
}

export interface VaultAudit {
  readonly contract: "none" | "sealed" | "unreadable";
  readonly scannedNotes: number;
  readonly clean: boolean;
  readonly violations: readonly AuditFinding[];
}

function inFolder(notePath: string, folder: string | undefined): boolean {
  return folder === undefined || notePath.startsWith(`${folder}/`);
}

export async function auditVault(vault: string, options: { readonly folder?: string } = {}, root: string = storeRoot()): Promise<VaultAudit> {
  const state = await resolveSealState(vault, root);
  const contract = state.view.state;
  const sources = new Set(state.view.state === "sealed" ? Object.values(state.view.contract.templates).map(template => template.source) : []);
  let managed: (notePath: string) => Promise<boolean> = async () => false;
  try {
    managed = await managedSourceExclusionMatcher(vault);
  } catch {
    // Unreadable exclusion settings exclude nothing beyond the sealed template sources.
  }
  const paths: string[] = [];
  for await (const notePath of walkVaultMarkdown(vault)) {
    if (!inFolder(notePath, options.folder) || sources.has(notePath) || await managed(notePath)) continue;
    paths.push(notePath);
  }
  paths.sort(compareCodePoints);
  // Every note would fail the same way; the posture is reported once instead.
  if (contract === "unreadable") return { contract, scannedNotes: paths.length, clean: false, violations: [] };
  const verdicts = await mapWithConcurrency(paths, READ_CONCURRENCY, async (notePath) => {
    let content: string;
    try {
      content = await readFile(join(vault, notePath), "utf8");
    } catch {
      return [{ path: notePath, field: "path", kind: "path-unsafe" as const }];
    }
    return judgeContent({ path: notePath, content }, state.view).violations.map(violation => ({ path: notePath, ...violation }));
  });
  const violations = verdicts.flat();
  return { contract: contract === "open" ? "none" : contract, scannedNotes: paths.length, clean: violations.length === 0, violations };
}
