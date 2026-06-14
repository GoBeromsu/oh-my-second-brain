/**
 * Absorption report writer for distill (M4 — C6).
 *
 * Converts an AnalyzerResult to a human-readable markdown report with
 * exactly 3 sections: §1 Patterns, §2 Risks, §3 Attribution.
 *
 * Pure function: no vault write, no code mutation, no side effects.
 * The report string is the ONLY output.
 */

import type { AnalyzerResult, DistillPattern, DistillRisk } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a distill absorption report from an AnalyzerResult.
 *
 * Returns a markdown string with exactly 3 sections:
 *   §1 Patterns — ranked by absorb_confidence descending
 *   §2 Risks    — ranked by severity (critical → high → medium → low)
 *   §3 Attribution — repo, URL, and license note for ACKNOWLEDGMENTS.md
 *
 * @param result     - Structured result from the red-team analyzer.
 * @param targetName - Human-readable name of the analyzed target.
 * @returns Markdown string. No side effects.
 */
export function generateReport(
  result: AnalyzerResult,
  targetName: string,
): string {
  return [
    renderHeader(targetName),
    renderPatterns(result.patterns),
    renderRisks(result.risks),
    renderAttribution(result.attribution),
  ].join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(targetName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `# Distill Absorption Report: ${targetName}`,
    "",
    `> Generated: ${date}  `,
    `> Engine: oms/distill M4-C6`,
  ].join("\n");
}

function renderPatterns(patterns: DistillPattern[]): string {
  const header = "## §1 Patterns";
  const intro =
    "Ranked by absorb confidence (highest first). " +
    "Each entry cites a file and line for evidence.";

  if (patterns.length === 0) {
    return `${header}\n\n_No patterns identified._`;
  }

  // Patterns arrive pre-sorted descending from analyzer; preserve that order.
  const items = patterns.map((p, i) => renderPattern(p, i + 1));

  return [header, "", intro, "", ...items].join("\n");
}

function renderPattern(p: DistillPattern, rank: number): string {
  const confidence = (p.absorb_confidence * 100).toFixed(0);
  const location = p.line > 0 ? `${p.file}:${p.line}` : p.file;
  return [
    `### ${rank}. ${p.description}`,
    "",
    `- **Location**: \`${location}\``,
    `- **Absorb confidence**: ${confidence}%`,
    "",
  ].join("\n");
}

function renderRisks(risks: DistillRisk[]): string {
  const header = "## §2 Risks";

  if (risks.length === 0) {
    return `${header}\n\n_No risks identified._`;
  }

  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const sorted = [...risks].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  const items = sorted.map((r) => `- ${severityBadge(r.severity)} ${r.description}`);

  return [header, "", ...items].join("\n");
}

function severityBadge(severity: DistillRisk["severity"]): string {
  switch (severity) {
    case "critical":
      return "**[CRITICAL]**";
    case "high":
      return "**[HIGH]**";
    case "medium":
      return "**[MEDIUM]**";
    case "low":
      return "**[LOW]**";
  }
}

function renderAttribution(attr: AnalyzerResult["attribution"]): string {
  const header = "## §3 Attribution";
  const urlLine = attr.url ? `- **URL**: <${attr.url}>` : "";

  const lines = [
    `- **Repo**: ${attr.repo}`,
    urlLine,
    `- **License note**: ${attr.license_note}`,
    "",
    "> This attribution memo is for `ACKNOWLEDGMENTS.md` record-keeping only.",
    "> It is NOT a license gate — legal review is a human responsibility.",
  ].filter((l) => l !== "");

  return [header, "", ...lines].join("\n");
}
