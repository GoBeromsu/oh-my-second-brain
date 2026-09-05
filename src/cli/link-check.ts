import { detectLinkIssues } from "../kernel/conventions/lint.js";
import { formatLintReport } from "../kernel/conventions/report.js";

export async function runLinkCheck(opts: {
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
    console.error(`[oms] link check could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}
