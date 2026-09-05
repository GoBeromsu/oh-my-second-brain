import type { VaultLintResult } from "./lint.js";

export interface LintFormatOptions {
  vault: string;
  /** List every broken link and orphan instead of a capped summary. */
  verbose?: boolean;
  /** Max offending notes listed for broken links (default 20). */
  maxBroken?: number;
  /** Max orphan notes listed (default 20). */
  maxOrphans?: number;
}

export function formatLintReport(result: VaultLintResult, opts: LintFormatOptions): string {
  const byNote = new Map<string, string[]>();
  for (const { notePath, target } of result.brokenLinks) {
    const targets = byNote.get(notePath) ?? [];
    targets.push(target);
    byNote.set(notePath, targets);
  }
  const offenders = [...byNote.entries()]
    .map(([notePath, targets]) => ({ notePath, targets }))
    .sort((left, right) => right.targets.length - left.targets.length || left.notePath.localeCompare(right.notePath));
  const lines = [
    "Oh My Second Brain lint — link & structure check",
    `Vault: ${opts.vault}`,
    "",
    `Scanned ${result.totalNotes} notes.`,
    `${result.brokenLinks.length} broken wikilink(s) across ${offenders.length} note(s) · ${result.orphanPaths.length} orphan note(s).`,
  ];
  if (result.brokenLinks.length === 0) lines.push("", "Broken wikilinks: 0 ✓");
  else {
    lines.push("", "Broken wikilinks — notes with the most dangling targets");
    const maxNotes = opts.verbose ? offenders.length : opts.maxBroken ?? 20;
    for (const offender of offenders.slice(0, maxNotes)) {
      lines.push(`  ${offender.notePath} (${offender.targets.length})`);
      const maxTargets = opts.verbose ? offender.targets.length : 5;
      for (const target of offender.targets.slice(0, maxTargets)) lines.push(`    -> [[${target}]]`);
      if (offender.targets.length > maxTargets) lines.push(`    … and ${offender.targets.length - maxTargets} more`);
    }
    if (offenders.length > maxNotes) lines.push(`  … and ${offenders.length - maxNotes} more note(s) with broken links`);
  }
  if (result.orphanPaths.length === 0) lines.push("", "Orphan notes: 0 ✓");
  else {
    lines.push("", `Orphan notes (no incoming links): ${result.orphanPaths.length}`);
    const maxOrphans = opts.verbose ? result.orphanPaths.length : opts.maxOrphans ?? 20;
    for (const notePath of result.orphanPaths.slice(0, maxOrphans)) lines.push(`  ${notePath}`);
    if (result.orphanPaths.length > maxOrphans) lines.push(`  … and ${result.orphanPaths.length - maxOrphans} more`);
  }
  lines.push("", "Lint findings are warnings (non-blocking). Exit 0.");
  if (!opts.verbose) lines.push("Run `oms link check --verbose` to list every finding.");
  return lines.join("\n");
}
