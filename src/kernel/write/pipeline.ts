import path from "node:path";
import { admitWriteTarget } from "../capture/safe.js";
import { recordGaps, writeGapDraft, type GapLedgerDeps } from "../contract/gap-ledger.js";
import { judgeReadyTarget, resolveWriteTarget } from "../contract/judge-write.js";
import { storeRoot } from "../contract/store.js";
import type { Violation } from "../contract/types.js";
import { resolveSealState, type SealState } from "../contract/vault-id.js";
import type { Digest } from "../conventions/canonical.js";
import type { WriteRejection, WriteTargetSource } from "../conventions/write-protocol.js";
import { updateKeywordIndex, type KeywordUpdateOptions } from "../engine/index-update.js";
import { resolveAmbiguity, type GapFinding } from "./ambiguity.js";
import { conform } from "./conform.js";
import { frameFor, type WriteFrame } from "./frame.js";
import { atomicWriteNote, type NoteWriteDeps } from "./note-write.js";
import { buildReceipt, contractRevision, noteRevision, type ConformChange, type KeywordIndexState, type ReceiptGap, type WriteReceipt } from "./receipt.js";

/**
 * The one write path behind MCP `write` and CLI `oms write`:
 * frame -> conform -> judge -> ambiguity -> if-match -> atomic save -> gap ledger ->
 * keyword index -> vector queue. A refused write leaves the vault untouched; `check` stops
 * after the judge and writes nothing anywhere.
 *
 * The seal state is read once. The contract revision derived from it is the one the
 * judge, every recorded gap and the receipt name, so a seal landing mid-write cannot
 * split a write across two revisions.
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
  /** `draftRef` names the draft kept beside the gap ledger when the refused note was a gap in the frame. */
  | { readonly kind: "denied"; readonly violations: readonly Violation[]; readonly draftRef?: string }
  | { readonly kind: "if-match-required" }
  | { readonly kind: "retry"; readonly state: "changed" | "vanished" | "absent" }
  | { readonly kind: "checked"; readonly check: WriteCheck }
  | { readonly kind: "written"; readonly receipt: WriteReceipt };

export interface WritePipelineDeps {
  readonly noteWrite: Partial<NoteWriteDeps>;
  readonly updateIndex: (options: KeywordUpdateOptions) => Promise<KeywordIndexState>;
  readonly now: () => Date;
  readonly resolveSealState: (vault: string) => Promise<SealState>;
  /** Store root the gap ledger and drafts live under. */
  readonly gapRoot: () => string;
  readonly gapLedger: Partial<GapLedgerDeps>;
}

/** Where a sealed write's gaps go; null when the contract is not sealed or the vault has no id. */
interface LedgerTarget {
  readonly root: string;
  readonly vaultId: string;
}

const REVISION = /^sha256:[0-9a-f]{64}$/;

function titleOf(notePath: string): string {
  return path.posix.basename(notePath).replace(/\.md$/i, "");
}

function folderOf(notePath: string): string | undefined {
  const folder = path.posix.dirname(notePath);
  return folder === "." ? undefined : folder;
}

function gapInputs(findings: readonly GapFinding[], notePath: string, content: string, revision: Digest, draftRef?: string) {
  const revisionOfNote = noteRevision(content);
  return findings.map(finding => ({
    notePath,
    noteRevision: revisionOfNote,
    contractRevision: revision,
    ...finding,
    ...(draftRef === undefined ? {} : { draftRef }),
  }));
}

