import { access } from "node:fs/promises";
import path from "node:path";
import { auditVault, type AuditFinding } from "../kernel/contract/audit.js";
import { VaultSettingsError } from "../kernel/vault/settings.js";

function validatedFolder(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  if (folder.length === 0 || folder === "." || folder === ".." || folder.includes("/") || folder.includes("\\")) {
    throw new Error("Audit folder must be one safe top-level name without path separators.");
  }
  return folder;
}

/**
 * A failure reason by fixed code. Raw filesystem messages carry absolute paths,
 * including the private contract store, so only the code leaves this command.
 */
function failureReason(error: unknown): string {
  if (error instanceof VaultSettingsError) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `${code}: the vault or audit folder could not be read`;
  return "AUDIT_FAILED: the audit could not read the vault. Run: oms contract doctor";
}

/** Caps the reported findings per violation kind; the total stays in `violationCount`. */
function boundedFindings(findings: readonly AuditFinding[], maxPerKind: number | undefined): readonly AuditFinding[] {
  if (maxPerKind === undefined) return findings;
  const counts = new Map<string, number>();
  return findings.filter(item => {
    const count = counts.get(item.kind) ?? 0;
    counts.set(item.kind, count + 1);
    return count < maxPerKind;
  });
}

export async function runAudit(opts: {
  readonly vault: string;
  readonly json?: boolean;
  readonly folder?: string;
  readonly maxPerTemplate?: number;
}): Promise<number> {
  let folder: string | undefined;
  try {
    if (opts.maxPerTemplate !== undefined && (!Number.isSafeInteger(opts.maxPerTemplate) || opts.maxPerTemplate < 1)) {
      throw new Error("Audit maxPerTemplate must be a safe positive integer.");
    }
    folder = validatedFolder(opts.folder);
  } catch (error) {
    console.error(`[oms] audit could not complete: ${(error as Error).message}`);
    return 1;
  }
  try {
    if (folder !== undefined) await access(path.join(opts.vault, folder));
    const audit = await auditVault(opts.vault, folder === undefined ? {} : { folder });
    const result = {
      vault: opts.vault,
      folder: folder ?? null,
      contract: audit.contract,
      scannedNotes: audit.scannedNotes,
      violationCount: audit.violations.length,
      violations: boundedFindings(audit.violations, opts.maxPerTemplate),
      clean: audit.clean,
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`\nOh My Second Brain audit: ${result.scannedNotes} note(s), contract ${result.contract}, ${result.violationCount} violation(s).`);
      if (result.contract === "unreadable") console.log("  contract unreadable. Run: oms contract doctor");
      for (const item of result.violations) console.log(`  ${item.path} — ${item.field}: ${item.kind}`);
      console.log("");
    }
    return result.clean ? 0 : 1;
  } catch (error) {
    console.error(`[oms] audit could not complete: ${failureReason(error)}`);
    return 1;
  }
}
