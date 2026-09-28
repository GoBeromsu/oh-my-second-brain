import { formatDenyReason, type Violation } from "../contract/types.js";
import type { WriteRejection } from "../conventions/write-protocol.js";
import type { WriteCheck, WriteOutcome } from "./pipeline.js";
import type { WriteReceipt } from "./receipt.js";

/** The wire payload every write surface prints: MCP `write` and CLI `oms write` share it. */
export type WritePayload =
  | WriteReceipt
  | ({ readonly status: "checked" } & Omit<WriteCheck, "violations" | "missingDefaults"> & {
    readonly violations: readonly { readonly field: string; readonly kind: string }[];
    readonly missingDefaults: readonly { readonly field: string }[];
  })
  | { readonly ok: false; readonly violations: readonly { readonly field: string; readonly kind: string }[]; readonly reason: string }
  | { readonly ok: false; readonly status: "rejected"; readonly rejection: WriteRejection }
  | { readonly ok: false; readonly code: "WRITE_IF_MATCH_REQUIRED"; readonly kind: "if-match-required"; readonly reason: string }
  | { readonly ok: false; readonly code: "WRITE_TARGET_CHANGED" | "WRITE_TARGET_VANISHED" | "WRITE_TARGET_ABSENT"; readonly retryable: true; readonly reason: string };

/** Denied-write payload for input-shape violations found before the kernel runs. */
export function deniedWritePayload(violations: readonly Violation[]): WritePayload {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  return { ok: false, violations: list, reason: formatDenyReason(list) };
}

export function writePayload(outcome: WriteOutcome): WritePayload {
  switch (outcome.kind) {
    case "rejected":
      return { ok: false, status: "rejected", rejection: outcome.rejection };
    case "denied":
      return deniedWritePayload(outcome.violations);
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
        violations: check.violations.map(violation => ({ field: violation.field, kind: violation.kind })),
        missingDefaults: check.missingDefaults.map(field => ({ field })),
      };
    }
    case "written":
      return outcome.receipt;
  }
}
