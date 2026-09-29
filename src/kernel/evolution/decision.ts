/**
 * The owner's answer to an evolution prompt. Only "approve" approves; everything else,
 * including no answer at all, is "reject". The prompt itself lives in the CLI.
 */
export type HumanDecision = "approve" | "reject";

/** Why a terminal session ended without approval; only "explicit" rejects the request for good. */
export type HumanRejectReason = "explicit" | "timeout" | "eof" | "non-tty" | "unknown-input" | "interrupted";

/** How the owner's terminal session for an evolution request ended. */
export type HumanSessionOutcome =
  | { readonly decision: "approve" }
  | { readonly decision: "reject"; readonly reason: HumanRejectReason };
