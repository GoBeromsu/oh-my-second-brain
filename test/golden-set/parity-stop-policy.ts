/**
 * Stop policy for a parity run.
 *
 * `parity-gate.ts` decides whether a run met its frozen bounds, but a verdict
 * nobody acts on changes nothing: `mayClaimReplacement` had no consumer anywhere
 * in the tree. This module turns a verdict into the three decisions the approved
 * plan actually gates on — may B2 work start, may a release ship, may OMS be
 * described as a qmd replacement — and preserves the evidence that produced them.
 *
 * The asymmetry is deliberate. A miss denies all three at once, and it records the
 * raw evidence rather than discarding it, because a disappointing run is exactly
 * when there is pressure to re-run quietly and keep only the better number. The
 * required follow-up is a separately reviewed correction plan, never a threshold
 * adjustment: the bounds were frozen before the run precisely so they could not be
 * moved after it.
 */

import type { ParityGateVerdict } from "./parity-gate.js";
import type { ParityProfile } from "./parity-preregistration.js";

/** Inputs that identify which frozen evidence a verdict was computed over. */
export interface ParityEvidenceRefs {
  readonly corpusDigest: string;
  readonly queriesSha256: string;
  readonly qrelsSha256: string;
  readonly rawResultsDigest: string;
  readonly baselineCommit: string;
}

export interface ParityOutcome {
  readonly profile: ParityProfile;
  readonly passed: boolean;
  /** B2 implementation may begin only after the B1 gate passes. */
  readonly mayStartB2: boolean;
  /** The release this profile gates may ship. */
  readonly mayRelease: boolean;
  /** OMS may be described as a qmd replacement. */
  readonly mayClaimReplacement: boolean;
  /** Preserved verbatim, on failure as well as success. */
  readonly evidence: ParityEvidenceRefs;
  readonly failures: readonly string[];
  /** Present only on a miss; names the required next step. */
  readonly requiredFollowUp?: string;
}

const CORRECTION_PLAN_FOLLOW_UP =
  "Stop and report. Preserve the raw evidence above, do not loosen any frozen threshold, " +
  "qrels file, or retrieval setting, and open a separately reviewed retrieval-correction plan. " +
  "The 4096 sqlite-vec knn clamp may be identified as a cause but is not changed under this plan.";

/**
 * Derive the gated decisions from a verdict.
 *
 * Which release a pass unlocks depends on the profile: B1 is the pre-B2
 * foundation gate, B2 is the 0.10 parity gate. A replacement claim requires the
 * full B2 profile, since passing lexical and vector alone says nothing about the
 * generated strategies qmd enables by default.
 */
export function decideStopPolicy(
  profile: ParityProfile,
  verdict: ParityGateVerdict,
  evidence: ParityEvidenceRefs,
): ParityOutcome {
  const passed = verdict.passed;
  return {
    profile,
    passed,
    mayStartB2: passed && profile === "b1-foundation",
    mayRelease: passed,
    // Never inferred from operability or from a partial profile.
    mayClaimReplacement: passed && verdict.mayClaimReplacement && profile === "b2-parity",
    evidence,
    failures: verdict.failures,
    ...(passed ? {} : { requiredFollowUp: CORRECTION_PLAN_FOLLOW_UP }),
  };
}

/**
 * Serialize an outcome deterministically so the record is auditable and diffable.
 *
 * Key order is fixed rather than left to object insertion order, and failures are
 * kept in the order the gate reported them.
 */
export function serializeOutcome(outcome: ParityOutcome): string {
  return `${JSON.stringify(
    {
      schema: "oms.parity-outcome.v1",
      profile: outcome.profile,
      passed: outcome.passed,
      mayStartB2: outcome.mayStartB2,
      mayRelease: outcome.mayRelease,
      mayClaimReplacement: outcome.mayClaimReplacement,
      evidence: {
        baselineCommit: outcome.evidence.baselineCommit,
        corpusDigest: outcome.evidence.corpusDigest,
        queriesSha256: outcome.evidence.queriesSha256,
        qrelsSha256: outcome.evidence.qrelsSha256,
        rawResultsDigest: outcome.evidence.rawResultsDigest,
      },
      failures: outcome.failures,
      ...(outcome.requiredFollowUp === undefined
        ? {}
        : { requiredFollowUp: outcome.requiredFollowUp }),
    },
    null,
    2,
  )}\n`;
}

/**
 * Assert a release is permitted, throwing with the failure list when it is not.
 *
 * This is the enforcement point a release step would call. It is deliberately a
 * function rather than a wired-in `release:check` stage: a parity manifest cannot
 * currently be produced at all (the pinned comparator is not installed and the
 * curated labels are the vault owner's to author), so making every build demand
 * one would fail CI for a reason no contributor could fix. The gate is available
 * and enforced the moment a run exists, without holding unrelated work hostage.
 */
export function assertReleasePermitted(outcome: ParityOutcome): void {
  if (outcome.mayRelease) return;
  throw new Error(
    `parity gate failed for the ${outcome.profile} profile; release is blocked.\n` +
      outcome.failures.map((failure) => `  - ${failure}`).join("\n") +
      `\n${outcome.requiredFollowUp ?? ""}`,
  );
}

/** Assert a replacement claim is permitted. Passing B1 alone never permits it. */
export function assertReplacementClaimPermitted(outcome: ParityOutcome): void {
  if (outcome.mayClaimReplacement) return;
  throw new Error(
    outcome.passed
      ? `the ${outcome.profile} profile passed, but a qmd-replacement claim requires the full ` +
        "b2-parity profile; lexical and vector parity alone does not establish it."
      : `parity gate failed for the ${outcome.profile} profile; a qmd-replacement claim is blocked.`,
  );
}
