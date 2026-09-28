import { digestBytes, type Digest } from "../conventions/canonical.js";
import type { ContractView } from "../contract/types.js";

/** One mechanical change `conform` made; never a value, only the field and what was done. */
export interface ConformChange {
  readonly field: string;
  readonly action: "variable" | "default" | "heading";
}

export type KeywordIndexState = "updated" | "failed" | "skipped";
export type VectorIndexState = "pending" | "disabled";

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
}

export function noteRevision(content: string): Digest {
  return digestBytes(content);
}

/** Digest of the sealed contract as read from the store. */
export function contractRevision(view: ContractView): Digest | null {
  return view.state === "sealed" ? digestBytes(JSON.stringify(view.contract)) : null;
}

export interface ReceiptInput {
  readonly path: string;
  readonly content: string;
  readonly view: ContractView;
  readonly keyword: KeywordIndexState;
  readonly conformed: readonly ConformChange[];
  readonly missingDefaults: readonly string[];
}

/** The vector index only has work queued when the keyword update reached the store. */
export function buildReceipt(input: ReceiptInput): WriteReceipt {
  return {
    ok: true,
    path: input.path,
    revision: noteRevision(input.content),
    contractRevision: contractRevision(input.view),
    index: { keyword: input.keyword, vector: input.keyword === "updated" ? "pending" : "disabled" },
    conformed: input.conformed,
    missingDefaults: input.missingDefaults.map(field => ({ field })),
  };
}
