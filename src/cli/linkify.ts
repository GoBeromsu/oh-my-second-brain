/**
 * Shared batch retrofit of `[[wikilinks]]` over existing vault notes.
 *
 * Report-only by default. Mutation requires BOTH `--apply` and `--yes`, checked
 * before any note is read, so a half-typed command can never reach the disk.
 *
 * This compatibility-free internal API owns scope and reporting only: span detection stays in
 * engine/linkify (pure), and every write goes through the capture kernel's
 * `writeNote`, which keeps path safety, the resolved template contract, and the
 * postcondition read-back unduplicated here.
 */

import { linkifyVault } from "../kernel/link/workflow.js";
import type { LinkCandidate } from "../kernel/engine/linkify/types.js";
import { loadResolvedTemplates } from "../kernel/templates/index.js";

export interface LinkifyOptions {
  readonly vault: string;
  /** Restrict both scan and writes to one top-level vault folder. */
  readonly folder?: string;
  readonly apply: boolean;
  readonly yes: boolean;
}

function describeCandidate(candidate: LinkCandidate): string {
  const ambiguity = candidate.ambiguous ? ` (ambiguous: ${candidate.rivalPaths.join(", ")})` : "";
  return `    ${candidate.matchedText} → ${candidate.renderedReplacement}  [${candidate.targetPath}]${ambiguity}`;
}

/** Print one note's proposals; returns how many candidates it had. */
function reportNote(notePath: string, candidates: readonly LinkCandidate[]): void {
  console.log(`\n  ${notePath}`);
  for (const candidate of candidates) console.log(describeCandidate(candidate));
}

/**
 * Scan (and optionally link) a vault through the active resolved-template convention.
 */
export async function runLinkify(options: LinkifyOptions): Promise<number> {
  if (options.apply && !options.yes) {
    console.error("[oms] linkify --apply rewrites notes in place; re-run with --yes to confirm. Nothing was written.");
    return 1;
  }

  try {
    if (options.folder !== undefined && (options.folder.length === 0 || options.folder === "." || options.folder === ".." || options.folder.includes("/") || options.folder.includes("\\"))) {
      throw new Error("Linkify folder must be one top-level name without path separators.");
    }
    const convention = await loadResolvedTemplates(options.vault);
    const workflow = await linkifyVault(
      { vault: options.vault, source: "explicit", convention },
      { folder: options.folder, apply: options.apply },
    );

    console.log(
      `\nOh My Second Brain linkify: ${String(workflow.notesInScope)} note(s) in scope, ${String(workflow.targetNotes)} template-bound note(s) available as link targets.`,
    );

    let candidateCount = 0;
    let appliedNotes = 0;
    for (const proposal of workflow.candidates) {
      candidateCount += proposal.candidates.length;
      reportNote(proposal.notePath, proposal.candidates);
      if (proposal.outcome !== undefined) {
        if (proposal.outcome.result.applied) {
          appliedNotes++;
        } else {
          console.error(`[oms] linkify skipped ${proposal.notePath}: ${proposal.outcome.result.reason}`);
        }
      }
    }

    console.log(
      options.apply
        ? `\n${String(candidateCount)} candidate(s); applied to ${String(appliedNotes)} note(s).\n`
        : `\n${String(candidateCount)} candidate(s) proposed across ${String(workflow.notesInScope)} note(s). Report only — nothing was written. Re-run with --apply --yes to write.\n`,
    );
    return 0;
  } catch (error) {
    console.error(`[oms] linkify could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
