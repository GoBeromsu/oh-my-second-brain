/**
 * `oms linkify` — batch retrofit of `[[wikilinks]]` over EXISTING vault notes.
 *
 * Report-only by default. Mutation requires BOTH `--apply` and `--yes`, checked
 * before any note is read, so a half-typed command can never reach the disk.
 *
 * The command owns scope and reporting only: span detection stays in
 * engine/linkify (pure), and every write goes through the capture kernel's
 * `writeNote`, which keeps path safety, the concept contract, and the
 * postcondition read-back unduplicated here.
 */

import { linkifyVault } from "../kernel/link/workflow.js";
import type { LinkCandidate } from "../kernel/engine/linkify/types.js";
import { validateVaultLintFolder } from "../kernel/engine/conventions/vault-lint.js";
import { resolveActiveOntology } from "../kernel/ontology/active.js";

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
 * Scan (and optionally link) a vault, restricting link TARGETS to notes bound
 * to the `term` concept.
 */
export async function runLinkify(options: LinkifyOptions): Promise<number> {
  if (options.apply && !options.yes) {
    console.error("[oms] linkify --apply rewrites notes in place; re-run with --yes to confirm. Nothing was written.");
    return 1;
  }

  try {
    const { ontology } = await resolveActiveOntology(options.vault);
    await validateVaultLintFolder(options.vault, ontology, options.folder);

    const workflow = await linkifyVault(
      { vault: options.vault, source: "explicit", ontology },
      { folder: options.folder, apply: options.apply },
    );

    console.log(
      `\nOh My Second Brain linkify: ${String(workflow.notesInScope)} note(s) in scope, ${String(workflow.targetNotes)} term note(s) available as link targets.`,
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
