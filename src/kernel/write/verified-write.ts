import path from "node:path";
import { admitWriteTarget } from "../capture/safe.js";
import { judgeReadyTarget, resolveWriteTarget } from "../contract/judge-write.js";
import type { Violation } from "../contract/types.js";
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
