import type { ApplyResult } from "../kernel/engine/linkify/apply.js";
import type { LinkCandidate } from "../kernel/engine/linkify/types.js";
import {
  applyLinksForNote as applyWorkflowLinksForNote,
  suggestLinksForNote as suggestWorkflowLinksForNote,
  type LinkScope,
  type LinkWorkflowTarget,
} from "../kernel/link/workflow.js";

/** A candidate as the MCP surface reports it: the core shape plus a stable id. */
export interface IdentifiedCandidate extends LinkCandidate {
  readonly id: string;
}

/** Payload of a successful `oms_link_suggest` call. */
export interface LinkSuggestion {
  readonly notePath: string;
  readonly baseContentHash: string;
  readonly candidateNotes: number;
  readonly candidates: readonly IdentifiedCandidate[];
}

/** Everything the MCP link operations need to address a vault note. */
export type LinkToolTarget = LinkWorkflowTarget;

/** Restrict the candidate universe to one top-level vault folder. */
export type { LinkScope };

/** Payload of an `oms_link_apply` call: the core result plus what was selected. */
export interface LinkApplyOutcome {
  readonly notePath: string;
  readonly requestedIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly result: ApplyResult;
}

/** Invoke the transport-neutral suggestion workflow and retain the MCP contract. */
export async function suggestLinksForNote(target: LinkToolTarget, scope: LinkScope = {}): Promise<LinkSuggestion> {
  return suggestWorkflowLinksForNote(target, scope);
}

/** Invoke the transport-neutral apply workflow and retain the MCP contract. */
export async function applyLinksForNote(
  target: LinkToolTarget,
  selection: { readonly baseContentHash: string; readonly candidateIds: readonly string[] },
  scope: LinkScope = {},
): Promise<LinkApplyOutcome> {
  return applyWorkflowLinksForNote(target, selection, scope);
}

/** The MCP-facing JSON shape of an apply outcome: applied body + receipt, or a typed refusal. */
export function linkApplyPayload(outcome: LinkApplyOutcome): Record<string, unknown> {
  const common = {
    notePath: outcome.notePath,
    requestedIds: outcome.requestedIds,
    resolvedIds: outcome.resolvedIds,
  };
  const result = outcome.result;
  return result.applied
    ? {
        ...common,
        applied: true,
        contentHash: result.contentHash,
        body: result.body,
        receipt: result.write.receipt ?? null,
      }
    : {
        ...common,
        applied: false,
        reason: result.reason,
        write: result.write ?? null,
      };
}
