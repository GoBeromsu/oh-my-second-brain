/**
 * Link application: splice accepted candidates into a note body and persist
 * through the capture kernel.
 *
 * This is the only linkify module with a side effect, and even here the effect
 * is injected — `writeNote` arrives as a parameter, `node:fs` is never imported,
 * and the capture kernel is referenced by TYPE only. mask.ts and suggest.ts stay
 * pure; every disk decision (path safety, concept contract, postcondition
 * re-read) remains the kernel's, unduplicated here.
 *
 * Optimistic concurrency: candidates carry absolute offsets into the body they
 * were computed from. If that body changed, the offsets are lies. `applyLinks`
 * therefore re-hashes the body it is handed and refuses to write on any
 * mismatch, on any candidate whose recorded text no longer sits at its offsets,
 * and on any overlapping pair — three independent ways the same corruption
 * could otherwise reach disk.
 */

import { createHash } from "node:crypto";
import type { WriteNoteInput, WriteNoteResult } from "../../capture/safe.js";
import type { LinkCandidate } from "./types.js";

/** The capture-kernel seam apply persists through (structurally `writeNote`). */
export type WriteNoteLike = (input: WriteNoteInput) => Promise<WriteNoteResult>;

/** Everything the kernel needs to address the note, minus the body apply supplies. */
export type LinkifyWriteTarget = Omit<WriteNoteInput, "mode" | "dryRun" | "body" | "frontmatter">;

/** Why an apply attempt produced no write. */
export type ApplyRefusal =
  | "note-changed"
  | "no-candidates"
  | "candidate-drift"
  | "overlapping-candidates"
  | "write-rejected";

/** Outcome of {@link applyLinks}: a written body, or a typed refusal. */
export type ApplyResult =
  | { readonly applied: true; readonly body: string; readonly contentHash: string; readonly write: WriteNoteResult }
  | { readonly applied: false; readonly reason: ApplyRefusal; readonly write?: WriteNoteResult };

/** Inputs for {@link applyLinks}, grouped so the call site stays readable. */
export interface ApplyLinksInput {
  /** The note body the candidates were computed against. */
  readonly body: string;
  /** sha256 hex of that body, taken when the candidates were produced. */
  readonly baseContentHash: string;
  /** The candidates the caller (or user) accepted. */
  readonly accepted: readonly LinkCandidate[];
  readonly writeNote: WriteNoteLike;
  readonly target: LinkifyWriteTarget;
}

/** sha256 hex digest of a note body — the optimistic-concurrency token. */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

/** True when any two candidates claim overlapping body ranges. */
function hasOverlap(sorted: readonly LinkCandidate[]): boolean {
  return sorted.some((candidate, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && candidate.startOffset < previous.endOffset;
  });
}

/** True when every candidate's recorded text still sits at its offsets. */
function offsetsIntact(body: string, candidates: readonly LinkCandidate[]): boolean {
  return candidates.every(
    (candidate) => body.slice(candidate.startOffset, candidate.endOffset) === candidate.matchedText,
  );
}

/** Splice replacements right-to-left so untouched offsets stay valid. */
function splice(body: string, sorted: readonly LinkCandidate[]): string {
  return sorted.reduceRight(
    (acc, candidate) =>
      acc.slice(0, candidate.startOffset) + candidate.renderedReplacement + acc.slice(candidate.endOffset),
    body,
  );
}

/**
 * Apply accepted link candidates to a note body and persist the result.
 *
 * Returns `{ applied: false, reason }` — with no write attempted — whenever the
 * body has drifted from the snapshot the candidates were computed against.
 */
export async function applyLinks(input: ApplyLinksInput): Promise<ApplyResult> {
  if (hashBody(input.body) !== input.baseContentHash) {
    return { applied: false, reason: "note-changed" };
  }
  if (input.accepted.length < 1) {
    return { applied: false, reason: "no-candidates" };
  }

  const sorted = input.accepted.slice().sort((a, b) => a.startOffset - b.startOffset);
  if (hasOverlap(sorted)) {
    return { applied: false, reason: "overlapping-candidates" };
  }
  if (!offsetsIntact(input.body, sorted)) {
    return { applied: false, reason: "candidate-drift" };
  }

  const body = splice(input.body, sorted);
  const write = await input.writeNote({ ...input.target, mode: "update", dryRun: false, body });
  if (write.status !== "written") {
    return { applied: false, reason: "write-rejected", write };
  }

  return { applied: true, body, contentHash: hashBody(body), write };
}
