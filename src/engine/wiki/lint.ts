/**
 * Astro-Han 2-tier lint (MIT — idea absorption only).
 *
 * Auto-fix tier (runs automatically, mutates wiki/ files):
 *   - index consistency: concept present in wiki/ but absent from index.md
 *   - internal-link correctness: broken [[wikilinks]] flagged
 *   - See-Also sections: added if missing
 *
 * Report-only tier (reports to return value; NO autofix without forceHumanGate):
 *   - factual contradictions typed as:
 *     "> **Conflict:** A claims X; B claims Y. Unresolved."
 *   - orphan pages (in ledger as ORPHAN state)
 *   - outdated refs (DIRTY pages in the ledger)
 *
 * Mutation policy: report-only findings are NEVER auto-fixed unless the caller
 * explicitly sets forceHumanGate: true. This is the human-gate flag.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LintFinding, LintResult, StalenessLedger } from "./types.js";
import { extractWikilinks } from "./collection.js";
import { indexPath } from "./navigation.js";

// ---------------------------------------------------------------------------
// Auto-fix tier
// ---------------------------------------------------------------------------

/**
 * Fix index.md to include all wiki pages present in wikiDir.
 * Appends missing entries — does not reorder existing content.
 */
async function fixIndexConsistency(wikiDir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  let files: string[] = [];
  try {
    files = await readdir(wikiDir);
  } catch {
    return findings;
  }

  const pages = files.filter(
    (f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md",
  );

  let indexContent = "";
  try {
    indexContent = await readFile(indexPath(wikiDir), "utf8");
  } catch {
    // index.md missing — regeneration (not lint) handles creation; skip
    return findings;
  }

  const missing: string[] = [];
  for (const page of pages) {
    const name = path.basename(page, ".md");
    if (!indexContent.includes(`[[${name}]]`)) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    const additions = missing.map((name) => `- [[${name}]]`).join("\n");
    await writeFile(
      indexPath(wikiDir),
      indexContent.trimEnd() + "\n" + additions + "\n",
      "utf8",
    );
    for (const name of missing) {
      findings.push({
        tier: "auto-fix",
        kind: "index-inconsistency",
        pageId: `wiki/${name}.md`,
        message: `Added missing [[${name}]] to index.md`,
      });
    }
  }

  return findings;
}

/**
 * Flag broken [[wikilinks]] in each wiki page; add missing See-Also sections.
 */
async function fixLinksAndSeeAlso(wikiDir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  let files: string[] = [];
  try {
    files = await readdir(wikiDir);
  } catch {
    return findings;
  }

  const pages = files.filter(
    (f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md",
  );
  const pageNames = new Set(pages.map((f) => path.basename(f, ".md")));

  for (const file of pages) {
    const filePath = path.join(wikiDir, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    // Broken links — report (auto-fix tier flags them; actual fix is a recompile)
    for (const link of extractWikilinks(content)) {
      const name = link.replace(/\.md$/, "");
      if (!pageNames.has(name)) {
        findings.push({
          tier: "auto-fix",
          kind: "broken-link",
          pageId: `wiki/${file}`,
          message: `Broken link [[${link}]] — target page not found in wiki/`,
        });
      }
    }

    // Missing See-Also section — auto-add
    if (
      !content.includes("## See Also") &&
      !content.includes("## See-Also")
    ) {
      const updated = content.trimEnd() + "\n\n## See Also\n\n";
      await writeFile(filePath, updated, "utf8");
      findings.push({
        tier: "auto-fix",
        kind: "missing-see-also",
        pageId: `wiki/${file}`,
        message: `Added missing See-Also section to ${file}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Report-only tier
// ---------------------------------------------------------------------------

function reportConflicts(ledger: StalenessLedger): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [conceptId, entry] of Object.entries(ledger)) {
    if (entry.state === "CONFLICT") {
      const note = entry.conflictNote ?? "conflicting sources detected";
      findings.push({
        tier: "report-only",
        kind: "factual-contradiction",
        pageId: conceptId,
        message: `> **Conflict:** ${note}. Unresolved.`,
      });
    }
  }
  return findings;
}

function reportOrphans(ledger: StalenessLedger): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [conceptId, entry] of Object.entries(ledger)) {
    if (entry.state === "ORPHAN") {
      findings.push({
        tier: "report-only",
        kind: "orphan-page",
        pageId: conceptId,
        message: `Orphan page ${conceptId} has no incoming wikilinks`,
      });
    }
  }
  return findings;
}

function reportOutdatedRefs(ledger: StalenessLedger): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [conceptId, entry] of Object.entries(ledger)) {
    if (entry.state === "DIRTY") {
      findings.push({
        tier: "report-only",
        kind: "outdated-ref",
        pageId: conceptId,
        message: `Page ${conceptId} is DIRTY — sources changed since last compile`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LintOptions {
  /** Absolute path to the wiki/ directory. */
  wikiDir: string;
  /** Current staleness ledger (used for report-only checks). */
  ledger: StalenessLedger;
  /**
   * Human-gate flag — not set automatically.
   * When true, allows autofix of report-only findings (not currently implemented;
   * present as explicit hook for future human-approved bulk operations).
   */
  forceHumanGate?: boolean;
}

/**
 * Run all lint checks.
 *
 * Auto-fix tier mutates wiki/ files automatically.
 * Report-only tier returns findings but does NOT mutate anything unless
 * forceHumanGate is true (currently reserved — no report-only autofix implemented).
 */
export async function runLint(opts: LintOptions): Promise<LintResult> {
  const { wikiDir, ledger } = opts;

  // Auto-fix passes
  const autoFixed: LintFinding[] = [
    ...(await fixIndexConsistency(wikiDir)),
    ...(await fixLinksAndSeeAlso(wikiDir)),
  ];

  // Report-only passes
  const reported: LintFinding[] = [
    ...reportConflicts(ledger),
    ...reportOrphans(ledger),
    ...reportOutdatedRefs(ledger),
  ];

  return { autoFixed, reported };
}
