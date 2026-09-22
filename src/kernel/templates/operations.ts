import type { WriteTargetSource } from "../conventions/write-protocol.js";

/**
 * Addressing for contract operations.
 *
 * Version 4 has no template semantic-change writer: add, update, move, remove,
 * and default are not operations. A contract changes only through the interview,
 * which publishes the user-approved diff with `executeTemplateTransaction`.
 */
export interface TemplateOperationTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
}