export async function runWritePipeline(request: WriteRequest, overrides: Partial<WritePipelineDeps> = {}): Promise<WriteOutcome> {
  const deps: WritePipelineDeps = {
    noteWrite: {},
    updateIndex: updateKeywordIndex,
    now: () => new Date(),
    resolveSealState: vault => resolveSealState(vault),
    gapRoot: storeRoot,
    gapLedger: {},
    ...overrides,
  };
  const { vault, source, template, ifMatch } = request;
  if (ifMatch !== undefined && !REVISION.test(ifMatch)) return { kind: "denied", violations: [{ field: "ifMatch", kind: "unsupported-input" }] };
  // Diagnosis is allowed on any target; only a write needs a verified one.
  if (request.check !== true) {
    const rejection = await admitWriteTarget({ vault, source });
    if (rejection !== undefined) return { kind: "rejected", rejection };
  }
  // The one seal-state read; the judge's view and the ledger's vault id both come from it.
  const read: { seal?: SealState } = {};
  const resolved = await resolveWriteTarget(vault, path.resolve(vault, request.path), {
    resolveSealState: async root => (read.seal = await deps.resolveSealState(root)),
  });
  if (resolved.state === "denied") return { kind: "denied", violations: resolved.verdict.violations };
  const revision = contractRevision(resolved.view);
  const vaultId = read.seal?.vaultId ?? null;
  const ledger: LedgerTarget | null = revision !== null && vaultId !== null ? { root: deps.gapRoot(), vaultId } : null;

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
        contractRevision: revision,
        violations: verdict.violations,
        missingDefaults: verdict.missingDefaults,
        conformed: conformed.applied,
        frame,
      },
    };
  }
  const resolution = resolveAmbiguity({
    view: resolved.view,
    path: resolved.path,
    content: conformed.content,
    template,
    previousContent: resolved.previousContent ?? undefined,
    verdict,
    rejudge: content => judgeReadyTarget(resolved, content, template),
  });
  if (resolution.action === "refuse") return { kind: "denied", violations: verdict.violations };
  if (resolution.action === "draft") {
    if (ledger === null || revision === null) return { kind: "denied", violations: verdict.violations };
    try {
      const draftRef = await writeGapDraft(ledger.root, ledger.vaultId, conformed.content, deps.gapLedger);
      await recordGaps(ledger.root, ledger.vaultId, gapInputs(resolution.findings, resolved.path, conformed.content, revision, draftRef), deps.gapLedger);
      return { kind: "denied", violations: verdict.violations, draftRef };
    } catch {
      // The judge refused the note either way; a ledger that cannot be written only loses the draft.
      return { kind: "denied", violations: verdict.violations };
    }
  }

  // An overwrite must name the revision it replaces; a new note must not expect one.
  if (resolved.previousContent !== undefined) {
    if (ifMatch === undefined) return { kind: "if-match-required" };
    if (resolved.previousContent === null || noteRevision(resolved.previousContent) !== ifMatch) return { kind: "retry", state: "changed" };
  } else if (ifMatch !== undefined) {
    // The caller expected to replace a note that is not there; retrying without ifMatch creates it.
    return { kind: "retry", state: "absent" };
  }

  const written = await atomicWriteNote(resolved.absolutePath, resolution.content, resolved.previousContent, deps.noteWrite);
  if (written !== "written") return { kind: "retry", state: written };
  let gaps: readonly ReceiptGap[] = [];
  let gapLedger: "failed" | undefined;
  if (ledger !== null && revision !== null && resolution.findings.length > 0) {
    try {
      const records = await recordGaps(ledger.root, ledger.vaultId, gapInputs(resolution.findings, resolved.path, resolution.content, revision), deps.gapLedger);
      gaps = records.map(record => ({ id: record.id, axis: record.axis, kind: record.kind, field: record.wanted.field }));
    } catch {
      // The note is saved; the receipt says its gaps were not recorded instead of failing the write.
      gapLedger = "failed";
    }
  }
  const keyword = await deps.updateIndex({ vault: path.resolve(vault), relPath: resolved.path });
  return {
    kind: "written",
    receipt: buildReceipt({
      path: resolved.path,
      content: resolution.content,
      view: resolved.view,
      contractRevision: revision,
      keyword,
      conformed: conformed.applied,
      missingDefaults: resolution.verdict.missingDefaults,
      gaps,
      ...(gapLedger === undefined ? {} : { gapLedger }),
    }),
  };
}
