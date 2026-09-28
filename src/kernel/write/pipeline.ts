import path from "node:path";
import { admitWriteTarget } from "../capture/safe.js";
import { judgeReadyTarget, resolveWriteTarget } from "../contract/judge-write.js";
import type { Violation } from "../contract/types.js";
import type { Digest } from "../conventions/canonical.js";
import type { WriteRejection, WriteTargetSource } from "../conventions/write-protocol.js";
import { updateKeywordIndex, type KeywordUpdateOptions } from "../engine/index-update.js";
import { conform } from "./conform.js";
import { frameFor, type WriteFrame } from "./frame.js";
import { atomicWriteNote, type NoteWriteDeps } from "./note-write.js";
import { buildReceipt, contractRevision, noteRevision, type ConformChange, type KeywordIndexState, type WriteReceipt } from "./receipt.js";

/**
 * The one write path behind MCP `write` and CLI `oms write`:
 * frame -> conform -> judge -> if-match -> atomic save -> keyword index -> vector queue.
 * A refused write leaves disk untouched; `check` stops after the judge and writes nothing.
 */

export interface WriteRequest {
  readonly vault: string;
  readonly source: WriteTargetSource;
  /** Vault-relative note path, resolved against `vault`. */
  readonly path: string;
  readonly content: string;
  readonly template?: string | undefined;
  /** Revision of the note being overwritten, as a previous receipt reported it. */
  readonly ifMatch?: string | undefined;
  /** Judge only: resolve, conform and judge, then return without writing. */
  readonly check?: boolean | undefined;
}

export interface WriteCheck {
  readonly ok: boolean;
  readonly path: string;
  /** Revision of the note on disk now, or null for a new or unreadable note. */
  readonly revision: Digest | null;
  readonly contractRevision: Digest | null;
  readonly violations: readonly Violation[];
  readonly missingDefaults: readonly string[];
  readonly conformed: readonly ConformChange[];
  readonly frame: WriteFrame;
}

export type WriteOutcome =
  | { readonly kind: "rejected"; readonly rejection: WriteRejection }
  | { readonly kind: "denied"; readonly violations: readonly Violation[] }
  | { readonly kind: "if-match-required" }
  | { readonly kind: "retry"; readonly state: "changed" | "vanished" }
  | { readonly kind: "checked"; readonly check: WriteCheck }
  | { readonly kind: "written"; readonly receipt: WriteReceipt };

export interface WritePipelineDeps {
  readonly noteWrite: Partial<NoteWriteDeps>;
  readonly updateIndex: (options: KeywordUpdateOptions) => Promise<KeywordIndexState>;
  readonly now: () => Date;
}

const REVISION = /^sha256:[0-9a-f]{64}$/;

function titleOf(notePath: string): string {
  return path.posix.basename(notePath).replace(/\.md$/i, "");
}

function folderOf(notePath: string): string | undefined {
  const folder = path.posix.dirname(notePath);
  return folder === "." ? undefined : folder;
}

export async function runWritePipeline(request: WriteRequest, overrides: Partial<WritePipelineDeps> = {}): Promise<WriteOutcome> {
  const deps: WritePipelineDeps = { noteWrite: {}, updateIndex: updateKeywordIndex, now: () => new Date(), ...overrides };
  const { vault, source, template, ifMatch } = request;
  if (ifMatch !== undefined && !REVISION.test(ifMatch)) return { kind: "denied", violations: [{ field: "ifMatch", kind: "unsupported-input" }] };
  // Diagnosis is allowed on any target; only a write needs a verified one.
  if (request.check !== true) {
    const rejection = await admitWriteTarget({ vault, source });
    if (rejection !== undefined) return { kind: "rejected", rejection };
  }
  const resolved = await resolveWriteTarget(vault, path.resolve(vault, request.path));
  if (resolved.state === "denied") return { kind: "denied", violations: resolved.verdict.violations };

  const frame = frameFor(resolved.view, { folder: folderOf(resolved.path), template });
  const conformed = conform(request.content, {
    view: resolved.view,
    template,
    isNew: resolved.previousContent === undefined,
    title: titleOf(resolved.path),
    now: deps.now(),
  });
  const verdict = judgeReadyTarget(resolved, conformed.content, template);

  if (request.check === true) {
    return {
      kind: "checked",
      check: {
        ok: verdict.ok,
        path: resolved.path,
        revision: typeof resolved.previousContent === "string" ? noteRevision(resolved.previousContent) : null,
        contractRevision: contractRevision(resolved.view),
        violations: verdict.violations,
        missingDefaults: verdict.missingDefaults,
        conformed: conformed.applied,
        frame,
      },
    };
  }
  if (!verdict.ok) return { kind: "denied", violations: verdict.violations };

  // An overwrite must name the revision it replaces; a new note must not expect one.
  if (resolved.previousContent !== undefined) {
    if (ifMatch === undefined) return { kind: "if-match-required" };
    if (resolved.previousContent === null || noteRevision(resolved.previousContent) !== ifMatch) return { kind: "retry", state: "changed" };
  } else if (ifMatch !== undefined) {
    return { kind: "retry", state: "vanished" };
  }

  const written = await atomicWriteNote(resolved.absolutePath, conformed.content, resolved.previousContent, deps.noteWrite);
  if (written !== "written") return { kind: "retry", state: written };
  const keyword = await deps.updateIndex({ vault: path.resolve(vault), relPath: resolved.path });
  return {
    kind: "written",
    receipt: buildReceipt({
      path: resolved.path,
      content: conformed.content,
      view: resolved.view,
      keyword,
      conformed: conformed.applied,
      missingDefaults: verdict.missingDefaults,
    }),
  };
}
