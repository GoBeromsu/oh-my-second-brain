import path from "node:path";
import { admitWriteTarget } from "../capture/safe.js";
import { judgeReadyTarget, resolveWriteTarget } from "../contract/judge-write.js";
import { formatDenyReason, type Violation } from "../contract/types.js";
import type { WriteRejection, WriteTargetSource } from "../conventions/write-protocol.js";
import { atomicWriteNote, type NoteWriteDeps } from "./note-write.js";

export interface VerifiedWriteInput {
  readonly vault: string;
  readonly source: WriteTargetSource;
  /** Vault-relative note path, resolved against `vault`. */
  readonly path: string;
  readonly content: string;
  readonly template?: string | undefined;
}

export type VerifiedWriteResult =
  | { readonly kind: "rejected"; readonly rejection: WriteRejection }
  | { readonly kind: "denied"; readonly violations: readonly Violation[] }
  | { readonly kind: "retry"; readonly state: "changed" | "vanished" }
  | { readonly kind: "written"; readonly path: string; readonly missingDefaults: readonly string[] };

/**
 * The verified-target write: admission, target resolution, the one judge, then the
 * atomic save. Transport-neutral; a denied or rejected write leaves disk untouched.
 */
export async function verifiedWriteNote(input: VerifiedWriteInput, deps: Partial<NoteWriteDeps> = {}): Promise<VerifiedWriteResult> {
  const { vault, source, content, template } = input;
  const rejection = await admitWriteTarget({ vault, source });
  if (rejection !== undefined) return { kind: "rejected", rejection };
  const resolved = await resolveWriteTarget(vault, path.resolve(vault, input.path));
  if (resolved.state === "denied") return { kind: "denied", violations: resolved.verdict.violations };
  const verdict = judgeReadyTarget(resolved, content, template);
  if (!verdict.ok) return { kind: "denied", violations: verdict.violations };
  const written = await atomicWriteNote(resolved.absolutePath, content, resolved.previousContent, deps);
  if (written !== "written") return { kind: "retry", state: written };
  return { kind: "written", path: resolved.path, missingDefaults: verdict.missingDefaults };
}

/** The wire payload every write surface prints: MCP `write` and CLI `oms write` share it. */
export type VerifiedWritePayload =
  | { readonly ok: true; readonly path: string; readonly missingDefaults: readonly { readonly field: string }[] }
  | { readonly ok: false; readonly violations: readonly { readonly field: string; readonly kind: string }[]; readonly reason: string }
  | { readonly ok: false; readonly status: "rejected"; readonly rejection: WriteRejection }
  | { readonly ok: false; readonly code: "WRITE_TARGET_CHANGED" | "WRITE_TARGET_VANISHED"; readonly retryable: true; readonly reason: string };

/** Denied-write payload for input-shape violations found before the kernel runs. */
export function deniedWritePayload(violations: readonly Violation[]): VerifiedWritePayload {
  const list = violations.map(violation => ({ field: violation.field, kind: violation.kind }));
  return { ok: false, violations: list, reason: formatDenyReason(list) };
}

export function verifiedWritePayload(result: VerifiedWriteResult): VerifiedWritePayload {
  switch (result.kind) {
    case "rejected":
      return { ok: false, status: "rejected", rejection: result.rejection };
    case "denied":
      return deniedWritePayload(result.violations);
    case "retry":
      return result.state === "changed"
        ? { ok: false, code: "WRITE_TARGET_CHANGED", retryable: true, reason: "The note changed after it was judged; nothing was written. Read it again and retry." }
        : { ok: false, code: "WRITE_TARGET_VANISHED", retryable: true, reason: "The note was removed after it was judged; nothing was written. Retry the write." };
    case "written":
      return { ok: true, path: result.path, missingDefaults: result.missingDefaults.map(field => ({ field })) };
  }
}
