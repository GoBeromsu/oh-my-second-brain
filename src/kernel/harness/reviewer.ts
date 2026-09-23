import {
  CompletionContractError,
  computeSemanticResultDigest,
  validateSemanticReview,
  type CompletionDigest,
  type CriterionResult,
  type ReviewExecutionClaim,
  type SemanticReview,
} from "../conventions/completion-contract.js";
import { harnessSurfaceRegistry, type HarnessReviewerMechanism } from "./surface-registry.js";

/** Metadata for an actual host invocation. This is a claim, not authentication. */
export type HostReviewInvocation = Omit<ReviewExecutionClaim,
  "requestDigest" | "resultDigest" | "definitionDigestVerifiedByOms" | "independenceVerifiedByOms"> & {
  readonly schemaValid?: boolean;
};

/** The reviewer returns decisions, not invented host IDs or cryptographic hashes. */
export interface HostReviewResult {
  readonly requestDigest: CompletionDigest;
  readonly criteria: readonly CriterionResult[];
}

export function reviewerMechanism(runtime: string, mechanism: string): HarnessReviewerMechanism {
  const registered = harnessSurfaceRegistry.hosts
    .find(host => host.runtime === runtime)?.reviewerMechanisms
    .find(candidate => candidate.id === mechanism);
  if (registered === undefined) {
    throw new CompletionContractError("REVIEWER_UNAVAILABLE", `Unregistered reviewer mechanism ${runtime}/${mechanism}`);
  }
  return registered;
}

/**
 * Pure host adapter shared by CLI/MCP. No host execution, file access, or inference
 * of effective permissions. The last argument must come from OMS's separate
 * installed-definition inspection, never a field in a submitted host envelope.
 */
export function normalizeHostReview(
  requestDigest: CompletionDigest,
  invocation: HostReviewInvocation,
  result: HostReviewResult | null,
  definitionDigestVerifiedByOms = false,
): SemanticReview {
  const mechanism = reviewerMechanism(invocation.runtime, invocation.mechanism);
  if (invocation.schemaValid === false) {
    throw new CompletionContractError("REVIEW_SCHEMA_INVALID", "Host reported an invalid reviewer result schema");
  }
  if (invocation.claimSource === "oms-derived" || invocation.enforcementEvidenceSource === "oms-derived") {
    throw new CompletionContractError("REVIEW_SCHEMA_INVALID", "A host invocation is not an OMS-observed execution or enforcement event");
  }
  if (invocation.claimSource === "agent-transcribed" && invocation.enforcementEvidenceSource === "host") {
    throw new CompletionContractError("REVIEW_SCHEMA_INVALID", "Transcribed host evidence must remain labeled agent-transcribed");
  }
  if (definitionDigestVerifiedByOms && mechanism.assetPath === undefined) {
    throw new CompletionContractError("REVIEW_SCHEMA_INVALID", "This native reviewer mechanism has no shipped definition to verify");
  }
  const completed = invocation.status === "completed";
  if (completed !== (result !== null)) {
    throw new CompletionContractError("REVIEW_SCHEMA_INVALID", "Only a completed invocation carries a structured reviewer result");
  }
  if (result !== null && result.requestDigest !== requestDigest) {
    throw new CompletionContractError("SNAPSHOT_STALE", "Reviewer result belongs to a different request");
  }
  const criteria = result?.criteria ?? [];
  let resultDigest: CompletionDigest | null = null;
  if (completed) {
    try {
      resultDigest = computeSemanticResultDigest({ requestDigest, criteria });
    } catch (error) {
      throw new CompletionContractError("REVIEW_SCHEMA_INVALID", `Invalid criterion results: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return validateSemanticReview({
    requestDigest,
    status: invocation.status,
    criteria,
    resultDigest,
    claim: {
      ...invocation,
      requestDigest,
      resultDigest,
      independenceVerifiedByOms: false,
      definitionDigestVerifiedByOms,
    },
  });
}
