import path from "node:path";
import { rejection, type WriteRejection, type WriteTargetSource } from "../conventions/write-protocol.js";
import { normalizeTemplateSourcePath, verifyVaultPath } from "../templates/paths.js";

/**
 * Target admission and note-path confinement for guide, check, and complete.
 * Ordinary note create, append, and update are not provided here.
 */

export interface WriteTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
}

export function safeVaultNotePath(vault: string, notePath: string): string {
  if (path.isAbsolute(notePath)) throw new Error("notePath must be vault-relative");
  const normalized = notePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) throw new Error("notePath must end with .md");
  const segments = normalized.split("/");
  if (segments.some(part => part === ".." || part === "." || part === "")) throw new Error("notePath must not contain unsafe path segments");
  if (segments.some(part => part.startsWith(".")) || segments.includes("node_modules")) throw new Error("notePath cannot target hidden, internal, or dependency folders");
  const resolved = path.resolve(vault, normalized);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("notePath must stay inside the configured vault");
  return resolved;
}

/**
 * Admit only an explicit, local-vault, verified v2 bridge, or OMS_VAULT target.
 * Current-directory inference, a diagnosed v1 bridge, and any unexpected source
 * are refused. Origin stays truthful: a legacy bridge is never relabeled as cwd.
 */
const ADMITTED_WRITE_SOURCES = new Set<WriteTargetSource>(["explicit", "vault", "bridge", "env"]);

export async function admitWriteTarget(target: WriteTarget): Promise<WriteRejection | undefined> {
  if (ADMITTED_WRITE_SOURCES.has(target.source)) return undefined;
  const reason = target.source === "cwd"
    ? `the target vault was inferred from the current directory (${target.vault}), which is not a verified Oh My Second Brain vault`
    : target.source === "legacy-bridge"
      ? `the target vault (${target.vault}) was resolved from a v1 bridge, which is read-only and was not converted`
      : `the target vault (${target.vault}) was resolved from an unexpected source (${String(target.source)}), which is not a verified write origin`;
  return rejection(
    "admission",
    "target-unverified",
    `Refusing to guide or check: ${reason}. An explicit vault target is accepted; a current-directory inference, a legacy v1 bridge, and an unexpected source are not.`,
    "pass an explicit vault target, run `oms setup` in your Obsidian vault, or set OMS_VAULT, then retry",
  );
}

export interface VerifiedVaultNotePath {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notePath: string;
  readonly absolutePath: string;
}

export interface RejectedVaultNotePath {
  readonly ok: false;
  readonly rejection: WriteRejection;
}

export type VaultNotePathResult = VerifiedVaultNotePath | RejectedVaultNotePath;

/**
 * Lexical `.md` confinement plus realpath and symlink checks.
 * An absent note is accepted when its existing parents stay inside the real vault.
 * The note is not created.
 */
export async function verifyVaultNotePath(vault: string, notePath: string): Promise<VaultNotePathResult> {
  try {
    safeVaultNotePath(vault, notePath);
  } catch (error: unknown) {
    return { ok: false, rejection: pathRejection(error) };
  }
  let normalized: ReturnType<typeof normalizeTemplateSourcePath>;
  try {
    normalized = normalizeTemplateSourcePath(notePath);
  } catch (error: unknown) {
    return { ok: false, rejection: pathRejection(error) };
  }
  try {
    const verified = await verifyExistingOrAbsent(vault, normalized);
    return {
      ok: true,
      vaultRoot: verified.vaultRoot,
      notePath: verified.vaultRelativePath,
      absolutePath: verified.absolutePath,
    };
  } catch (error: unknown) {
    return { ok: false, rejection: pathRejection(error) };
  }
}

function pathRejection(error: unknown): WriteRejection {
  const code = errno(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return rejection(
      "admission",
      "target-invalid",
      `The vault target does not exist or is not a directory (${message}).`,
      "pass an explicit existing vault directory, then retry guide, check, or complete",
    );
  }
  return rejection(
    "admission",
    "path-unsafe",
    message,
    "pass an explicit vault-relative .md note path that stays inside the vault and is not hidden, internal, or reached through a symlink",
  );
}

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function verifyExistingOrAbsent(vault: string, notePath: ReturnType<typeof normalizeTemplateSourcePath>) {
  try {
    return await verifyVaultPath(vault, notePath, { expected: "existing-file" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("must exist")) throw error;
    return verifyVaultPath(vault, notePath, { expected: "absent" });
  }
}
