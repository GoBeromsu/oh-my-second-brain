/**
 * The owner's answer to an evolution prompt. Only "approve" approves; everything else,
 * including no answer at all, is "reject". The prompt itself lives in the CLI.
 */
export type HumanDecision = "approve" | "reject";
