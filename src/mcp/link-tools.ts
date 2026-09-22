import type { LinkCandidate } from "../kernel/engine/linkify/types.js";
import {
  checkLinksForNote as checkWorkflowLinksForNote,
  suggestLinksForNote as suggestWorkflowLinksForNote,
  type CheckedLink,
  type LinkCheckReport,
  type LinkScope,
  type LinkWorkflowTarget,
} from "../kernel/link/workflow.js";

/**
 * The MCP link tool is read-only: it suggests wikilinks and reports link health.
 * Applying an edit is the agent's job, so no operation here writes a note.
 */

/** A candidate as the MCP surface reports it: the core shape plus a stable id. */
export interface IdentifiedCandidate extends LinkCandidate {
  readonly id: string;
}

/** Payload of a successful `suggest` call. */
export interface LinkSuggestion {
  readonly notePath: string;
  readonly baseContentHash: string;
  readonly candidateNotes: number;
  readonly candidates: readonly IdentifiedCandidate[];
  readonly diagnostics: readonly string[];
}

/** Everything the MCP link operations need to address a vault note. */
export type LinkToolTarget = LinkWorkflowTarget;

/** Restrict the candidate universe to one vault folder without changing path identities. */
export type { CheckedLink, LinkCheckReport, LinkScope };

/** Invoke the transport-neutral suggestion workflow and retain the MCP contract. */
export async function suggestLinksForNote(target: LinkToolTarget, scope: LinkScope = {}): Promise<LinkSuggestion> {
  return suggestWorkflowLinksForNote(target, scope);
}

/** Invoke the transport-neutral link check and retain the MCP contract. */
export async function checkLinksForNote(target: LinkToolTarget, scope: LinkScope = {}): Promise<LinkCheckReport> {
  return checkWorkflowLinksForNote(target, scope);
}

/** JSON shape of a suggestion: candidates only, with no applied body or receipt. */
export function linkSuggestPayload(suggestion: LinkSuggestion): Record<string, unknown> {
  return {
    notePath: suggestion.notePath,
    baseContentHash: suggestion.baseContentHash,
    candidateNotes: suggestion.candidateNotes,
    candidates: suggestion.candidates,
    ...(suggestion.diagnostics.length === 0 ? {} : { diagnostics: suggestion.diagnostics }),
  };
}

/** JSON shape of a link check: per-link state plus the unresolved and ambiguous sets. */
export function linkCheckPayload(report: LinkCheckReport): Record<string, unknown> {
  return {
    notePath: report.notePath,
    links: report.links,
    unresolved: report.unresolved,
    ambiguous: report.ambiguous,
    ...(report.diagnostics.length === 0 ? {} : { diagnostics: report.diagnostics }),
  };
}
