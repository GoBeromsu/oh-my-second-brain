/**
 * Write Protocol: Admission & Acceptance contract with explicit rejection & receipt.
 *
 * Response Shape Contract:
 * - `written` results carry `receipt` (persisted, postcondition-verified) and no `rejection`.
 * - `rejected` results (and contract-fixable `ask` results) carry `rejection` and no `receipt`.
 * - `inbox` results carry NEITHER (inbox is a routing plan; nothing is persisted).
 * - `dryRun` results carry NO receipt (a receipt attests a persisted, postcondition-verified write).
 *
 * Rejection Model (gajae-code reference: error{code, message, recoverable} + remediation):
 * Each rejection carries a stage (admission or acceptance), code, message, and recoverable flag
 * derived exhaustively from a per-code table. This ensures adding a code without a recoverable
 * entry is a compile error.
 */

import type { VaultSource } from "../link/link.js";
import type { WriteMode } from "../capture/safe.js";

export type WriteStage = "admission" | "acceptance";

export type WriteTargetSource = VaultSource | "explicit";

export type WriteRejectionCode =
  | "target-unverified"
  | "target-invalid"
  | "path-unsafe"
  | "note-exists"
  | "note-missing"
  | "contract-violation"
  | "TEMPLATE_IDENTITY_IMMUTABLE"
  | "body-missing"
  | "args-invalid"
  | "postcondition-failed";

export interface WriteRejection {
  stage: WriteStage;
  code: WriteRejectionCode;
  message: string;
  recoverable: boolean;
  remediation: string;
}


/**
 * Exhaustive recovery table: maps each rejection code to its recoverable flag.
 * Adding a code without an entry is a compile error.
 */
const RECOVERABLE_BY_CODE: Record<WriteRejectionCode, boolean> = {
  "target-unverified": true,
  "contract-violation": true,
  "TEMPLATE_IDENTITY_IMMUTABLE": false,
  "body-missing": true,
  "args-invalid": true,
  "path-unsafe": true,
  "note-exists": false,
  "note-missing": false,
  "target-invalid": false,
  "postcondition-failed": false,
};

/**
 * Create a WriteRejection with stage, code, message, and remediation.
 * The recoverable flag is derived exhaustively from the per-code table.
 */
export function rejection(
  stage: WriteStage,
  code: WriteRejectionCode,
  message: string,
  remediation: string
): WriteRejection {
  return {
    stage,
    code,
    message,
    remediation,
    recoverable: RECOVERABLE_BY_CODE[code],
  };
}
