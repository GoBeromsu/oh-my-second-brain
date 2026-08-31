import { detectLinkIssues } from "../kernel/conventions/lint.js";
import { formatLintReport } from "../kernel/conventions/report.js";
import { diagnoseTemplates } from "../kernel/templates/index.js";

export async function runDoctor(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
  maxPerTemplate?: number;
}): Promise<number> {
  try {
    const diagnosis = await diagnoseTemplates({ vault: opts.vault, source: "explicit", maxPerTemplate: opts.maxPerTemplate });
    if (opts.json) {
      console.log(JSON.stringify({ vault: opts.vault, ...diagnosis }, null, 2));
      return 0;
    }
    console.log(`\nOh My Second Brain doctor: ${diagnosis.status}.`);
    console.log(`Migration marker: ${diagnosis.migrationMarker}.`);
    console.log(`Managed template sources excluded: ${diagnosis.managedSourceExclusions.length}.`);
    if (diagnosis.unresolvedLegacyNotes.length > 0) {
      console.log(`Unresolved legacy notes: ${diagnosis.unresolvedLegacyNotes.length}.`);
    }
    for (const item of diagnosis.diagnostics) {
      console.log(`  [${item.code}]${item.path === undefined ? "" : ` ${item.path}`} — ${item.remediation}`);
    }
    console.log("");
  } catch (error) {
    console.error(`[oms] doctor could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

export async function runLint(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
}): Promise<number> {
  try {
    const result = await detectLinkIssues(opts.vault);
    if (opts.json) {
      console.log(JSON.stringify({ totalNotes: result.totalNotes, brokenLinks: result.brokenLinks, orphanPaths: result.orphanPaths }, null, 2));
    } else {
      console.log(formatLintReport(result, { vault: opts.vault, verbose: opts.verbose }));
    }
  } catch (error) {
    console.error(`[oms] lint could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}
