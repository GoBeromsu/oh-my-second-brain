import { formatDenyReason, type Violation } from "../contract/types.js";
import type { WriteRejection } from "../conventions/write-protocol.js";
import type { WriteCheck, WriteOutcome } from "./pipeline.js";
import type { WriteReceipt } from "./receipt.js";

/** The wire payload every write surface prints: MCP `write` and CLI `oms write` share it. */
export type WritePayload =
  | WriteReceipt
  | ({ readonly status: "checked" } & Omit<WriteCheck, "refusals" | "warnings" | "fixes" | "violations" | "missingDefaults"> & {
    readonly refusals: readonly FieldKind[];
    readonly warnings: readonly FieldKind[];
    readonly fixes: readonly FieldKind[];
    /** @deprecated The same list as `refusals`. */
    readonly violations: readonly FieldKind[];
    readonly missingDefaults: readonly { readonly field: string }[];
  })
  | {
    readonly ok: false;
    readonly status: "denied";
    readonly refusals: readonly FieldKind[];
    /** @deprecated The same list as `refusals`. */
    readonly violations: readonly FieldKind[];
    readonly reason: string;
  }
  /** Nothing was saved in the vault; the note is kept as a draft beside the gap ledger. */
  | { readonly ok: false; readonly status: "drafted"; readonly draftRef: string; readonly warnings: readonly FieldKind[] }
  | { readonly ok: false; readonly status: "rejected"; readonly rejection: WriteRejection }
  | { readonly ok: false; readonly code: "WRITE_IF_MATCH_REQUIRED"; readonly kind: "if-match-required"; readonly reason: string }
  | { readonly ok: false; readonly code: "WRITE_TARGET_CHANGED" | "WRITE_TARGET_VANISHED" | "WRITE_TARGET_ABSENT"; readonly retryable: true; readonly reason: string };

interface FieldKind { readonly field: string; readonly kind: string }

type DeniedPayload = Extract<WritePayload, { readonly status: "denied" }>;

function fieldKinds(findings: readonly Violation[]): readonly FieldKind[] {
  return findings.map(finding => ({ field: finding.field, kind: finding.kind }));
}

function denied(refusals: readonly Violation[]): DeniedPayload {
  const list = fieldKinds(refusals);
  return { ok: false, status: "denied", refusals: list, violations: list, reason: formatDenyReason(refusals) };
}

/** Denied-write payload for input-shape violations found before the kernel runs. */
export function deniedWritePayload(violations: readonly Violation[]): WritePayload {
  return denied(violations);
}

export function writePayload(outcome: WriteOutcome): WritePayload {
  switch (outcome.kind) {
    case "rejected":
      return { ok: false, status: "rejected", rejection: outcome.rejection };
    case "denied":
      return denied(outcome.refusals);
    case "drafted":
      // The draft name is an opaque ledger ref; the note's content never leaves the store.
      return { ok: false, status: "drafted", draftRef: outcome.draftRef, warnings: fieldKinds(outcome.warnings) };
    case "if-match-required":
      return {
        ok: false,
        code: "WRITE_IF_MATCH_REQUIRED",
        kind: "if-match-required",
        reason: "The note already exists; nothing was written. Pass ifMatch with its current revision (write with check reports it) to overwrite it.",
      };
    case "retry":
      if (outcome.state === "changed") return { ok: false, code: "WRITE_TARGET_CHANGED", retryable: true, reason: "The note changed after it was judged; nothing was written. Read it again and retry." };
      if (outcome.state === "absent") return { ok: false, code: "WRITE_TARGET_ABSENT", retryable: true, reason: "ifMatch names a revision, but the note does not exist; nothing was written. Retry without ifMatch to create it." };
      return { ok: false, code: "WRITE_TARGET_VANISHED", retryable: true, reason: "The note was removed after it was judged; nothing was written. Retry the write." };
    case "checked": {
      const { check } = outcome;
      return {
        status: "checked",
        ...check,
        refusals: fieldKinds(check.refusals),
        warnings: fieldKinds(check.warnings),
        fixes: fieldKinds(check.fixes),
        violations: fieldKinds(check.refusals),
        missingDefaults: check.missingDefaults.map(field => ({ field })),
      };
    }
    case "written":
      return outcome.receipt;
  }
}
