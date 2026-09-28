import type { GapAxis, GapKind } from "../contract/gap-ledger.js";
import { contractRevision } from "../contract/revision.js";
import type { ContractView } from "../contract/types.js";
import { digestBytes, type Digest } from "../conventions/canonical.js";

export { contractRevision };

/** One mechanical change `conform` made; never a value, only the field and what was done. */
export interface ConformChange {
  readonly field: string;
  readonly action: "variable" | "default" | "heading";
}

export type GapLedgerState = "failed" | "unavailable";
export type KeywordIndexState = "updated" | "failed" | "skipped";
export type VectorIndexState = "pending" | "disabled";

/** A gap this write met; the field, never the value. */
export interface ReceiptGap {
  /** The ledger id; absent when the gap could not be recorded (see `gapLedger`). */
  readonly id?: string;
  readonly axis: GapAxis;
  readonly kind: GapKind;
  readonly field: string;
}

export interface IndexState {
  readonly keyword: KeywordIndexState;
  readonly vector: VectorIndexState;
}

/**
 * What a successful write reports. `revision` is the digest of the bytes now on disk and
 * is the `ifMatch` for the next overwrite; `contractRevision` names the seal the write was
 * judged against, or null for an open or unreadable contract.
 */
export interface WriteReceipt {
  readonly ok: true;
  readonly path: string;
  readonly revision: Digest;
  readonly contractRevision: Digest | null;
  readonly index: IndexState;
  readonly conformed: readonly ConformChange[];
  readonly missingDefaults: readonly { readonly field: string }[];
  /** Gaps this write met; absent when there were none. */
  readonly gaps?: readonly ReceiptGap[];
  /**
   * Present when the note was saved but its gaps were not recorded: `failed` when the
   * ledger could not be written, `unavailable` when the vault has no ledger (no vault id).
   * `gaps` still lists them, without ids.
   */
  readonly gapLedger?: GapLedgerState;
}

export function noteRevision(content: string): Digest {
  return digestBytes(content);
}

export interface ReceiptInput {
  readonly path: string;
  readonly content: string;
  readonly view: ContractView;
  readonly keyword: KeywordIndexState;
  readonly conformed: readonly ConformChange[];
  readonly missingDefaults: readonly string[];
  /** The revision read once for the whole write; when given it wins over one derived from `view`. */
  readonly contractRevision?: Digest | null;
  readonly gaps?: readonly ReceiptGap[];
  readonly gapLedger?: GapLedgerState;
}

/** The vector index only has work queued when the keyword update reached the store. */
export function buildReceipt(input: ReceiptInput): WriteReceipt {
  return {
    ok: true,
    path: input.path,
    revision: noteRevision(input.content),
    contractRevision: input.contractRevision !== undefined ? input.contractRevision : contractRevision(input.view),
    index: { keyword: input.keyword, vector: input.keyword === "updated" ? "pending" : "disabled" },
    conformed: input.conformed,
    missingDefaults: input.missingDefaults.map(field => ({ field })),
    ...(input.gaps === undefined || input.gaps.length === 0 ? {} : { gaps: input.gaps }),
    ...(input.gapLedger === undefined ? {} : { gapLedger: input.gapLedger }),
  };
}
